import {
  buildFilterClause,
  buildVisibilityClause,
  collectStatuses,
  resolveOrderBy,
} from './memo-search.filters';
import {
  computeIsMyTurnExtra,
  computeIsMyTurnMain,
  computeLatestActionAt,
  extractCurrentApprover,
  toSecureUploadPath,
} from './memo-search.items';
import { toDisplayName } from './display-name';
import type { ApproverStatusRow } from './memo-search.types';

const row = (over: Partial<ApproverStatusRow>): ApproverStatusRow => ({
  userId: 1,
  loaUserId: 1,
  level: 1,
  name: 'A',
  statusCode: 'waiting',
  actedAt: null,
  since: null,
  ...over,
});

describe('buildVisibilityClause', () => {
  it('ORs owner, approver, cc, extra approver and comment tag', () => {
    const clause = buildVisibilityClause(7);
    expect(clause.OR).toHaveLength(5);
    expect(clause.OR).toContainEqual({ userId: 7 });
    expect(clause.OR).toContainEqual({ commentTags: { some: { userId: 7 } } });
  });
});

describe('buildFilterClause', () => {
  it('returns an empty where for an empty request', () => {
    expect(buildFilterClause({})).toEqual({});
  });

  it('matches MEMO-{id} directly by id', () => {
    expect(buildFilterClause({ search: ' memo-42 ' })).toEqual({ AND: [{ id: 42 }] });
  });

  it('searches subject, memonumber and author name for free text', () => {
    const where = buildFilterClause({ search: 'budget' }) as any;
    const or = where.AND[0].OR;
    expect(or[0]).toEqual({ subject: { contains: 'budget', mode: 'insensitive' } });
    expect(or[1]).toEqual({ memonumber: { contains: 'budget', mode: 'insensitive' } });
    expect(or[2].user.OR).toHaveLength(3);
  });

  it('ignores "All" and non-numeric business unit / department', () => {
    expect(buildFilterClause({ businessUnitId: 'All', departmentId: 'All' })).toEqual({});
    expect(buildFilterClause({ businessUnitId: 3, departmentId: 5 })).toEqual({
      AND: [{ businessUnitId: 3 }, { departmentId: 5 }],
    });
  });

  it('extends the "to" date to end of day', () => {
    const where = buildFilterClause({ createdFrom: '2026-01-01', createdTo: '2026-01-31' }) as any;
    const range = where.AND[0].createdAt;
    expect(range.gte).toEqual(new Date('2026-01-01'));
    expect(range.lte.getHours()).toBe(23);
    expect(range.lte.getMinutes()).toBe(59);
  });

  it('skips blank cc status names', () => {
    expect(buildFilterClause({ ccStatuses: ['  ', ''] })).toEqual({});
    const where = buildFilterClause({ ccStatuses: ['Somchai'] }) as any;
    expect(where.AND[0].ccRecipients.some.user.OR).toHaveLength(3);
  });

  it('combines extra approver ids and names in one OR', () => {
    const where = buildFilterClause({ extraApproverIds: [1], extraApproverNames: ['x'] }) as any;
    const or = where.AND[0].extraApprovalLines.some.approvers.some.OR;
    expect(or[0]).toEqual({ userId: { in: [1] } });
    expect(or[1].user.OR).toHaveLength(3);
  });
});

describe('collectStatuses', () => {
  it('merges single + multi statuses, dropping All and duplicates', () => {
    expect(
      collectStatuses({ status: 'Draft', statuses: ['All', 'Draft', 'Approved', ''] }),
    ).toEqual(['Draft', 'Approved']);
  });
});

describe('resolveOrderBy', () => {
  it('maps direct columns with an id tiebreaker', () => {
    expect(resolveOrderBy({ sortBy: 'subject', sortDir: 'asc' })).toEqual([
      { subject: 'asc' },
      { id: 'desc' },
    ]);
  });

  it('falls back to id for non-column sort keys', () => {
    expect(resolveOrderBy({ sortBy: 'author' })).toEqual([{ id: 'desc' }]);
  });
});

describe('approver helpers', () => {
  const rows = [
    row({ userId: 1, level: 1, statusCode: 'approved', actedAt: '2026-01-01T00:00:00.000Z' }),
    row({ userId: 2, level: 2, name: 'B' }),
    row({ userId: 3, level: 2, name: 'C' }),
    row({ userId: 4, level: 3, name: 'D' }),
  ];

  it('extractCurrentApprover returns everyone at the lowest waiting level', () => {
    expect(extractCurrentApprover(rows)).toEqual({ names: ['B', 'C'], level: 2 });
    expect(extractCurrentApprover([row({ statusCode: 'approved' })])).toBeNull();
  });

  it('computeIsMyTurnMain is true only at the lowest waiting level', () => {
    expect(computeIsMyTurnMain(rows, 2)).toBe(true);
    expect(computeIsMyTurnMain(rows, 4)).toBe(false);
    expect(computeIsMyTurnMain(rows, 1)).toBe(false);
  });

  it('computeIsMyTurnExtra checks the first unacted approver of an active line', () => {
    const line = {
      status: 'IN_PROGRESS',
      approvers: [
        { actedAt: new Date(), user: { id: 10 } },
        { actedAt: null, user: { id: 11 } },
        { actedAt: null, user: { id: 12 } },
      ],
    } as any;
    expect(computeIsMyTurnExtra(line, 11)).toBe(true);
    expect(computeIsMyTurnExtra(line, 12)).toBe(false);
    expect(computeIsMyTurnExtra({ ...line, status: 'COMPLETED' }, 11)).toBe(false);
    expect(computeIsMyTurnExtra(null, 11)).toBe(false);
  });

  it('computeLatestActionAt takes the max over main and extra actions', () => {
    const extra = { approvers: [{ actedAt: new Date('2026-03-01T00:00:00.000Z') }] } as any;
    expect(computeLatestActionAt(rows, extra)).toBe('2026-03-01T00:00:00.000Z');
    expect(computeLatestActionAt(rows, null)).toBe('2026-01-01T00:00:00.000Z');
    expect(computeLatestActionAt([], null)).toBeNull();
  });
});

describe('toSecureUploadPath', () => {
  it.each([
    ['uploads/comments/a.pdf', '/api/secure-uploads/comments/a.pdf'],
    ['/api/uploads/comments/a.pdf', '/api/secure-uploads/comments/a.pdf'],
    ['https://host/api/secure-uploads/comments/a.pdf', '/api/secure-uploads/comments/a.pdf'],
    ['uploads\\comments\\a.pdf', '/api/secure-uploads/comments/a.pdf'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(toSecureUploadPath(input)).toBe(expected);
  });
});

describe('toDisplayName', () => {
  it('appends a distinct nickname', () => {
    expect(toDisplayName({ name: 'Somchai', lastname: 'J', nickname: 'Chai' }, { includeNickname: true })).toBe(
      'Somchai J (Chai)',
    );
  });

  it('drops a nickname that repeats the first name', () => {
    expect(toDisplayName({ name: 'Chai', lastname: 'J', nickname: 'chai' }, { includeNickname: true })).toBe(
      'Chai J',
    );
  });

  it('falls back to nickname alone', () => {
    expect(toDisplayName({ nickname: 'Chai' }, { includeNickname: true })).toBe('Chai');
    expect(toDisplayName(null)).toBe('');
  });
});
