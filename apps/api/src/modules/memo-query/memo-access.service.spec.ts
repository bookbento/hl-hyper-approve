import { Test, TestingModule } from '@nestjs/testing';
import { MemoAccessService } from './memo-access.service';
import { PrismaService } from '../../prisma/prisma.service';

const mockPrisma = {
  masterMemo: { findUnique: jest.fn() },
  memoStatusPivot: { findFirst: jest.fn() },
  extraApprover: { findFirst: jest.fn() },
  commentTag: { findFirst: jest.fn() },
  memoApproverAction: { aggregate: jest.fn(), findFirst: jest.fn() },
  memoCc: { findFirst: jest.fn() },
  memoReference: { findMany: jest.fn() },
};

describe('MemoAccessService', () => {
  let service: MemoAccessService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoAccessService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<MemoAccessService>(MemoAccessService);
    jest.clearAllMocks();

    // Defaults — no access
    mockPrisma.masterMemo.findUnique.mockResolvedValue({ id: 1, userId: 99 });
    mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ status: { name: 'Processing' } });
    mockPrisma.extraApprover.findFirst.mockResolvedValue(null);
    mockPrisma.commentTag.findFirst.mockResolvedValue(null);
    mockPrisma.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mockPrisma.memoApproverAction.findFirst.mockResolvedValue(null);
    mockPrisma.memoCc.findFirst.mockResolvedValue(null);
    mockPrisma.memoReference.findMany.mockResolvedValue([]);
  });

  describe('canViewMemo', () => {
    it('returns true when user is owner', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ id: 1, userId: 5 });
      expect(await service.canViewMemo(5, 1)).toBe(true);
    });

    it('returns false when memo does not exist', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue(null);
      expect(await service.canViewMemo(5, 1)).toBe(false);
    });

    it('returns false for Draft memo when not owner', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ id: 1, userId: 99 });
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ status: { name: 'Draft' } });
      expect(await service.canViewMemo(5, 1)).toBe(false);
    });

    it('returns true for extra-approver', async () => {
      mockPrisma.extraApprover.findFirst.mockResolvedValue({ id: 10 });
      expect(await service.canViewMemo(5, 1)).toBe(true);
    });

    it('returns true for comment-tagged user', async () => {
      mockPrisma.commentTag.findFirst.mockResolvedValue({ id: 20 });
      expect(await service.canViewMemo(5, 1)).toBe(true);
    });

    it('returns true for approver', async () => {
      mockPrisma.memoApproverAction.findFirst.mockResolvedValue({ id: 30 });
      expect(await service.canViewMemo(5, 1)).toBe(true);
    });

    it('returns true for CC recipient', async () => {
      mockPrisma.memoCc.findFirst.mockResolvedValue({ id: 40 });
      expect(await service.canViewMemo(5, 1)).toBe(true);
    });

    it('prevents infinite recursion via visited set', async () => {
      // memo A references B, B references A
      const visited = new Set<number>([1]);
      expect(await service.canViewMemo(5, 1, visited)).toBe(false);
    });

    it('returns false when no access rule matches', async () => {
      expect(await service.canViewMemo(5, 1)).toBe(false);
    });
  });

  describe('canViewMemoSimple', () => {
    it('returns true when user is owner', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ id: 1, userId: 5 });
      expect(await service.canViewMemoSimple(5, 1)).toBe(true);
    });

    it('returns false for Draft when not owner', async () => {
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ status: { name: 'draft' } });
      expect(await service.canViewMemoSimple(5, 1)).toBe(false);
    });

    it('returns true for CC recipient', async () => {
      mockPrisma.memoCc.findFirst.mockResolvedValue({ id: 50 });
      expect(await service.canViewMemoSimple(5, 1)).toBe(true);
    });

    it('does NOT traverse references (simple check)', async () => {
      // Even if references exist, canViewMemoSimple returns false
      mockPrisma.memoReference.findMany.mockResolvedValue([{ mainMemoId: 99 }]);
      expect(await service.canViewMemoSimple(5, 1)).toBe(false);
      // memoReference.findMany should NOT be called
      expect(mockPrisma.memoReference.findMany).not.toHaveBeenCalled();
    });
  });
});
