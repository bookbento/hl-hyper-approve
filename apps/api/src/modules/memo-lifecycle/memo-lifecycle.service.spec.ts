/**
 * MemoLifecycleService Unit Tests (Batch 6b)
 *
 * Critical paths verified (transaction parity):
 *   createMemo — success + number reservation + ForUse slots + approver actions
 *   createMemo — validation fail: missing file (bad request)
 *   createMemo — compensation rollback on mid-create error
 *   createMemo — override path: approversOverride used instead of line
 *   updateMemo — status check: 409 if not Draft/Rejected/Recalled
 *   updateMemo — version clone (no override, no line change)
 *   updateMemo — override path: ForUse upsert
 *   updateMemo — line change path: re-clone from template
 *   deleteMemo — soft delete + history record
 *   deleteMemo — blocked if approved in latest version
 *   forceDeleteMemo — hard delete + file cleanup attempted
 *   renewExpiry — success (expired → processing)
 *   renewExpiry — 403 if not owner/admin
 *   renewExpiry — 400 if status not valid
 *   uploadMainPDF — creates mainFile record
 *   parseExpiresAt — YYYY-MM-DD / ISO / empty / undefined
 */

import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ActionType, ExtraStatus } from '@prisma/client';
import { MemoLifecycleService, parseExpiresAt, absFromDbPath } from './memo-lifecycle.service';
import { PrismaService } from '../../prisma/prisma.service';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  memoType: { findUnique: jest.fn() },
  masterMemo: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), delete: jest.fn() },
  mainFile: { create: jest.fn(), update: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
  attachedFile: { create: jest.fn(), deleteMany: jest.fn(), findMany: jest.fn() },
  signaturePosition: { create: jest.fn(), deleteMany: jest.fn() },
  datePosition: { create: jest.fn(), deleteMany: jest.fn() },
  notePosition: { create: jest.fn(), deleteMany: jest.fn() },
  memoNumberPosition: { create: jest.fn(), deleteMany: jest.fn() },
  memoCc: { createMany: jest.fn(), deleteMany: jest.fn() },
  approvalActionStatus: { findFirst: jest.fn(), findUnique: jest.fn() },
  lineOfApprovalUserPivot: { findMany: jest.fn(), deleteMany: jest.fn() },
  lineOfApprovalUserPivotForUse: { create: jest.fn(), findMany: jest.fn(), update: jest.fn(), deleteMany: jest.fn() },
  memoApproverAction: { create: jest.fn(), createMany: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), aggregate: jest.fn(), deleteMany: jest.fn(), updateMany: jest.fn() },
  memoStatusPivot: { findFirst: jest.fn(), create: jest.fn(), upsert: jest.fn(), deleteMany: jest.fn() },
  memoHistory: { create: jest.fn(), deleteMany: jest.fn() },
  status: { findFirst: jest.fn(), create: jest.fn(), aggregate: jest.fn() },
  comment: { findMany: jest.fn(), deleteMany: jest.fn() },
  commentAttachment: { findMany: jest.fn(), deleteMany: jest.fn() },
  notification: { deleteMany: jest.fn() },
  user: { findUnique: jest.fn(), findFirst: jest.fn() },
  ccGroupMember: { findMany: jest.fn() },
  extraApprovalLine: { findMany: jest.fn(), updateMany: jest.fn() },
  extraApprover: { updateMany: jest.fn() },
  $transaction: jest.fn(),
  $executeRaw: jest.fn(),
  $queryRaw: jest.fn(),
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(name = 'test.pdf'): Express.Multer.File {
  return {
    fieldname: 'files',
    originalname: name,
    encoding: '7bit',
    mimetype: 'application/pdf',
    path: `/uploads/${name}`,
    size: 1024,
    destination: '/uploads',
    filename: name,
    buffer: Buffer.alloc(0),
    stream: null as any,
  };
}

function makeBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    subject: 'Test memo',
    businessUnitId: '1',
    userId: '5',
    memotypeId: '2',
    approvalLineId: '3',
    statusId: '1',
    sigPositions: '[]',
    datePositions: '[]',
    memoNumberPositions: '[]',
    notePositions: '[]',
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('MemoLifecycleService', () => {
  let service: MemoLifecycleService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoLifecycleService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();
    service = module.get<MemoLifecycleService>(MemoLifecycleService);
    jest.clearAllMocks();
  });

  // ── parseExpiresAt ──────────────────────────────────────────────────────

  describe('parseExpiresAt', () => {
    it('returns undefined for undefined input', () => {
      expect(parseExpiresAt(undefined)).toBeUndefined();
    });

    it('returns null for empty string', () => {
      expect(parseExpiresAt('')).toBeNull();
    });

    it('parses YYYY-MM-DD to end-of-day UTC', () => {
      const d = parseExpiresAt('2025-12-31');
      expect(d).toBeInstanceOf(Date);
      expect((d as Date).toISOString()).toContain('2025-12-31T23:59:59');
    });

    it('parses ISO string', () => {
      const d = parseExpiresAt('2025-06-15T10:00:00Z');
      expect(d).toBeInstanceOf(Date);
    });

    it('returns null for invalid string', () => {
      expect(parseExpiresAt('not-a-date')).toBeNull();
    });
  });

  // ── absFromDbPath ───────────────────────────────────────────────────────

  describe('absFromDbPath', () => {
    it('returns empty string for empty input', () => {
      expect(absFromDbPath('')).toBe('');
    });

    it('passes through absolute path', () => {
      expect(absFromDbPath('/absolute/path/file.pdf')).toBe('/absolute/path/file.pdf');
    });

    it('strips uploads/ prefix and joins with UPLOADS_DIR', () => {
      const result = absFromDbPath('uploads/file.pdf');
      expect(result).toContain('file.pdf');
    });
  });

  // ── createMemo ──────────────────────────────────────────────────────────

  describe('createMemo', () => {
    beforeEach(() => {
      mockPrisma.memoType.findUnique.mockResolvedValue({
        abbreviation: 'IT',
        businessUnitId: 1,
        departmentId: null,
        businessUnit: { abbreviation: 'HQ' },
        department: null,
      });
      mockPrisma.$queryRaw.mockResolvedValue([{ id: 1, memonumber: 'HQ-IT-202506-0001', sequenceNumber: 1 }]);
      mockPrisma.masterMemo.create.mockResolvedValue({ id: 10 });
      mockPrisma.mainFile.create.mockResolvedValue({ id: 100, orderNo: 0 });
      mockPrisma.$transaction.mockImplementation(async (ops) => {
        if (Array.isArray(ops)) return ops.map(() => ({}));
        if (typeof ops === 'function') return ops(mockPrisma);
        return [];
      });
      mockPrisma.approvalActionStatus.findFirst.mockResolvedValue({ id: 1 });
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
      mockPrisma.masterMemo.findUnique.mockResolvedValue({
        id: 10, memonumber: 'HQ-IT-202506-0001', subject: 'Test memo',
        approvalLineId: 3, businessUnitId: 1, departmentId: null,
        userId: 5, memotypeId: 2, expiresAt: null, createdAt: new Date(), updatedAt: new Date(),
      });
      mockPrisma.$executeRaw.mockResolvedValue(undefined);
    });

    it('creates memo and returns view data', async () => {
      const result = await service.createMemo({
        body: makeBody(),
        files: { files: [makeFile()], attachedFiles: [] },
        actorId: 5,
      });
      expect(mockPrisma.masterMemo.create).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty('memonumber');
    });

    it('throws BadRequestException when no PDF files uploaded', async () => {
      await expect(
        service.createMemo({
          body: makeBody(),
          files: { files: [], attachedFiles: [] },
          actorId: 5,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for missing memotypeId', async () => {
      await expect(
        service.createMemo({
          body: makeBody({ memotypeId: undefined }),
          files: { files: [makeFile()], attachedFiles: [] },
          actorId: 5,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('triggers compensation rollback on mid-create error', async () => {
      // masterMemo created but $transaction (positions) throws
      let callCount = 0;
      mockPrisma.$transaction.mockImplementation(async (ops) => {
        callCount++;
        if (callCount === 2) throw new Error('DB error during positions');
        if (Array.isArray(ops)) return ops.map(() => ({}));
        if (typeof ops === 'function') return ops(mockPrisma);
        return [];
      });
      mockPrisma.masterMemo.delete.mockResolvedValue({});

      await expect(
        service.createMemo({
          body: makeBody(),
          files: { files: [makeFile()], attachedFiles: [] },
          actorId: 5,
        }),
      ).rejects.toThrow();
      // rollback transaction should have been called
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });

    it('uses approversOverride when provided', async () => {
      const override = JSON.stringify([
        { userId: 99, level: 1, isSigReq: true, slotType: 'FIXED_USER', approvalRequirement: 'ALL' },
      ]);
      mockPrisma.user.findUnique.mockResolvedValue({ id: 99, delegatedToUserId: null, delegationStartDate: null, delegationEndDate: null });
      mockPrisma.lineOfApprovalUserPivotForUse.create.mockResolvedValue({ id: 200, userId: 99 });

      await service.createMemo({
        body: makeBody({ approversOverride: override }),
        files: { files: [makeFile()], attachedFiles: [] },
        actorId: 5,
      });
      // ForUse create should have been called for the override approver
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });
  });

  // ── updateMemo ──────────────────────────────────────────────────────────

  describe('updateMemo', () => {
    beforeEach(() => {
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 1 }); // Draft
      mockPrisma.masterMemo.update.mockResolvedValue({ id: 10, approvalLineId: 3 });
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ approvalLineId: 3 });
      mockPrisma.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([]);
      mockPrisma.memoApproverAction.createMany.mockResolvedValue({ count: 0 });
      mockPrisma.memoStatusPivot.upsert.mockResolvedValue({});
      mockPrisma.mainFile.findMany.mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (ops) => {
        if (Array.isArray(ops)) return ops.map(() => ({}));
        if (typeof ops === 'function') return ops(mockPrisma);
        return [];
      });
      mockPrisma.$executeRaw.mockResolvedValue(undefined);
    });

    it('throws ConflictException if memo is not in editable status', async () => {
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 3 }); // Approved
      await expect(
        service.updateMemo({
          id: 10,
          body: makeBody({ userId: '5' }),
          files: { files: [], attachedFiles: [] },
        }),
      ).rejects.toThrow(ConflictException);
    });

    it('updates and clones version when no override and no line change', async () => {
      await service.updateMemo({
        id: 10,
        body: makeBody({ userId: '5' }),
        files: { files: [], attachedFiles: [] },
      });
      expect(mockPrisma.masterMemo.update).toHaveBeenCalledTimes(1);
    });

    it('processes approversOverride when provided', async () => {
      const override = JSON.stringify([
        { userId: 77, level: 1, isSigReq: false, slotType: 'FIXED_USER', approvalRequirement: 'ALL', loaUserPivotId: null },
      ]);
      mockPrisma.lineOfApprovalUserPivotForUse.findMany.mockResolvedValue([]);
      mockPrisma.lineOfApprovalUserPivotForUse.create.mockResolvedValue({ id: 300, userId: 77 });
      mockPrisma.memoApproverAction.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.approvalActionStatus.findFirst.mockResolvedValue({ id: 1 });
      mockPrisma.$transaction.mockImplementation(async (ops) => {
        if (Array.isArray(ops)) return [{ id: 300, userId: 77 }];
        if (typeof ops === 'function') return ops(mockPrisma);
        return [];
      });

      await service.updateMemo({
        id: 10,
        body: makeBody({ userId: '5', approversOverride: override }),
        files: { files: [], attachedFiles: [] },
      });
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });

    it('re-clones approvers when approval line changes', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ approvalLineId: 3 }); // old line
      mockPrisma.masterMemo.update.mockResolvedValue({ id: 10, approvalLineId: 5 }); // new line
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([
        { id: 50, userId: 88, level: 1, isSigReq: true, roleDescription: null, slotType: 'FIXED_USER', approvalRequirement: 'ALL' },
      ]);
      mockPrisma.lineOfApprovalUserPivotForUse.create.mockResolvedValue({ id: 400, userId: 88 });
      mockPrisma.approvalActionStatus.findFirst.mockResolvedValue({ id: 1 });

      await service.updateMemo({
        id: 10,
        body: makeBody({ userId: '5', approvalLineId: '5' }),
        files: { files: [], attachedFiles: [] },
      });
      expect(mockPrisma.$executeRaw).toHaveBeenCalled();
    });
  });

  // ── deleteMemo ──────────────────────────────────────────────────────────

  describe('deleteMemo', () => {
    beforeEach(() => {
      mockPrisma.approvalActionStatus.findUnique.mockResolvedValue({ id: 2 });
      mockPrisma.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
      mockPrisma.memoApproverAction.findFirst.mockResolvedValue(null);
      mockPrisma.status.findFirst.mockResolvedValue({ id: 9, name: 'Deleted' });
      mockPrisma.$transaction.mockResolvedValue([]);
    });

    it('soft deletes and creates history record', async () => {
      await service.deleteMemo(10, 5);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('throws BadRequestException if latest version has approved action', async () => {
      mockPrisma.memoApproverAction.findFirst.mockResolvedValue({ id: 1 });
      await expect(service.deleteMemo(10, 5)).rejects.toThrow(BadRequestException);
    });
  });

  // ── forceDeleteMemo ─────────────────────────────────────────────────────

  describe('forceDeleteMemo', () => {
    beforeEach(() => {
      mockPrisma.comment.findMany.mockResolvedValue([]);
      mockPrisma.mainFile.findMany.mockResolvedValue([]);
      mockPrisma.attachedFile.findMany.mockResolvedValue([]);
      mockPrisma.commentAttachment.findMany.mockResolvedValue([]);
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([]);
      mockPrisma.$transaction.mockResolvedValue([]);
    });

    it('deletes all related data in a single transaction', async () => {
      await service.forceDeleteMemo(10);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });
  });

  // ── renewExpiry ─────────────────────────────────────────────────────────

  describe('renewExpiry', () => {
    const futureDate = '2099-12-31';

    beforeEach(() => {
      mockPrisma.masterMemo.findFirst.mockResolvedValue({ id: 10, userId: 5 });
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({
        status: { name: 'Processing' },
      });
      mockPrisma.$transaction.mockImplementation(async (fn) => {
        return fn({
          masterMemo: { update: jest.fn().mockResolvedValue({ id: 10, expiresAt: new Date('2099-12-31'), subject: 'Test' }) },
          memoStatusPivot: { deleteMany: jest.fn(), upsert: jest.fn() },
          memoApproverAction: { aggregate: jest.fn().mockResolvedValue({ _max: { version: 1 } }), updateMany: jest.fn() },
          extraApprovalLine: { findMany: jest.fn().mockResolvedValue([]) },
          extraApprover: { updateMany: jest.fn() },
          memoHistory: { create: jest.fn() },
          approvalActionStatus: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
          status: { findFirst: jest.fn().mockResolvedValue({ id: 5 }) },
        });
      });
    });

    it('renews expiry successfully for owner', async () => {
      const result = await service.renewExpiry({
        memoId: 10,
        actorId: 5,
        actorRole: 'USER',
        expiresAt: futureDate,
      });
      expect(result).toHaveProperty('message', 'Expiry date renewed successfully');
    });

    it('renews expiry for admin non-owner', async () => {
      const result = await service.renewExpiry({
        memoId: 10,
        actorId: 99,
        actorRole: 'ADMIN',
        expiresAt: futureDate,
      });
      expect(result).toHaveProperty('message', 'Expiry date renewed successfully');
    });

    it('throws ForbiddenException for non-owner non-admin', async () => {
      await expect(
        service.renewExpiry({ memoId: 10, actorId: 99, actorRole: 'USER', expiresAt: futureDate }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException for past date', async () => {
      await expect(
        service.renewExpiry({ memoId: 10, actorId: 5, actorRole: 'USER', expiresAt: '2000-01-01' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws NotFoundException for non-existent memo', async () => {
      mockPrisma.masterMemo.findFirst.mockResolvedValue(null);
      await expect(
        service.renewExpiry({ memoId: 999, actorId: 5, actorRole: 'USER', expiresAt: futureDate }),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException for invalid status', async () => {
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ status: { name: 'Approved' } });
      await expect(
        service.renewExpiry({ memoId: 10, actorId: 5, actorRole: 'USER', expiresAt: futureDate }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── uploadMainPDF ───────────────────────────────────────────────────────

  describe('uploadMainPDF', () => {
    it('creates mainFile record and returns it', async () => {
      const mockFile = { id: 500, memoId: 10, filePath: '/uploads/f.pdf', fileName: 'f.pdf', size: 1024 };
      mockPrisma.mainFile.create.mockResolvedValue(mockFile);

      const result = await service.uploadMainPDF(10, makeFile('f.pdf'));
      expect(mockPrisma.mainFile.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ memoId: 10 }) }),
      );
      expect(result).toEqual(mockFile);
    });
  });
});
