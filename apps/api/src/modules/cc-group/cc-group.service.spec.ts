import { Test, TestingModule } from '@nestjs/testing';
import { CcGroupService } from './cc-group.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import {
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';

const mockPrisma = {
  ccGroup: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  ccGroupMember: {
    findMany: jest.fn(),
    count: jest.fn(),
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  user: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

const mockAdminLog = { write: jest.fn().mockResolvedValue(undefined) };

const adminUser = { id: 1, name: 'Admin', role: 'admin', businessUnitId: 1 };
const dccUser = { id: 2, name: 'DCC', role: 'dcc', businessUnitId: 1 };
const regularUser = { id: 3, name: 'User', role: 'user', businessUnitId: 1 };

describe('CcGroupService', () => {
  let service: CcGroupService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CcGroupService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AdminLogService, useValue: mockAdminLog },
      ],
    }).compile();

    service = module.get<CcGroupService>(CcGroupService);
    jest.clearAllMocks();
  });

  // ---- listMyGroups ----
  describe('listMyGroups', () => {
    it('returns all groups for admin', async () => {
      mockPrisma.ccGroup.findMany.mockResolvedValue([]);
      await service.listMyGroups(adminUser as any);
      const call = mockPrisma.ccGroup.findMany.mock.calls[0][0];
      expect(call.where).toEqual({});
    });

    it('filters by ownerId for regular user', async () => {
      mockPrisma.ccGroup.findMany.mockResolvedValue([]);
      await service.listMyGroups(regularUser as any);
      const call = mockPrisma.ccGroup.findMany.mock.calls[0][0];
      expect(call.where).toEqual({ ownerId: regularUser.id });
    });
  });

  // ---- createGroup ----
  describe('createGroup', () => {
    it('creates group and logs CC_GROUP_CREATE', async () => {
      const createdGroup = { id: 1, name: 'My Group', ownerId: 2, members: [] };
      mockPrisma.ccGroup.create.mockResolvedValue(createdGroup);
      mockPrisma.user.findMany.mockResolvedValue([]);

      const result = await service.createGroup({ name: 'My Group' }, dccUser as any);

      expect(result).toEqual({ id: 1, name: 'My Group', memberCount: 0 });
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        2, 'CC_GROUP_CREATE', 'CC_GROUP', 1, 'My Group', expect.any(Object),
      );
    });

    it('throws ConflictException on P2002', async () => {
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique', {
        code: 'P2002',
        clientVersion: '6.0.0',
      });
      mockPrisma.ccGroup.create.mockRejectedValue(p2002);

      await expect(
        service.createGroup({ name: 'Duplicate' }, dccUser as any),
      ).rejects.toThrow(ConflictException);
    });
  });

  // ---- getGroup ----
  describe('getGroup', () => {
    it('returns group for admin regardless of ownership', async () => {
      mockPrisma.ccGroup.findUnique
        .mockResolvedValueOnce({ ownerId: 99 }) // assertOwnerOrAdmin check
        .mockResolvedValueOnce({
          id: 1, name: 'G', members: [],
        });

      const result = await service.getGroup(adminUser as any, 1);
      expect(result).toMatchObject({ id: 1, name: 'G' });
    });

    it('throws ForbiddenException for non-owner regular user', async () => {
      mockPrisma.ccGroup.findUnique.mockResolvedValue({ ownerId: 99 });
      await expect(service.getGroup(regularUser as any, 1)).rejects.toThrow(ForbiddenException);
    });

    it('throws NotFoundException when group not found in assertOwnerOrAdmin', async () => {
      mockPrisma.ccGroup.findUnique.mockResolvedValue(null);
      await expect(service.getGroup(adminUser as any, 999)).rejects.toThrow(NotFoundException);
    });
  });

  // ---- renameGroup ----
  describe('renameGroup', () => {
    it('renames and logs CC_RENAME', async () => {
      mockPrisma.ccGroup.findUnique
        .mockResolvedValueOnce({ ownerId: 2 }) // assertOwnerOrAdmin
        .mockResolvedValueOnce({ id: 1, name: 'Old Name' }); // old group
      mockPrisma.ccGroup.update.mockResolvedValue({ id: 1, name: 'New Name' });

      const result = await service.renameGroup(dccUser as any, 1, { name: 'New Name' });

      expect(result).toEqual({ id: 1, name: 'New Name' });
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        2, 'CC_RENAME', 'CC_GROUP', 1, 'New Name', expect.any(Object),
      );
    });

    it('throws ConflictException on P2002', async () => {
      mockPrisma.ccGroup.findUnique
        .mockResolvedValueOnce({ ownerId: 2 })
        .mockResolvedValueOnce({ id: 1, name: 'Old' });
      const p2002 = new Prisma.PrismaClientKnownRequestError('Unique', {
        code: 'P2002',
        clientVersion: '6.0.0',
      });
      mockPrisma.ccGroup.update.mockRejectedValue(p2002);

      await expect(service.renameGroup(dccUser as any, 1, { name: 'Dup' })).rejects.toThrow(ConflictException);
    });
  });

  // ---- deleteGroup ----
  describe('deleteGroup', () => {
    it('deletes group and logs CC_GROUP_DELETE', async () => {
      mockPrisma.ccGroup.findUnique
        .mockResolvedValueOnce({ ownerId: 1 }) // assertOwnerOrAdmin
        .mockResolvedValueOnce({ id: 1, name: 'G', members: [] }); // full group
      mockPrisma.ccGroup.delete.mockResolvedValue({});

      const result = await service.deleteGroup(adminUser as any, 1);

      expect(result).toEqual({ ok: true });
      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1, 'CC_GROUP_DELETE', 'CC_GROUP', 1, 'G', expect.any(Object),
      );
    });
  });

  // ---- searchCcGroups ----
  describe('searchCcGroups', () => {
    it('returns search results with memberIds', async () => {
      mockPrisma.ccGroup.findMany.mockResolvedValue([
        {
          id: 1,
          name: 'Alpha',
          _count: { members: 2 },
          members: [
            { userId: 10, user: { id: 10, name: 'A', lastname: 'B', nickname: null, email: 'a@a.com', profileImagePath: null, department: { name: 'Eng' } } },
          ],
        },
      ]);

      const result = await service.searchCcGroups({ q: 'Alpha', limit: 5 });

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 1, name: 'Alpha', memberCount: 2 });
      expect(result[0].memberIds).toEqual([10]);
    });
  });

  // ---- getGroupsBasicInfo ----
  describe('getGroupsBasicInfo', () => {
    it('returns empty array when ids param is empty', async () => {
      const result = await service.getGroupsBasicInfo('');
      expect(result).toEqual([]);
    });

    it('returns group basic info for valid ids', async () => {
      mockPrisma.ccGroup.findMany.mockResolvedValue([
        { id: 1, name: 'G', members: [{ userId: 5 }] },
      ]);

      const result = await service.getGroupsBasicInfo('1,2');
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 1, memberIds: [5] });
    });
  });

  // ---- bulkUpdateMembers ----
  describe('bulkUpdateMembers', () => {
    it('throws BadRequestException when replace without toUserId', async () => {
      await expect(
        service.bulkUpdateMembers(adminUser as any, {
          action: 'replace',
          fromUserId: 1,
          groupIds: [1],
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws ForbiddenException when no valid groups found', async () => {
      mockPrisma.ccGroup.findMany.mockResolvedValue([]);

      await expect(
        service.bulkUpdateMembers(regularUser as any, {
          action: 'remove',
          fromUserId: 1,
          groupIds: [999],
        } as any),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
