import { Test, TestingModule } from '@nestjs/testing';
import { BusinessUnitService } from './business-unit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

// ---- minimal PrismaService mock ----
const mockPrisma = {
  businessUnit: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
};

const mockAdminLog = {
  write: jest.fn().mockResolvedValue(undefined),
};

describe('BusinessUnitService', () => {
  let service: BusinessUnitService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BusinessUnitService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AdminLogService, useValue: mockAdminLog },
      ],
    }).compile();

    service = module.get<BusinessUnitService>(BusinessUnitService);
    jest.clearAllMocks();
  });

  // ---- findAll ----
  describe('findAll', () => {
    it('returns list of business units with departments', async () => {
      const expected = [{ id: 1, name: 'BU1', departments: [] }];
      mockPrisma.businessUnit.findMany.mockResolvedValue(expected);

      const result = await service.findAll();

      expect(result).toEqual(expected);
      expect(mockPrisma.businessUnit.findMany).toHaveBeenCalledWith({
        include: {
          departments: {
            where: { deletedAt: null },
            select: { id: true, name: true, businessUnitId: true },
          },
        },
      });
    });
  });

  // ---- findOne ----
  describe('findOne', () => {
    it('returns a business unit when found', async () => {
      const bu = { id: 1, name: 'BU1', abbreviation: null };
      mockPrisma.businessUnit.findUnique.mockResolvedValue(bu);

      const result = await service.findOne(1);
      expect(result).toEqual(bu);
    });

    it('throws NotFoundException when business unit not found', async () => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue(null);
      await expect(service.findOne(99)).rejects.toThrow(NotFoundException);
    });
  });

  // ---- create ----
  describe('create', () => {
    it('creates and returns a new business unit', async () => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue(null);
      const created = { id: 1, name: 'NewBU', abbreviation: 'NBU' };
      mockPrisma.businessUnit.create.mockResolvedValue(created);

      const result = await service.create({ name: 'NewBU', abbreviation: 'NBU' }, 1);
      expect(result).toEqual(created);
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'BU_CREATE',
        'BUSINESS_UNIT',
        created.id,
        created.name,
        { abbreviation: created.abbreviation },
      );
    });

    it('throws ConflictException when name already exists', async () => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue({ id: 1, name: 'Existing' });

      await expect(
        service.create({ name: 'Existing' }, 1),
      ).rejects.toThrow(ConflictException);
    });

    it('throws ConflictException on Prisma P2002 (race condition)', async () => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
        code: 'P2002',
        clientVersion: '6.0.0',
      });
      mockPrisma.businessUnit.create.mockRejectedValue(p2002);

      await expect(service.create({ name: 'X' }, 1)).rejects.toThrow(ConflictException);
    });

    it('does not throw when actorId is undefined (no admin log)', async () => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue(null);
      mockPrisma.businessUnit.create.mockResolvedValue({ id: 2, name: 'Y', abbreviation: null });

      const result = await service.create({ name: 'Y' }, undefined);
      expect(result.name).toBe('Y');
      expect(mockAdminLog.write).not.toHaveBeenCalled();
    });
  });

  // ---- update ----
  describe('update', () => {
    const existing = { id: 1, name: 'Old', abbreviation: 'O' };

    it('updates and returns the business unit', async () => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue(existing);
      mockPrisma.businessUnit.findFirst.mockResolvedValue(null);
      const updated = { id: 1, name: 'New', abbreviation: 'N' };
      mockPrisma.businessUnit.update.mockResolvedValue(updated);

      const result = await service.update(1, { name: 'New', abbreviation: 'N' }, 1);
      expect(result).toEqual(updated);
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'BU_UPDATE',
        'BUSINESS_UNIT',
        updated.id,
        updated.name,
        expect.objectContaining({ changes: expect.any(Object) }),
      );
    });

    it('throws NotFoundException when target not found', async () => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue(null);
      await expect(service.update(99, { name: 'X' }, 1)).rejects.toThrow(NotFoundException);
    });

    it('throws ConflictException when another BU has same name', async () => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue(existing);
      mockPrisma.businessUnit.findFirst.mockResolvedValue({ id: 2, name: 'New' });

      await expect(service.update(1, { name: 'New' }, 1)).rejects.toThrow(ConflictException);
    });

    it('does not call adminLog.write when no fields changed', async () => {
      // same name, same abbreviation → changes object stays empty
      mockPrisma.businessUnit.findUnique.mockResolvedValue(existing);
      mockPrisma.businessUnit.findFirst.mockResolvedValue(null);
      mockPrisma.businessUnit.update.mockResolvedValue(existing); // returns same values

      await service.update(1, { name: 'Old', abbreviation: 'O' }, 1);
      expect(mockAdminLog.write).not.toHaveBeenCalled();
    });
  });

  // ---- remove ----
  describe('remove', () => {
    it('deletes the business unit without throwing', async () => {
      const bu = { id: 1, name: 'BU1', abbreviation: null };
      mockPrisma.businessUnit.findUnique.mockResolvedValue(bu);
      mockPrisma.businessUnit.delete.mockResolvedValue(bu);

      await expect(service.remove(1, 1)).resolves.toBeUndefined();
      expect(mockPrisma.businessUnit.delete).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1,
        'BU_DELETE',
        'BUSINESS_UNIT',
        bu.id,
        bu.name,
        { abbreviation: bu.abbreviation },
      );
    });

    it('throws NotFoundException when business unit not found', async () => {
      mockPrisma.businessUnit.findUnique.mockResolvedValue(null);
      await expect(service.remove(99, 1)).rejects.toThrow(NotFoundException);
    });
  });
});
