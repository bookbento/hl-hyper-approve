import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { LoaManagementService } from './loa-management.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { JwtPayload } from '../../common/guards/jwt.guard';

const adminUser: JwtPayload = { id: 1, name: 'Admin', role: 'ADMIN', businessUnitId: 1 };
const dccUser: JwtPayload = { id: 2, name: 'DCC User', role: 'DCC', businessUnitId: 1 };
const regularUser: JwtPayload = { id: 3, name: 'Regular User', role: 'USER', businessUnitId: 1 };

const mockPrisma = {
  lineOfApprovalUserPivot: {
    findMany: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  lineOfApproval: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
  },
  memoType: {
    findMany: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  ccGroupMember: {
    count: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockAdminLog = { write: jest.fn().mockResolvedValue(undefined) };

describe('LoaManagementService', () => {
  let service: LoaManagementService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoaManagementService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AdminLogService, useValue: mockAdminLog },
      ],
    }).compile();

    service = module.get<LoaManagementService>(LoaManagementService);
    jest.clearAllMocks();

    // Default implementations
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));
    mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
    mockPrisma.lineOfApproval.findMany.mockResolvedValue([]);
    mockPrisma.lineOfApproval.findUnique.mockResolvedValue({ name: 'Test Line' });
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.lineOfApprovalUserPivot.count.mockResolvedValue(0);
    mockPrisma.ccGroupMember.count.mockResolvedValue(0);
    mockPrisma.ccGroupMember.updateMany.mockResolvedValue({ count: 0 });
  });

  describe('getApproverLines', () => {
    it('throws ForbiddenException for regular user', async () => {
      await expect(service.getApproverLines(regularUser, 5)).rejects.toThrow(ForbiddenException);
    });

    it('returns empty array when no pivots found', async () => {
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
      const result = await service.getApproverLines(adminUser, 5);
      expect(result).toEqual([]);
    });

    it('allows DCC user', async () => {
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
      await expect(service.getApproverLines(dccUser, 5)).resolves.toEqual([]);
    });
  });

  describe('getAllApproverLines', () => {
    it('throws ForbiddenException for regular user', async () => {
      await expect(service.getAllApproverLines(regularUser)).rejects.toThrow(ForbiddenException);
    });

    it('returns lines for admin', async () => {
      mockPrisma.lineOfApproval.findMany.mockResolvedValue([]);
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
      const result = await service.getAllApproverLines(adminUser);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getMemoTypesForLine', () => {
    it('throws ForbiddenException for regular user', async () => {
      await expect(service.getMemoTypesForLine(regularUser, 1)).rejects.toThrow(ForbiddenException);
    });

    it('returns memo types for admin', async () => {
      const fakeTypes = [{ id: 1, name: 'Type A', abbreviation: 'TA', description: null, isActive: true, businessUnit: null, department: null, createdAt: new Date() }];
      mockPrisma.memoType.findMany.mockResolvedValue(fakeTypes);
      const result = await service.getMemoTypesForLine(adminUser, 1);
      expect(result).toEqual(fakeTypes);
    });
  });

  describe('bulkUpdateApprover', () => {
    it('throws ForbiddenException for regular user', async () => {
      await expect(service.bulkUpdateApprover(regularUser, { fromUserId: 1, action: 'replace', toUserId: 2 } as any)).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException for invalid fromUserId', async () => {
      await expect(service.bulkUpdateApprover(adminUser, { fromUserId: NaN } as any)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for invalid action', async () => {
      await expect(service.bulkUpdateApprover(adminUser, { fromUserId: 1, action: 'invalid' } as any)).rejects.toThrow(BadRequestException);
    });

    it('returns dry run result when dryRun=true with remove action', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({ id: 1, name: 'From' });
      mockPrisma.lineOfApprovalUserPivot.count.mockResolvedValue(3);

      const result = await service.bulkUpdateApprover(adminUser, {
        fromUserId: 1,
        action: 'remove',
        dryRun: true,
        affectTemplates: true,
      } as any);

      expect((result as any).dryRun).toBe(true);
      expect((result as any).action).toBe('remove');
    });
  });

  describe('replaceApprover', () => {
    it('throws ForbiddenException for regular user', async () => {
      await expect(service.replaceApprover(regularUser, { fromUserId: 1, toUserId: 2 } as any)).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when fromId === toId', async () => {
      await expect(service.replaceApprover(adminUser, { fromUserId: 1, toUserId: 1 } as any)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when user not found', async () => {
      mockPrisma.user.findUnique.mockResolvedValue(null);
      await expect(service.replaceApprover(adminUser, { fromUserId: 1, toUserId: 2 } as any)).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateApproversForLine', () => {
    it('throws ForbiddenException for regular user', async () => {
      await expect(service.updateApproversForLine(regularUser, 1, { slots: [] })).rejects.toThrow(ForbiddenException);
    });

    it('saves empty slots successfully', async () => {
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
      mockPrisma.lineOfApprovalUserPivot.deleteMany.mockResolvedValue({ count: 0 });

      const result = await service.updateApproversForLine(adminUser, 1, { slots: [] });
      expect(result).toEqual({ ok: true, saved: 0 });
    });

    it('saves FIXED_USER slots and returns saved count', async () => {
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
      mockPrisma.lineOfApprovalUserPivot.deleteMany.mockResolvedValue({ count: 0 });
      mockPrisma.lineOfApprovalUserPivot.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.findMany.mockResolvedValue([{ id: 5, name: 'Alice', lastname: 'Smith', email: 'alice@test.com' }]);

      const slots = [{ level: 0, userId: 5, slotType: 'FIXED_USER', isSigReq: false, approvalRequirement: 'ALL' }];
      const result = await service.updateApproversForLine(adminUser, 1, { slots } as any);
      expect(result.ok).toBe(true);
      expect(result.saved).toBe(1);
    });
  });
});
