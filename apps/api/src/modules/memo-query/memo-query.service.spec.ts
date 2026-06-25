import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MemoQueryService } from './memo-query.service';
import { MemoAccessService } from './memo-access.service';
import { PrismaService } from '../../prisma/prisma.service';

// ── mock pdf-lib ──────────────────────────────────────────────────────────────
jest.mock('pdf-lib', () => ({
  PDFDocument: {
    load: jest.fn().mockResolvedValue({ getPageCount: () => 3 }),
  },
}));

// ── mock jsonwebtoken ─────────────────────────────────────────────────────────
jest.mock('jsonwebtoken', () => ({
  verify: jest.fn().mockReturnValue({ memoId: 1 }),
}));

const mockPrisma = {
  masterMemo: { findMany: jest.fn(), findUnique: jest.fn() },
  memoHistory: { findMany: jest.fn() },
  memoApproverAction: {
    findMany: jest.fn(),
    groupBy: jest.fn(),
    aggregate: jest.fn(),
    findFirst: jest.fn(),
  },
  comment: { findMany: jest.fn() },
  approvalActionStatus: { findMany: jest.fn() },
  memoStatusPivot: { findMany: jest.fn(), findFirst: jest.fn() },
  extraApprovalLine: { groupBy: jest.fn() },
  extraApprover: { findMany: jest.fn() },
  user: { findUnique: jest.fn() },
};

const mockMemoAccess = {
  canViewMemo: jest.fn(),
};

describe('MemoQueryService', () => {
  let service: MemoQueryService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoQueryService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MemoAccessService, useValue: mockMemoAccess },
      ],
    }).compile();

    service = module.get<MemoQueryService>(MemoQueryService);
    jest.clearAllMocks();

    // Defaults
    mockPrisma.memoStatusPivot.findMany.mockResolvedValue([]);
    mockPrisma.memoStatusPivot.findFirst.mockResolvedValue(null);
  });

  // ── getAllMemos ─────────────────────────────────────────────────────────────

  describe('getAllMemos', () => {
    it('returns empty array when no memos found', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([]);
      const result = await service.getAllMemos(1, 'http://localhost');
      expect(result).toEqual([]);
    });

    it('filters out Deleted memos', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([
        {
          id: 1,
          userId: 1,
          subject: 'Test',
          memonumber: 'M-001',
          statuses: [{ status: { name: 'Deleted' }, createdAt: new Date() }],
          approverActions: [],
          ccRecipients: [],
          extraApprovalLines: [],
          user: { id: 1, name: 'Alice', lastname: null, nickname: null, department: null },
          department: null,
          businessUnit: null,
          memoType: null,
        },
      ]);
      const result = await service.getAllMemos(1, 'http://localhost');
      expect(result).toEqual([]);
    });

    it('filters out Draft memos for non-owners', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([
        {
          id: 2,
          userId: 99, // different owner
          subject: 'Draft memo',
          memonumber: 'M-002',
          statuses: [{ status: { name: 'Draft' }, createdAt: new Date() }],
          approverActions: [],
          ccRecipients: [],
          extraApprovalLines: [],
          user: { id: 99, name: 'Bob', lastname: null, nickname: null, department: null },
          department: null,
          businessUnit: null,
          memoType: null,
        },
      ]);
      const result = await service.getAllMemos(1, 'http://localhost'); // userId=1
      expect(result).toEqual([]);
    });
  });

  // ── getMemoById ─────────────────────────────────────────────────────────────

  describe('getMemoById', () => {
    it('throws NotFoundException when memo does not exist', async () => {
      mockPrisma.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
      mockPrisma.masterMemo.findUnique.mockResolvedValue(null);
      mockMemoAccess.canViewMemo.mockResolvedValue(true);
      await expect(service.getMemoById(999, 1)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when user lacks access', async () => {
      mockPrisma.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
      mockPrisma.masterMemo.findUnique.mockResolvedValue({
        id: 1,
        statuses: [{ status: { name: 'Processing' } }],
        approverActions: [],
        mainFiles: [],
        attachedFiles: [],
        user: null,
        businessUnit: null,
        department: null,
        memoType: null,
        memoNumberRecord: null,
        signaturePositions: [],
        datePositions: [],
        memoNumberPositions: [],
        notePositions: [],
        history: [],
      });
      mockMemoAccess.canViewMemo.mockResolvedValue(false);

      await expect(service.getMemoById(1, 1)).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException for Deleted memo', async () => {
      mockPrisma.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
      mockPrisma.masterMemo.findUnique.mockResolvedValue({
        id: 1,
        statuses: [{ status: { name: 'Deleted' }, createdAt: new Date() }],
        approverActions: [],
        mainFiles: [],
        attachedFiles: [],
        user: null,
        businessUnit: null,
        department: null,
        memoType: null,
        memoNumberRecord: null,
        signaturePositions: [],
        datePositions: [],
        memoNumberPositions: [],
        notePositions: [],
        history: [],
      });
      mockMemoAccess.canViewMemo.mockResolvedValue(true);
      await expect(service.getMemoById(1, 1)).rejects.toThrow(NotFoundException);
    });
  });

  // ── getAwaitingApproval ────────────────────────────────────────────────────

  describe('getAwaitingApproval', () => {
    it('throws when status codes are missing', async () => {
      mockPrisma.approvalActionStatus.findMany.mockResolvedValue([]);
      await expect(service.getAwaitingApproval(1)).rejects.toThrow();
    });

    it('returns empty array when user has no waiting actions', async () => {
      mockPrisma.approvalActionStatus.findMany.mockResolvedValue([
        { id: 1, code: 'waiting' },
        { id: 2, code: 'approved' },
      ]);
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([]);
      const result = await service.getAwaitingApproval(1);
      expect(result).toEqual([]);
    });
  });

  // ── getCurrentApprovers ────────────────────────────────────────────────────

  describe('getCurrentApprovers', () => {
    it('returns empty array when user has no visible memos', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([]);
      const result = await service.getCurrentApprovers(1);
      expect(result).toEqual([]);
    });
  });

  // ── getUsersDelegationInfo ─────────────────────────────────────────────────

  describe('getUsersDelegationInfo', () => {
    it('returns non-delegated info when user has no active delegation', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 1,
        name: 'Alice',
        lastname: 'Smith',
        delegatedToUserId: null,
        delegationStartDate: null,
        delegationEndDate: null,
        delegatedToUser: null,
      });
      const result = await service.getUsersDelegationInfo([1]);
      expect(result[0]).toMatchObject({
        originalUserId: 1,
        effectiveUserId: 1,
        isDelegated: false,
      });
    });

    it('returns delegated info for user with active delegation', async () => {
      const now = new Date();
      const start = new Date(now.getTime() - 1000);
      const end = new Date(now.getTime() + 1000 * 60 * 60);
      mockPrisma.user.findUnique.mockResolvedValue({
        id: 1,
        name: 'Alice',
        lastname: 'Smith',
        delegatedToUserId: 2,
        delegationStartDate: start,
        delegationEndDate: end,
        delegatedToUser: {
          id: 2,
          name: 'Bob',
          lastname: 'Jones',
          nickname: null,
        },
      });
      const result = await service.getUsersDelegationInfo([1]);
      expect(result[0]).toMatchObject({
        originalUserId: 1,
        effectiveUserId: 2,
        isDelegated: true,
      });
    });

    it('returns no-delegation when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      const result = await service.getUsersDelegationInfo([999]);
      expect(result[0]).toMatchObject({ isDelegated: false });
    });
  });
});
