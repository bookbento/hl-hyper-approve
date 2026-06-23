import { Test, TestingModule } from '@nestjs/testing';
import { MemotypeService } from './memotype.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import {
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPrisma = {
  memoType: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    count: jest.fn(),
  },
  lineOfApproval: {
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  lineOfApprovalUserPivot: {
    findMany: jest.fn(),
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  masterMemo: {
    count: jest.fn(),
  },
  typeFile: {
    findMany: jest.fn(),
    create: jest.fn(),
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
    delete: jest.fn(),
  },
  businessUnit: {
    findUnique: jest.fn(),
  },
  department: {
    findUnique: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockAdminLog = { write: jest.fn().mockResolvedValue(undefined) };

const adminUser = { id: 1, name: 'Admin', role: 'admin', businessUnitId: 1 };
const dccUser = { id: 2, name: 'DCC', role: 'dcc', businessUnitId: 1 };
const regularUser = { id: 3, name: 'User', role: 'user', businessUnitId: 1 };

const fakeType = {
  id: 1,
  name: 'Test Type',
  description: 'Desc',
  abbreviation: 'TT',
  isActive: true,
  isDelete: false,
  createdAt: new Date(),
  defaultTypeFileId: null,
  businessUnitId: 1,
  approvalLineId: 1,
  forEveryone: false,
  forEveryDepartmentAcrossBU: false,
  forAllDepartmentUnderSelectedBu: true,
  departmentId: null,
  department: null,
  businessUnit: { id: 1, name: 'BU1' },
  approvalLine: { id: 1, name: 'Test Type' },
  typeFiles: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemotypeService', () => {
  let service: MemotypeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemotypeService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AdminLogService, useValue: mockAdminLog },
      ],
    }).compile();

    service = module.get<MemotypeService>(MemotypeService);
    jest.clearAllMocks();
  });

  // ── getCount ──────────────────────────────────────────────────────────────

  describe('getCount', () => {
    it('returns activeCount and totalCount for admin', async () => {
      mockPrisma.memoType.count.mockResolvedValueOnce(5).mockResolvedValueOnce(7);
      const result = await service.getCount(adminUser as any);
      expect(result).toEqual({ activeCount: 5, totalCount: 7 });
    });
  });

  // ── findAll ───────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('returns all types for admin without filter', async () => {
      mockPrisma.memoType.findMany.mockResolvedValue([fakeType]);
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);

      const result = await service.findAll(adminUser as any, false, 'creation', null);
      expect(Array.isArray(result)).toBe(true);
    });

    it('builds visibility filter for regular user (isDelete:false)', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        businessUnitId: 1,
        departmentId: 2,
        businessUnitAccess: [],
      });
      mockPrisma.memoType.findMany.mockResolvedValue([]);

      await service.findAll(regularUser as any, false, 'creation', null);
      const call = mockPrisma.memoType.findMany.mock.calls[0][0];
      expect(call.where).toMatchObject({ isDelete: false });
    });

    it('admin sees includeInactive types when flag set', async () => {
      mockPrisma.memoType.findMany.mockResolvedValue([]);
      await service.findAll(adminUser as any, true, 'management', null);
      const call = mockPrisma.memoType.findMany.mock.calls[0][0];
      // Admin + includeInactive=true => no isActive filter
      expect(call.where).not.toHaveProperty('isActive');
    });
  });

  // ── findById ──────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns type with approval levels for admin', async () => {
      mockPrisma.memoType.findFirst.mockResolvedValue(fakeType);
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);

      const result = await service.findById(adminUser as any, 1, 'creation', false);
      expect(result).toHaveProperty('id', 1);
    });

    it('throws ForbiddenException when type not found/not accessible', async () => {
      mockPrisma.memoType.findFirst.mockResolvedValue(null);
      await expect(service.findById(adminUser as any, 999, 'creation', false)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ── createMEMOType ────────────────────────────────────────────────────────

  describe('createMEMOType — transaction parity', () => {
    const validBody = {
      name: 'New Type',
      description: 'Description',
      abbreviation: 'NT',
      businessUnitId: '1',
      forAllDepartmentUnderSelectedBu: 'true',
    };

    beforeEach(() => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue({ id: 1 });
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        mockPrisma.memoType.create.mockResolvedValue({
          id: 10,
          name: 'New Type',
          description: 'Description',
          abbreviation: 'NT',
          isActive: true,
          isDelete: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          createdByUserId: 1,
          defaultTypeFileId: null,
          departmentId: null,
          department: null,
          businessUnit: { id: 1, name: 'BU1' },
        });
        mockPrisma.lineOfApproval.create.mockResolvedValue({ id: 5 });
        mockPrisma.memoType.update.mockResolvedValue({});
        return fn(mockPrisma);
      });
      mockPrisma.memoType.findUnique.mockResolvedValue({ ...fakeType, id: 10 });
    });

    it('creates memoType + lineOfApproval atomically in transaction', async () => {
      await service.createMEMOType(adminUser as any, { ...validBody }, []);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.memoType.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.lineOfApproval.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.memoType.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ approvalLineId: 5 }) }),
      );
    });

    it('creates lineOfApprovalUserPivot when createApprovalLine=true + approvalLevels', async () => {
      const levels = [{ users: [{ id: 10, isSigReq: false, slotType: 'FIXED_USER' }] }];
      mockPrisma.lineOfApprovalUserPivot.createMany.mockResolvedValue({ count: 1 });
      mockPrisma.user.findMany.mockResolvedValue([{ id: 10, name: 'Alice', lastname: null }]);

      await service.createMEMOType(
        adminUser as any,
        { ...validBody, createApprovalLine: 'true', approvalLevels: JSON.stringify(levels) },
        [],
      );
      expect(mockPrisma.lineOfApprovalUserPivot.createMany).toHaveBeenCalledTimes(1);
    });

    it('throws BadRequestException when name is missing', async () => {
      await expect(
        service.createMEMOType(adminUser as any, { description: 'Desc', businessUnitId: '1', forAllDepartmentUnderSelectedBu: 'true' }, []),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when businessUnitId missing (non-forEveryone)', async () => {
      await expect(
        service.createMEMOType(adminUser as any, { name: 'N', description: 'D', forAllDepartmentUnderSelectedBu: 'true' }, []),
      ).rejects.toThrow('businessUnitId is required');
    });

    it('throws BadRequestException for duplicate approver in same level', async () => {
      const dupLevels = [
        { users: [{ id: 10, slotType: 'FIXED_USER' }, { id: 10, slotType: 'FIXED_USER' }] },
      ];
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        mockPrisma.memoType.create.mockResolvedValue({ id: 10, name: 'N' });
        mockPrisma.lineOfApproval.create.mockResolvedValue({ id: 5 });
        return fn(mockPrisma);
      });
      await expect(
        service.createMEMOType(
          adminUser as any,
          { ...validBody, createApprovalLine: 'true', approvalLevels: JSON.stringify(dupLevels) },
          [],
        ),
      ).rejects.toThrow();
    });
  });

  // ── updateMEMOType ────────────────────────────────────────────────────────

  describe('updateMEMOType — transaction parity', () => {
    const validBody = {
      name: 'Updated Type',
      description: 'Updated Description',
      abbreviation: 'UT',
      businessUnitId: '1',
    };

    beforeEach(() => {
      mockPrisma.memoType.findUnique
        .mockResolvedValueOnce({
          id: 1,
          name: 'Old Name',
          abbreviation: 'ON',
          description: 'Old Desc',
          isActive: true,
          isDelete: false,
          approvalLineId: 5,
          businessUnitId: 1,
          businessUnit: { name: 'BU1' },
          departmentId: null,
          department: null,
          forEveryone: false,
          forEveryDepartmentAcrossBU: false,
          forAllDepartmentUnderSelectedBu: true,
          createdByUserId: 1,
        })
        .mockResolvedValueOnce({ ...fakeType, id: 1 });

      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        mockPrisma.memoType.update.mockResolvedValue({});
        mockPrisma.lineOfApproval.update.mockResolvedValue({});
        mockPrisma.lineOfApprovalUserPivot.deleteMany.mockResolvedValue({ count: 1 });
        mockPrisma.lineOfApprovalUserPivot.createMany.mockResolvedValue({ count: 1 });
        return fn(mockPrisma);
      });
    });

    it('updates memoType + lineOfApproval in single transaction', async () => {
      await service.updateMEMOType(adminUser as any, 1, { ...validBody }, []);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.memoType.update).toHaveBeenCalled();
      expect(mockPrisma.lineOfApproval.update).toHaveBeenCalled();
    });

    it('rewrites pivots (delete-and-recreate) when approvalLevels provided', async () => {
      const levels = [{ users: [{ id: 10, isSigReq: false, slotType: 'FIXED_USER' }] }];
      await service.updateMEMOType(
        adminUser as any,
        1,
        { ...validBody, approvalLevels: JSON.stringify(levels) },
        [],
      );
      expect(mockPrisma.lineOfApprovalUserPivot.deleteMany).toHaveBeenCalled();
      expect(mockPrisma.lineOfApprovalUserPivot.createMany).toHaveBeenCalled();
    });

    it('throws NotFoundException when type does not exist', async () => {
      mockPrisma.memoType.findUnique.mockReset().mockResolvedValue(null);
      await expect(service.updateMEMOType(adminUser as any, 999, validBody, [])).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws BadRequestException when type has no approvalLineId', async () => {
      mockPrisma.memoType.findUnique.mockReset().mockResolvedValue({ ...fakeType, approvalLineId: null });
      await expect(service.updateMEMOType(adminUser as any, 1, validBody, [])).rejects.toThrow(
        BadRequestException,
      );
    });

    it('throws ForbiddenException when non-owner regular user tries to update', async () => {
      mockPrisma.memoType.findUnique.mockReset().mockResolvedValue({
        ...fakeType,
        approvalLineId: 5,
        createdByUserId: 999, // different user
      });
      await expect(service.updateMEMOType(regularUser as any, 1, validBody, [])).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('throws BadRequestException for duplicate approver at same level', async () => {
      const dupLevels = [
        { users: [{ id: 10, slotType: 'FIXED_USER' }, { id: 10, slotType: 'FIXED_USER' }] },
      ];
      await expect(
        service.updateMEMOType(adminUser as any, 1, {
          ...validBody,
          approvalLevels: JSON.stringify(dupLevels),
        }, []),
      ).rejects.toThrow('Duplicate approver');
    });
  });

  // ── deleteMEMOType ────────────────────────────────────────────────────────

  describe('deleteMEMOType', () => {
    beforeEach(() => {
      // Reset findUnique queue to avoid mock bleed from updateMEMOType tests
      mockPrisma.memoType.findUnique.mockReset();
    });

    it('throws NotFoundException when type not found', async () => {
      mockPrisma.memoType.findUnique.mockResolvedValue(null);
      await expect(service.deleteMEMOType(adminUser as any, 999)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when memo references the type', async () => {
      mockPrisma.memoType.findUnique.mockResolvedValue(fakeType);
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
      mockPrisma.masterMemo.count.mockResolvedValue(2);

      await expect(service.deleteMEMOType(adminUser as any, 1)).rejects.toThrow(ForbiddenException);
    });

    it('deletes type, line (when no memos use it), pivots, files in transaction', async () => {
      mockPrisma.memoType.findUnique.mockResolvedValue(fakeType);
      mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
      mockPrisma.masterMemo.count.mockResolvedValue(0);
      mockPrisma.typeFile.findMany.mockResolvedValue([]);
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        mockPrisma.masterMemo.count.mockResolvedValue(0); // lineRefCount
        mockPrisma.lineOfApprovalUserPivot.deleteMany.mockResolvedValue({ count: 0 });
        mockPrisma.lineOfApproval.delete.mockResolvedValue({ id: 1 });
        mockPrisma.memoType.delete.mockResolvedValue({ id: 1 });
        return fn(mockPrisma);
      });

      await service.deleteMEMOType(adminUser as any, 1);

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'MEMO_TYPE_DELETE',
        'MEMO_TYPE',
        1,
        fakeType.name,
        expect.any(Object),
      );
    });
  });

  // ── deleteMEMOTypeFile ────────────────────────────────────────────────────

  describe('deleteMEMOTypeFile', () => {
    it('throws NotFoundException when type not found', async () => {
      mockPrisma.memoType.findUnique.mockResolvedValue(null);
      await expect(service.deleteMEMOTypeFile(adminUser as any, 999, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException when file not found', async () => {
      mockPrisma.memoType.findUnique.mockResolvedValue(fakeType);
      mockPrisma.typeFile.findFirst.mockResolvedValue(null);
      await expect(service.deleteMEMOTypeFile(adminUser as any, 1, 999)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('deletes file record and logs action', async () => {
      mockPrisma.memoType.findUnique.mockResolvedValue({ ...fakeType, name: 'Test Type' });
      mockPrisma.typeFile.findFirst.mockResolvedValue({ id: 5, filePath: '/uploads/types/file.pdf' });
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        mockPrisma.typeFile.delete.mockResolvedValue({});
        return fn(mockPrisma);
      });

      await service.deleteMEMOTypeFile(adminUser as any, 1, 5);
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'MEMO_TYPE_FILE_DELETE',
        'MEMO_TYPE',
        1,
        'Test Type',
        expect.objectContaining({ fileId: 5 }),
      );
    });
  });
});
