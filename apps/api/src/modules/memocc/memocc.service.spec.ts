import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { MemoCcService } from './memocc.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../../common/guards/jwt.guard';

const adminUser: JwtPayload = { id: 1, name: 'Admin', role: 'ADMIN', businessUnitId: 1 };
const ownerUser: JwtPayload = { id: 2, name: 'Owner', role: 'USER', businessUnitId: 1 };
const otherUser: JwtPayload = { id: 3, name: 'Other', role: 'USER', businessUnitId: 1 };

const fakeMemo = { id: 10, userId: 2 }; // userId=2 is the owner

const mockPrisma = {
  masterMemo: {
    findUnique: jest.fn(),
    findMany: jest.fn(),
  },
  memoCc: {
    findMany: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
    createMany: jest.fn(),
  },
  memoApproverAction: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
  },
  lineOfApprovalUserPivot: {
    findMany: jest.fn(),
  },
  ccGroupMember: {
    findMany: jest.fn(),
  },
  $transaction: jest.fn(),
};

describe('MemoCcService', () => {
  let service: MemoCcService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoCcService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<MemoCcService>(MemoCcService);
    jest.clearAllMocks();

    // Default implementations
    mockPrisma.masterMemo.findUnique.mockResolvedValue(fakeMemo);
    mockPrisma.masterMemo.findMany.mockResolvedValue([]);
    mockPrisma.memoCc.findMany.mockResolvedValue([]);
    mockPrisma.memoCc.create.mockResolvedValue({});
    mockPrisma.memoCc.delete.mockResolvedValue({});
    mockPrisma.memoCc.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.memoCc.createMany.mockResolvedValue({ count: 0 });
    mockPrisma.memoApproverAction.findMany.mockResolvedValue([]);
    mockPrisma.memoApproverAction.findFirst.mockResolvedValue(null);
    mockPrisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
    mockPrisma.ccGroupMember.findMany.mockResolvedValue([]);
    mockPrisma.$transaction.mockImplementation((fn: any) => fn(mockPrisma));
  });

  describe('listCc', () => {
    it('throws NotFoundException when memo does not exist', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue(null);
      await expect(service.listCc(999)).rejects.toThrow(NotFoundException);
    });

    it('returns cc users with groups/groupIds as empty arrays', async () => {
      const ccRow = {
        user: { id: 5, name: 'Bob', lastname: 'Smith', nickname: null, email: 'bob@test.com', profileImagePath: null },
        createdAt: new Date(),
      };
      mockPrisma.memoCc.findMany.mockResolvedValue([ccRow]);

      const result = await service.listCc(10);
      expect(result.users).toHaveLength(1);
      expect(result.groups).toEqual([]);
      expect(result.groupIds).toEqual([]);
      expect(result.users[0].email).toBe('bob@test.com');
    });
  });

  describe('replaceCc', () => {
    it('throws NotFoundException when memo does not exist', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue(null);
      await expect(service.replaceCc(ownerUser, 999, { userIds: [], groupIds: [] })).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when non-owner/non-admin tries to replace', async () => {
      await expect(service.replaceCc(otherUser, 10, { userIds: [5], groupIds: [] })).rejects.toThrow(ForbiddenException);
    });

    it('excludes owner from CC list', async () => {
      const result = await service.replaceCc(ownerUser, 10, { userIds: [2, 5], groupIds: [] });
      // userId 2 is the owner, should be excluded
      expect(result.final.userIds).not.toContain(2);
      expect(result.final.userIds).toContain(5);
    });

    it('allows admin to replace CC', async () => {
      const result = await service.replaceCc(adminUser, 10, { userIds: [5], groupIds: [] });
      expect(result.memoId).toBe(10);
    });
  });

  describe('addCcOne', () => {
    it('throws NotFoundException when memo does not exist', async () => {
      mockPrisma.masterMemo.findUnique.mockResolvedValue(null);
      await expect(service.addCcOne(ownerUser, 999, 5)).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException for non-owner/non-admin', async () => {
      await expect(service.addCcOne(otherUser, 10, 5)).rejects.toThrow(ForbiddenException);
    });

    it('throws BadRequestException when adding owner as CC', async () => {
      await expect(service.addCcOne(ownerUser, 10, 2)).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException when adding approver as CC', async () => {
      mockPrisma.memoApproverAction.findFirst.mockResolvedValue({ id: 99 });
      await expect(service.addCcOne(ownerUser, 10, 5)).rejects.toThrow(BadRequestException);
    });

    it('throws ConflictException when user already CC', async () => {
      const prismaError = new Error('Unique constraint');
      (prismaError as any).code = 'P2002';
      mockPrisma.memoCc.create.mockRejectedValue(prismaError);

      await expect(service.addCcOne(ownerUser, 10, 5)).rejects.toThrow(ConflictException);
    });

    it('adds CC successfully', async () => {
      const result = await service.addCcOne(ownerUser, 10, 5);
      expect(result).toEqual({ ok: true });
    });
  });

  describe('removeCcOne', () => {
    it('throws ForbiddenException for non-owner/non-admin', async () => {
      await expect(service.removeCcOne(otherUser, 10, 5)).rejects.toThrow(ForbiddenException);
    });

    it('removes CC successfully for owner', async () => {
      const result = await service.removeCcOne(ownerUser, 10, 5);
      expect(result).toEqual({ ok: true });
    });
  });

  describe('listMemosCcToMe', () => {
    it('returns empty array when no memos', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([]);
      const result = await service.listMemosCcToMe(ownerUser);
      expect(result).toEqual([]);
    });

    it('filters out Draft memos', async () => {
      const memos = [
        {
          id: 1, subject: 'Draft Memo', memonumber: 'D001',
          user: { id: 5, name: 'Author', lastname: null, nickname: null },
          memoType: { id: 1, name: 'Type A' },
          statuses: [{ status: { name: 'Draft' }, createdAt: new Date() }],
          createdAt: new Date(),
        },
        {
          id: 2, subject: 'Approved Memo', memonumber: 'A001',
          user: { id: 5, name: 'Author', lastname: null, nickname: null },
          memoType: { id: 1, name: 'Type A' },
          statuses: [{ status: { name: 'Approved' }, createdAt: new Date() }],
          createdAt: new Date(),
        },
      ];
      mockPrisma.masterMemo.findMany.mockResolvedValue(memos);

      const result = await service.listMemosCcToMe(ownerUser);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(2);
    });
  });
});
