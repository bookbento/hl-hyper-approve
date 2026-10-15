import { Test, TestingModule } from '@nestjs/testing';
import { MemoSearchNestService } from './memo-search.service';
import { PrismaService } from '../../prisma/prisma.service';

// $queryRaw is a tagged template: route each call by a keyword in its SQL.
type RawRoute = { match: string; rows: unknown[] };
let rawRoutes: RawRoute[] = [];

function sqlOf(strings: TemplateStringsArray): string {
  return strings.join('?');
}

const mockPrisma = {
  $queryRaw: jest.fn((strings: TemplateStringsArray, ..._values: unknown[]) => {
    const sql = sqlOf(strings);
    const route = rawRoutes.find((r) => sql.includes(r.match));
    return Promise.resolve(route ? route.rows : []);
  }),
  masterMemo: { findMany: jest.fn(), count: jest.fn() },
  memoApproverAction: { groupBy: jest.fn(), findMany: jest.fn() },
  comment: { findMany: jest.fn() },
  memoHistory: { findMany: jest.fn() },
  user: { findMany: jest.fn() },
  businessUnit: { findMany: jest.fn() },
  department: { findMany: jest.fn() },
};

// SQL fingerprints (unique substrings of each raw query)
const HIDDEN = `"statusName" = 'Deleted'`;
const BY_STATUS = `WHERE "statusName" = ANY(`;
const CURRENT_APPROVER = `AND "userId" = ANY(`;
const LATEST_ACTION = 'latest_main AS';
const STATUS_COUNTS = `COUNT(*)::int AS count`;

function memo(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    userId: 1,
    subject: `Memo ${id}`,
    memonumber: `M-${id}`,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    expiresAt: null,
    user: { id: 1, name: 'Owner', lastname: null, nickname: null, department: null },
    department: null,
    businessUnit: null,
    memoType: { name: 'General' },
    statuses: [{ createdAt: new Date('2026-01-02T00:00:00.000Z'), status: { name: 'Processing' } }],
    ccRecipients: [],
    extraApprovalLines: [],
    commentTags: [],
    ...over,
  };
}

function whereOf(callIndex = 0) {
  return mockPrisma.masterMemo.count.mock.calls[callIndex]?.[0]?.where;
}

describe('MemoSearchNestService', () => {
  let service: MemoSearchNestService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MemoSearchNestService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    service = module.get(MemoSearchNestService);
    jest.clearAllMocks();
    rawRoutes = [];

    mockPrisma.masterMemo.findMany.mockResolvedValue([]);
    mockPrisma.masterMemo.count.mockResolvedValue(0);
    mockPrisma.memoApproverAction.groupBy.mockResolvedValue([]);
    mockPrisma.memoApproverAction.findMany.mockResolvedValue([]);
    mockPrisma.comment.findMany.mockResolvedValue([]);
    mockPrisma.memoHistory.findMany.mockResolvedValue([]);
    mockPrisma.user.findMany.mockResolvedValue([]);
  });

  describe('searchMemos', () => {
    it('clamps pageSize to 100 and computes skip from page', async () => {
      mockPrisma.masterMemo.count.mockResolvedValue(250);

      const res = await service.searchMemos(
        { page: 3, pageSize: 500, includeStatCounts: false },
        1,
        'http://h',
      );

      const findArgs = mockPrisma.masterMemo.findMany.mock.calls[0][0];
      expect(findArgs.take).toBe(100);
      expect(findArgs.skip).toBe(200);
      expect(res).toMatchObject({ page: 3, pageSize: 100, total: 250, totalPages: 3 });
    });

    it('returns everything on one page for pageSize "all"', async () => {
      const res = await service.searchMemos(
        { pageSize: 'all', includeStatCounts: false },
        1,
        'http://h',
      );

      expect(mockPrisma.masterMemo.findMany.mock.calls[0][0].take).toBeUndefined();
      expect(res).toMatchObject({ pageSize: 'all', totalPages: 1 });
    });

    it('excludes hidden memos and restricts MY_CREATED to the owner', async () => {
      rawRoutes = [{ match: HIDDEN, rows: [{ memoId: 9 }] }];

      await service.searchMemos({ view: 'MY_CREATED', includeStatCounts: false }, 5, 'http://h');

      const and = whereOf().AND;
      expect(and).toContainEqual({ id: { notIn: [9] } });
      expect(and).toContainEqual({ userId: 5 });
    });

    it('matches nothing when a status filter has no hits', async () => {
      await service.searchMemos({ statuses: ['Approved'], includeStatCounts: false }, 1, 'http://h');
      expect(whereOf().AND).toContainEqual({ id: -1 });
    });

    it('filters by memo ids whose latest status matches', async () => {
      rawRoutes = [{ match: BY_STATUS, rows: [{ memoId: 3 }, { memoId: 4 }] }];
      await service.searchMemos({ status: 'Approved', includeStatCounts: false }, 1, 'http://h');
      expect(whereOf().AND).toContainEqual({ id: { in: [3, 4] } });
    });

    it('matches nothing when approver names resolve to no users', async () => {
      await service.searchMemos(
        { currentApproverNames: ['nobody'], includeStatCounts: false },
        1,
        'http://h',
      );
      expect(mockPrisma.user.findMany).toHaveBeenCalled();
      expect(whereOf().AND).toContainEqual({ id: -1 });
    });

    it('filters by current approver ids via the waiting-level resolver', async () => {
      rawRoutes = [{ match: CURRENT_APPROVER, rows: [{ memoId: 8 }] }];
      await service.searchMemos(
        { currentApproverIds: [2, -1, 1.5], includeStatCounts: false },
        1,
        'http://h',
      );

      const call = mockPrisma.$queryRaw.mock.calls.find((c) => sqlOf(c[0]).includes(CURRENT_APPROVER));
      expect(call?.[1]).toEqual([2]); // invalid ids dropped
      expect(whereOf().AND).toContainEqual({ id: { in: [8] } });
    });

    it('MY_APPROVAL keeps only awaiting memos that are Processing', async () => {
      rawRoutes = [
        { match: CURRENT_APPROVER, rows: [{ memoId: 1 }, { memoId: 2 }] },
        { match: BY_STATUS, rows: [{ memoId: 2 }, { memoId: 3 }] },
      ];
      await service.searchMemos({ view: 'MY_APPROVAL', includeStatCounts: false }, 1, 'http://h');
      expect(whereOf().AND).toContainEqual({ id: { in: [2] } });
    });

    it('sorts by latest action in SQL and keeps that order', async () => {
      mockPrisma.masterMemo.findMany
        .mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]) // candidates
        .mockResolvedValueOnce([memo(1), memo(3)]); // page rows, DB order
      rawRoutes = [{ match: LATEST_ACTION, rows: [{ memoId: 3 }, { memoId: 1 }] }];

      const res = await service.searchMemos(
        { sortBy: 'latestAction', pageSize: 2, includeStatCounts: false },
        1,
        'http://h',
      );

      expect(res.total).toBe(3);
      expect(res.items.map((i) => i.id)).toEqual([3, 1]);
      expect(mockPrisma.masterMemo.count).not.toHaveBeenCalled();
    });

    it('formats rows with approver snapshot, current approver and comment link', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([memo(1)]);
      mockPrisma.masterMemo.count.mockResolvedValue(1);
      mockPrisma.memoApproverAction.groupBy.mockResolvedValue([{ memoId: 1, _max: { version: 2 } }]);
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([
        {
          memoId: 1,
          loaUserId: 11,
          actedAt: null,
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
          status: { code: 'waiting' },
          loaUser: {
            level: 1,
            userId: 5,
            approvalRequirement: 'ALL',
            user: { name: 'Approver', lastname: 'X', nickname: null },
          },
        },
      ]);
      mockPrisma.comment.findMany.mockResolvedValue([
        {
          id: 100,
          memoId: 1,
          comment: 'hello   world',
          createdAt: new Date('2026-01-04T00:00:00.000Z'),
          userId: 5,
          user: { name: 'Approver', lastname: 'X', nickname: null },
          attachments: [{ url: 'uploads/comments/a b.png', filename: null, mimetype: 'image/png' }],
        },
      ]);

      const res = await service.searchMemos({ includeStatCounts: false }, 5, 'http://host/');
      const item = res.items[0];

      expect(item.documentCode).toBe('MEMO-1');
      expect(item.status).toBe('Processing');
      expect(item.currentApprover).toEqual({ names: ['Approver X'], level: 1 });
      expect(item.isMyTurnMain).toBe(true);
      expect(item.canSeeComments).toBe(true);
      expect(item.latestComment?.snippet).toBe('hello world');
      expect(item.latestComment?.attachments[0]).toEqual({
        url: 'http://host/api/secure-uploads/comments/a%20b.png',
        fileName: 'a b.png',
        mimeType: 'image/png',
        isImage: true,
      });
    });

    it('marks waiting rows of a satisfied ANY level as not_required', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([memo(1)]);
      mockPrisma.memoApproverAction.groupBy.mockResolvedValue([{ memoId: 1, _max: { version: 1 } }]);
      const loa = (userId: number) => ({
        level: 1,
        userId,
        approvalRequirement: 'ANY',
        user: { name: `U${userId}`, lastname: null, nickname: null },
      });
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([
        { memoId: 1, loaUserId: 1, actedAt: new Date(), createdAt: new Date(), status: { code: 'approved' }, loaUser: loa(1) },
        { memoId: 1, loaUserId: 2, actedAt: null, createdAt: new Date(), status: { code: 'waiting' }, loaUser: loa(2) },
      ]);

      const res = await service.searchMemos({ includeStatCounts: false }, 9, 'http://h');

      expect(res.items[0].approverStatus.map((r) => r.statusCode)).toEqual(['approved', 'not_required']);
      expect(res.items[0].approverStatus[1].since).toBeNull();
      expect(res.items[0].currentApprover).toBeNull();
    });
  });

  describe('stat counts', () => {
    beforeEach(() => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      rawRoutes = [
        { match: STATUS_COUNTS, rows: [{ statusName: 'Draft', count: 1n }, { statusName: 'Processing', count: 1 }] },
        { match: CURRENT_APPROVER, rows: [{ memoId: 2 }] },
        { match: BY_STATUS, rows: [{ memoId: 2 }] },
      ];
      mockPrisma.masterMemo.count.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    });

    it('counts the visible set by latest status', async () => {
      const counts = await service.getCachedStatCounts(1);
      expect(counts).toMatchObject({ total: 2, Draft: 1, Processing: 1, Approved: 0, myApproval: 1, myCreated: 1, myCC: 0 });
    });

    it('caches per user until forceRefresh', async () => {
      await service.getCachedStatCounts(1);
      await service.getCachedStatCounts(1);
      expect(mockPrisma.masterMemo.findMany).toHaveBeenCalledTimes(1);

      await service.getCachedStatCounts(1, true);
      expect(mockPrisma.masterMemo.findMany).toHaveBeenCalledTimes(2);
    });

    it('is included in search results by default', async () => {
      mockPrisma.masterMemo.count.mockReset().mockResolvedValue(0);
      mockPrisma.masterMemo.findMany
        .mockReset()
        .mockResolvedValueOnce([]) // page rows
        .mockResolvedValueOnce([{ id: 1 }]); // visible set for stat counts
      const res = await service.searchMemos({}, 1, 'http://h');
      expect(res.statCounts).toBeDefined();
      expect(res.facets).toBeUndefined();
    });
  });

  describe('facets', () => {
    it('returns empty lists when nothing is visible', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([]);
      expect(await service.getFacets(1)).toEqual({
        currentApprovers: [],
        extraApprovers: [],
        businessUnits: [],
        departments: [],
        ccUsers: [],
      });
    });

    it('sorts facet users by display name', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([{ id: 1 }]);
      mockPrisma.businessUnit.findMany.mockResolvedValue([{ id: 1, name: 'BU' }]);
      mockPrisma.department.findMany.mockResolvedValue([]);
      rawRoutes = [
        {
          match: `FROM "MemoCc" cc`,
          rows: [
            { id: 2, name: 'Zed', lastname: null, nickname: null },
            { id: 1, name: 'Amy', lastname: null, nickname: 'A' },
          ],
        },
      ];

      const facets = await service.getFacets(1);
      expect(facets.ccUsers).toEqual([
        { id: 1, name: 'Amy (A)' },
        { id: 2, name: 'Zed' },
      ]);
      expect(facets.businessUnits).toEqual([{ id: 1, name: 'BU' }]);
    });
  });
});
