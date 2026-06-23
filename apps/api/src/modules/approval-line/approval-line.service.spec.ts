import { Test, TestingModule } from '@nestjs/testing';
import { ApprovalLineService } from './approval-line.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPrisma = {
  department: { findMany: jest.fn() },
  lineOfApproval: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  lineOfApprovalUserPivot: {
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  masterMemo: {
    findUnique: jest.fn(),
    updateMany: jest.fn(),
  },
  memoStatusPivot: { findFirst: jest.fn() },
  memoHistory: { findFirst: jest.fn() },
  memoApproverAction: {
    findMany: jest.fn(),
    groupBy: jest.fn(),
  },
  extraApprover: { findMany: jest.fn() },
  $transaction: jest.fn(),
};

const mockAdminLog = { write: jest.fn().mockResolvedValue(undefined) };

const adminUser = { id: 1, name: 'Admin', role: 'admin', businessUnitId: 1 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalLineService', () => {
  let service: ApprovalLineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApprovalLineService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AdminLogService, useValue: mockAdminLog },
      ],
    }).compile();

    service = module.get<ApprovalLineService>(ApprovalLineService);
    jest.clearAllMocks();
  });

  // ── getAllTeams ────────────────────────────────────────────────────────────

  describe('getAllTeams', () => {
    it('returns departments ordered by name', async () => {
      const fakeDepts = [
        { id: 1, name: 'Dept A', abbreviation: 'A', businessUnitId: 1, businessUnit: { id: 1, name: 'BU1' } },
      ];
      mockPrisma.department.findMany.mockResolvedValue(fakeDepts);

      const result = await service.getAllTeams();

      expect(result).toEqual(fakeDepts);
      expect(mockPrisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null } }),
      );
    });
  });

  // ── createApprovalLine ────────────────────────────────────────────────────

  describe('createApprovalLine', () => {
    const levels = [{ users: [{ id: 10, isSigReq: false, slotType: 'FIXED_USER' }] }];

    it('creates a new approval line and logs the action', async () => {
      const fakeNewLine = {
        id: 5,
        name: 'Test Line',
        approvalUsers: [
          {
            level: 0,
            isSigReq: false,
            slotType: 'FIXED_USER',
            roleDescription: null,
            approvalRequirement: 'ALL',
            user: { id: 10, name: 'User A', lastname: null, nickname: null },
          },
        ],
      };
      mockPrisma.lineOfApproval.create.mockResolvedValue({ id: 5, name: 'Test Line' });
      mockPrisma.lineOfApprovalUserPivot.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.lineOfApproval.findUnique.mockResolvedValue(fakeNewLine);

      const result = await service.createApprovalLine(adminUser as any, 'Test Line', levels);

      expect(result.id).toBe(5);
      expect(result.name).toBe('Test Line');
      expect(result.levels).toHaveLength(1);
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'LOA_CREATE',
        'APPROVAL_LINE',
        5,
        'Test Line',
        { levelsCount: 1 },
      );
    });

    it('throws BadRequestException when name is missing', async () => {
      await expect(service.createApprovalLine(adminUser as any, '', levels)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when levels is missing', async () => {
      await expect(
        service.createApprovalLine(adminUser as any, 'Test', null as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ── updateApprovalLine ────────────────────────────────────────────────────

  describe('updateApprovalLine', () => {
    const levels = [{ users: [{ id: 10, isSigReq: false, slotType: 'FIXED_USER' }] }];

    it('updates approval line via transaction (delete-and-recreate)', async () => {
      const updated = {
        id: 3,
        name: 'Updated',
        approvalUsers: [
          {
            level: 0,
            isSigReq: false,
            slotType: 'FIXED_USER',
            roleDescription: null,
            approvalRequirement: 'ALL',
            user: { id: 10, name: 'User A', lastname: null, nickname: null },
          },
        ],
      };

      // Set up the mock queue: first call inside tx, second call after tx
      mockPrisma.lineOfApproval.findUnique
        .mockResolvedValueOnce({ id: 3 }) // inside transaction
        .mockResolvedValueOnce(updated);  // after transaction (fetch full line)
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        mockPrisma.lineOfApprovalUserPivot.deleteMany.mockResolvedValue({ count: 1 });
        mockPrisma.lineOfApprovalUserPivot.createMany.mockResolvedValue({ count: 1 });
        return fn(mockPrisma);
      });

      const result = await service.updateApprovalLine(adminUser as any, 3, 'Updated', levels);
      expect(result.id).toBe(3);
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'LOA_UPDATE',
        'APPROVAL_LINE',
        3,
        'Updated',
        expect.any(Object),
      );
    });

    it('throws BadRequestException when levels is not array', async () => {
      await expect(
        service.updateApprovalLine(adminUser as any, 1, 'Name', null as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for duplicate user at same level', async () => {
      const dupLevels = [
        { users: [{ id: 10, slotType: 'FIXED_USER' }, { id: 10, slotType: 'FIXED_USER' }] },
      ];
      await expect(
        service.updateApprovalLine(adminUser as any, 1, 'Name', dupLevels),
      ).rejects.toThrow('Duplicate user at the same level');
    });

    it('throws NotFoundException when line does not exist', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        mockPrisma.lineOfApproval.findUnique.mockResolvedValue(null);
        await fn(mockPrisma);
      });
      await expect(
        service.updateApprovalLine(adminUser as any, 999, 'Name', levels),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ── deleteApprovalLine ────────────────────────────────────────────────────

  describe('deleteApprovalLine', () => {
    it('unlinks memos, deletes pivots, deletes line, and logs', async () => {
      mockPrisma.masterMemo.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.lineOfApprovalUserPivot.deleteMany.mockResolvedValue({ count: 2 });
      mockPrisma.lineOfApproval.delete.mockResolvedValue({ id: 7, name: 'Line 7' });

      await service.deleteApprovalLine(adminUser as any, 7);

      expect(mockPrisma.masterMemo.updateMany).toHaveBeenCalledWith({
        where: { approvalLineId: 7 },
        data: { approvalLineId: null },
      });
      expect(mockPrisma.lineOfApprovalUserPivot.deleteMany).toHaveBeenCalledWith({
        where: { lineOfApprovalId: 7 },
      });
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'LOA_DELETE',
        'APPROVAL_LINE',
        7,
        'Line 7',
        {},
      );
    });
  });

  // ── getApprovers ──────────────────────────────────────────────────────────

  describe('getApprovers', () => {
    it('returns approvers for a valid memo', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ id: 1 });
      mockPrisma.lineOfApproval.findFirst.mockResolvedValue({
        id: 1,
        approvalUsers: [
          { level: 0, user: { id: 5, name: 'Bob', lastname: null, nickname: null } },
        ],
      });

      const result = await service.getApprovers(1);
      expect(result).toEqual([{ id: 5, name: 'Bob', level: 0 }]);
    });

    it('throws NotFoundException when memo does not exist', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue(null);
      await expect(service.getApprovers(999)).rejects.toThrow(NotFoundException);
    });

    it('returns empty array when no approval line exists', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ id: 1 });
      mockPrisma.lineOfApproval.findFirst.mockResolvedValue(null);

      const result = await service.getApprovers(1);
      expect(result).toEqual([]);
    });
  });

  // ── getApprovalLineByMemo ─────────────────────────────────────────────────

  describe('getApprovalLineByMemo', () => {
    it('returns empty levels when memo recalled (status=1, recallType=clear)', async () => {
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 1 });
      mockPrisma.memoHistory.findFirst.mockResolvedValue({ action: 'recall (clear)' });

      const result = await service.getApprovalLineByMemo(10);
      expect(result.levels).toEqual([]);
    });

    it('returns grouped approval actions per level (ALL requirement)', async () => {
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 2 });
      mockPrisma.memoHistory.findFirst.mockResolvedValue(null);
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([
        {
          loaUserId: 1,
          memoId: 10,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          actedAt: null,
          approveWithCondition: null,
          rejectReason: null,
          terminationReason: null,
          status: { code: 'waiting' },
          loaUser: {
            id: 1,
            level: 0,
            isSigReq: false,
            slotType: 'FIXED_USER',
            roleDescription: null,
            approvalRequirement: 'ALL',
            templatePivotId: null,
            user: { id: 5, name: 'Bob', lastname: null, nickname: null },
          },
        },
      ]);

      const result = await service.getApprovalLineByMemo(10);
      expect(result.memoId).toBe(10);
      expect(result.levels).toHaveLength(1);
      expect(result.levels[0].users[0]).toMatchObject({ status: 'waiting', id: 5 });
    });

    it('marks waiting approver as not_required when ANY requirement is already satisfied', async () => {
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 2 });
      mockPrisma.memoHistory.findFirst.mockResolvedValue(null);
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([
        // Approved user at level 0
        {
          loaUserId: 1,
          memoId: 10,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          actedAt: new Date(),
          approveWithCondition: null,
          rejectReason: null,
          terminationReason: null,
          status: { code: 'approved' },
          loaUser: {
            id: 1,
            level: 0,
            isSigReq: false,
            slotType: 'FIXED_USER',
            roleDescription: null,
            approvalRequirement: 'ANY',
            templatePivotId: null,
            user: { id: 5, name: 'Alice', lastname: null, nickname: null },
          },
        },
        // Waiting user at same level 0 with ANY requirement
        {
          loaUserId: 2,
          memoId: 10,
          version: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          actedAt: null,
          approveWithCondition: null,
          rejectReason: null,
          terminationReason: null,
          status: { code: 'waiting' },
          loaUser: {
            id: 2,
            level: 0,
            isSigReq: false,
            slotType: 'FIXED_USER',
            roleDescription: null,
            approvalRequirement: 'ANY',
            templatePivotId: null,
            user: { id: 6, name: 'Bob', lastname: null, nickname: null },
          },
        },
      ]);

      const result = await service.getApprovalLineByMemo(10);
      const level0Users = result.levels[0].users;
      const bobEntry = level0Users.find((u: any) => u.id === 6);
      expect(bobEntry).toBeDefined();
      expect((bobEntry as any).status).toBe('not_required');
    });
  });

  // ── listMyApprovalRequests ────────────────────────────────────────────────

  describe('listMyApprovalRequests', () => {
    it('returns empty items when no pending requests', async () => {
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([]);
      mockPrisma.memoApproverAction.groupBy.mockResolvedValue([]);
      mockPrisma.extraApprover.findMany.mockResolvedValue([]);

      const result = await service.listMyApprovalRequests(1);
      expect(result.items).toEqual([]);
    });

    it('filters out memos in terminal statuses (APPROVED, CANCELLED etc)', async () => {
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([
        {
          memoId: 1,
          version: 1,
          createdAt: new Date(),
          loaUser: { level: 0 },
          memo: {
            id: 1,
            memonumber: 'M001',
            subject: 'Done',
            createdAt: new Date(),
            expiresAt: null,
            user: { id: 2, name: 'Alice', lastname: null, nickname: null },
            statuses: [{ status: { name: 'APPROVED' } }],
          },
        },
      ]);
      mockPrisma.memoApproverAction.groupBy.mockResolvedValue([]);
      mockPrisma.extraApprover.findMany.mockResolvedValue([]);

      const result = await service.listMyApprovalRequests(1);
      expect(result.items).toHaveLength(0);
    });
  });
});
