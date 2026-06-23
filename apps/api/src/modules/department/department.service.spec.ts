import { Test, TestingModule } from '@nestjs/testing';
import { DepartmentService } from './department.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

const mockPrisma = {
  department: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
  },
  businessUnit: {
    findUnique: jest.fn(),
  },
};

const mockAdminLog = {
  write: jest.fn().mockResolvedValue(undefined),
};

describe('DepartmentService', () => {
  let service: DepartmentService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DepartmentService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AdminLogService, useValue: mockAdminLog },
      ],
    }).compile();

    service = module.get<DepartmentService>(DepartmentService);
    jest.clearAllMocks();
  });

  // ---- findAll ----
  describe('findAll', () => {
    it('returns only non-deleted departments with businessUnit', async () => {
      const depts = [{ id: 1, name: 'Eng', deletedAt: null, businessUnit: { id: 1, name: 'BU1' } }];
      mockPrisma.department.findMany.mockResolvedValue(depts);

      const result = await service.findAll();

      expect(result).toEqual(depts);
      expect(mockPrisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: null } }),
      );
    });
  });

  // ---- findArchived ----
  describe('findArchived', () => {
    it('returns only archived departments', async () => {
      const archived = [{ id: 2, name: 'Old', deletedAt: new Date() }];
      mockPrisma.department.findMany.mockResolvedValue(archived);

      const result = await service.findArchived();

      expect(result).toEqual(archived);
      expect(mockPrisma.department.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { deletedAt: { not: null } } }),
      );
    });
  });

  // ---- findOne ----
  describe('findOne', () => {
    it('returns a department when found', async () => {
      const dept = { id: 1, name: 'Eng', businessUnit: null };
      mockPrisma.department.findUnique.mockResolvedValue(dept);

      const result = await service.findOne(1);
      expect(result).toEqual(dept);
    });

    it('throws NotFoundException when not found', async () => {
      mockPrisma.department.findUnique.mockResolvedValue(null);
      await expect(service.findOne(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ---- create ----
  describe('create', () => {
    it('creates and returns new department with admin log', async () => {
      const created = { id: 1, name: 'HR', abbreviation: 'HR', businessUnitId: 1, businessUnit: { id: 1, name: 'BU1' } };
      mockPrisma.department.create.mockResolvedValue(created);

      const result = await service.create({ name: 'HR', abbreviation: 'HR', businessUnitId: 1 }, 1);

      expect(result).toEqual(created);
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'DEPARTMENT_CREATE',
        'DEPARTMENT',
        created.id,
        created.name,
        expect.objectContaining({ abbreviation: 'HR' }),
      );
    });

    it('does not call adminLog when actorId is undefined', async () => {
      mockPrisma.department.create.mockResolvedValue({ id: 1, name: 'X', businessUnit: null });

      await service.create({ name: 'X', abbreviation: 'X' }, undefined);
      expect(mockAdminLog.write).not.toHaveBeenCalled();
    });
  });

  // ---- update ----
  describe('update', () => {
    const existing = { id: 1, name: 'Old', abbreviation: 'O', businessUnitId: null };

    it('updates department and logs changes', async () => {
      mockPrisma.department.findUnique.mockResolvedValue(existing);
      const updated = { id: 1, name: 'New', abbreviation: 'N', businessUnitId: null, businessUnit: null };
      mockPrisma.department.update.mockResolvedValue(updated);

      const result = await service.update(1, { name: 'New', abbreviation: 'N' }, 1);

      expect(result).toEqual(updated);
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'DEPARTMENT_UPDATE',
        'DEPARTMENT',
        updated.id,
        updated.name,
        expect.objectContaining({ changes: expect.any(Object) }),
      );
    });

    it('throws NotFoundException when department not found', async () => {
      mockPrisma.department.findUnique.mockResolvedValue(null);
      await expect(service.update(99, { name: 'X', abbreviation: 'X' }, 1)).rejects.toThrow(NotFoundException);
    });

    it('does not call adminLog when no fields changed', async () => {
      mockPrisma.department.findUnique.mockResolvedValue(existing);
      mockPrisma.department.update.mockResolvedValue({ ...existing, businessUnit: null });

      await service.update(1, { name: 'Old', abbreviation: 'O' }, 1);
      expect(mockAdminLog.write).not.toHaveBeenCalled();
    });
  });

  // ---- remove (soft delete) ----
  describe('remove', () => {
    it('soft-deletes department and logs DEPARTMENT_ARCHIVE', async () => {
      const existing = { id: 1, name: 'Eng', abbreviation: 'E', businessUnitId: null, deletedAt: null };
      mockPrisma.department.findUnique.mockResolvedValue(existing);
      mockPrisma.department.update.mockResolvedValue({ ...existing, deletedAt: new Date() });

      await service.remove(1, 1);

      expect(mockPrisma.department.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
      );
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'DEPARTMENT_ARCHIVE',
        'DEPARTMENT',
        existing.id,
        existing.name,
        expect.any(Object),
      );
    });

    it('throws NotFoundException when not found', async () => {
      mockPrisma.department.findUnique.mockResolvedValue(null);
      await expect(service.remove(99, 1)).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when already deleted', async () => {
      mockPrisma.department.findUnique.mockResolvedValue({ id: 1, deletedAt: new Date() });
      await expect(service.remove(1, 1)).rejects.toThrow(NotFoundException);
    });
  });

  // ---- restore ----
  describe('restore', () => {
    it('restores archived department and logs DEPARTMENT_RESTORE', async () => {
      const existing = { id: 1, name: 'Eng', abbreviation: 'E', businessUnitId: null, deletedAt: new Date() };
      mockPrisma.department.findUnique.mockResolvedValue(existing);
      mockPrisma.department.update.mockResolvedValue({ ...existing, deletedAt: null });

      await service.restore(1, 1);

      expect(mockPrisma.department.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { deletedAt: null } }),
      );
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'DEPARTMENT_RESTORE',
        'DEPARTMENT',
        existing.id,
        existing.name,
        expect.any(Object),
      );
    });

    it('throws NotFoundException when not found', async () => {
      mockPrisma.department.findUnique.mockResolvedValue(null);
      await expect(service.restore(99, 1)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when not archived', async () => {
      mockPrisma.department.findUnique.mockResolvedValue({ id: 1, deletedAt: null });
      await expect(service.restore(1, 1)).rejects.toThrow(BadRequestException);
    });
  });
});
