import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MemoReferenceNestService } from './memo-reference.service';
import { MemoAccessService } from './memo-access.service';
import { PrismaService } from '../../prisma/prisma.service';

const mockPrisma = {
  masterMemo: { findMany: jest.fn(), findFirst: jest.fn() },
  memoReference: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma)),
};

const mockMemoAccess = {
  canViewMemo: jest.fn(),
};

describe('MemoReferenceNestService', () => {
  let service: MemoReferenceNestService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoReferenceNestService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MemoAccessService, useValue: mockMemoAccess },
      ],
    }).compile();

    service = module.get<MemoReferenceNestService>(MemoReferenceNestService);
    jest.clearAllMocks();

    mockMemoAccess.canViewMemo.mockResolvedValue(true);
  });

  // ── searchMemosForReference ────────────────────────────────────────────────

  describe('searchMemosForReference', () => {
    it('returns filtered memos excluding Draft/Deleted', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([
        {
          id: 1,
          subject: 'Valid memo',
          createdAt: new Date(),
          memoNumberRecord: { memonumber: 'M-001' },
          statuses: [{ status: { name: 'Processing' } }],
          user: { id: 1, name: 'Alice', lastname: 'Smith' },
        },
        {
          id: 2,
          subject: 'Draft memo',
          createdAt: new Date(),
          memoNumberRecord: null,
          statuses: [{ status: { name: 'Draft' } }],
          user: { id: 1, name: 'Alice', lastname: 'Smith' },
        },
      ]);

      const result = await service.searchMemosForReference(1, '', '', 10);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 1, subject: 'Valid memo' });
    });

    it('returns empty array when no memos', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([]);
      const result = await service.searchMemosForReference(1, 'test', '', 10);
      expect(result).toEqual([]);
    });
  });

  // ── getMemoReferences ──────────────────────────────────────────────────────

  describe('getMemoReferences', () => {
    const buildRef = (id: number, statusName: string) => ({
      referenceMemo: {
        id,
        subject: `Ref memo ${id}`,
        createdAt: new Date(),
        userId: 99,
        memoNumberRecord: null,
        statuses: [{ status: { name: statusName } }],
        user: { id: 99, name: 'Bob', lastname: 'Jones', profileImagePath: null },
        mainFiles: [],
        attachedFiles: [],
        comments: [],
      },
    });

    it('returns only accessible non-Deleted references', async () => {
      mockPrisma.memoReference.findMany.mockResolvedValue([
        buildRef(10, 'Processing'),
        buildRef(11, 'Deleted'), // should be filtered
      ]);
      mockMemoAccess.canViewMemo.mockImplementation((_userId: number, refId: number) =>
        Promise.resolve(refId === 10),
      );

      const result = await service.getMemoReferences(1, 1);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 10 });
    });

    it('returns empty when user lacks access to all refs', async () => {
      mockPrisma.memoReference.findMany.mockResolvedValue([buildRef(20, 'Processing')]);
      mockMemoAccess.canViewMemo.mockResolvedValue(false);
      const result = await service.getMemoReferences(1, 1);
      expect(result).toEqual([]);
    });
  });

  // ── updateMemoReferences ───────────────────────────────────────────────────

  describe('updateMemoReferences', () => {
    it('throws NotFoundException when user does not own the memo', async () => {
      mockPrisma.masterMemo.findFirst.mockResolvedValue(null);
      await expect(service.updateMemoReferences(1, 1, [2, 3])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('replaces references in a transaction', async () => {
      mockPrisma.masterMemo.findFirst
        .mockResolvedValueOnce({ id: 1 }) // main memo
        .mockResolvedValueOnce({ id: 2 }) // ref 2
        .mockResolvedValueOnce({ id: 3 }); // ref 3
      mockPrisma.memoReference.deleteMany.mockResolvedValue({});
      mockPrisma.memoReference.createMany.mockResolvedValue({});

      const result = await service.updateMemoReferences(1, 1, [2, 3]);
      expect(result).toMatchObject({ success: true, referencesCount: 2 });
    });
  });

  // ── getReferenceMemoContent ────────────────────────────────────────────────

  describe('getReferenceMemoContent', () => {
    const fakeMemo = {
      id: 5,
      subject: 'Referenced',
      createdAt: new Date(),
      userId: 99,
      memoNumberRecord: { memonumber: 'M-005' },
      statuses: [{ status: { name: 'Processing' } }],
      user: { id: 99, name: 'Carol', lastname: null, profileImagePath: null },
      mainFiles: [],
      attachedFiles: [],
      comments: [],
    };

    it('throws NotFoundException when reference link missing', async () => {
      mockPrisma.memoReference.findFirst.mockResolvedValue(null);
      await expect(service.getReferenceMemoContent(1, 5, 1)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when user lacks access', async () => {
      mockPrisma.memoReference.findFirst.mockResolvedValue({ id: 1 });
      mockPrisma.masterMemo.findFirst.mockResolvedValue(fakeMemo);
      mockMemoAccess.canViewMemo.mockResolvedValue(false);
      await expect(service.getReferenceMemoContent(1, 5, 1)).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException for Deleted referenced memo', async () => {
      mockPrisma.memoReference.findFirst.mockResolvedValue({ id: 1 });
      mockPrisma.masterMemo.findFirst.mockResolvedValue({
        ...fakeMemo,
        statuses: [{ status: { name: 'Deleted' } }],
      });
      mockMemoAccess.canViewMemo.mockResolvedValue(true);
      await expect(service.getReferenceMemoContent(1, 5, 1)).rejects.toThrow(NotFoundException);
    });

    it('returns full reference content when access is granted', async () => {
      mockPrisma.memoReference.findFirst.mockResolvedValue({ id: 1 });
      mockPrisma.masterMemo.findFirst.mockResolvedValue(fakeMemo);
      mockMemoAccess.canViewMemo.mockResolvedValue(true);
      const result = await service.getReferenceMemoContent(1, 5, 1);
      expect(result).toMatchObject({ id: 5, subject: 'Referenced', hasAccess: true });
    });
  });
});
