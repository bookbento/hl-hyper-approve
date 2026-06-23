import { Test, TestingModule } from '@nestjs/testing';
import { AdminLogReadService } from './admin-log-read.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { ForbiddenException } from '@nestjs/common';

const mockPrisma = {
  adminLog: {
    findMany: jest.fn(),
    count: jest.fn(),
  },
};

const mockAdminLog = {
  write: jest.fn().mockResolvedValue(undefined),
};

const adminUser = { id: 1, name: 'Admin', role: 'admin', businessUnitId: 1 };
const dccUser = { id: 2, name: 'DCC', role: 'dcc', businessUnitId: 1 };
const regularUser = { id: 3, name: 'User', role: 'user', businessUnitId: 1 };

describe('AdminLogReadService', () => {
  let service: AdminLogReadService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminLogReadService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AdminLogService, useValue: mockAdminLog },
      ],
    }).compile();

    service = module.get<AdminLogReadService>(AdminLogReadService);
    jest.clearAllMocks();
  });

  // ---- assertCanRead ----
  describe('assertCanRead', () => {
    it('allows admin to read any module', () => {
      expect(() => service.assertCanRead(adminUser as any, 'DEPARTMENT')).not.toThrow();
      expect(() => service.assertCanRead(adminUser as any, 'MEMO_TYPE')).not.toThrow();
    });

    it('allows DCC to read MEMO_TYPE', () => {
      expect(() => service.assertCanRead(dccUser as any, 'MEMO_TYPE')).not.toThrow();
    });

    it('allows DCC to read CC_GROUP', () => {
      expect(() => service.assertCanRead(dccUser as any, 'CC_GROUP')).not.toThrow();
    });

    it('allows DCC to read LOA', () => {
      expect(() => service.assertCanRead(dccUser as any, 'LOA')).not.toThrow();
    });

    it('throws ForbiddenException for DCC reading DEPARTMENT', () => {
      expect(() => service.assertCanRead(dccUser as any, 'DEPARTMENT')).toThrow(ForbiddenException);
    });

    it('throws ForbiddenException for regular user', () => {
      expect(() => service.assertCanRead(regularUser as any, 'MEMO_TYPE')).toThrow(ForbiddenException);
    });
  });

  // ---- getLogsByModule ----
  describe('getLogsByModule', () => {
    it('returns paginated logs for admin', async () => {
      const fakeLogs = [{ id: 1, createdAt: new Date(), actor: { id: 1, name: 'Admin', lastname: null, email: 'a@a.com' } }];
      mockPrisma.adminLog.findMany.mockResolvedValue(fakeLogs);
      mockPrisma.adminLog.count.mockResolvedValue(1);

      const result = await service.getLogsByModule(adminUser as any, { module: 'DEPARTMENT', page: 1, limit: 10 });

      expect(result.logs).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.logs[0]).toHaveProperty('createdAtFormatted');
    });

    it('throws ForbiddenException for DCC reading DEPARTMENT', async () => {
      await expect(
        service.getLogsByModule(dccUser as any, { module: 'DEPARTMENT' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('applies search filter in where clause', async () => {
      mockPrisma.adminLog.findMany.mockResolvedValue([]);
      mockPrisma.adminLog.count.mockResolvedValue(0);

      await service.getLogsByModule(adminUser as any, { module: '', search: 'test' });

      const call = mockPrisma.adminLog.findMany.mock.calls[0][0];
      expect(call.where.OR).toBeDefined();
    });
  });

  // ---- getAllLogs ----
  describe('getAllLogs', () => {
    it('returns all logs with pagination', async () => {
      const fakeLogs = [{ id: 1, createdAt: new Date(), actor: { id: 1, name: 'A', lastname: null, email: 'a@a.com' } }];
      mockPrisma.adminLog.findMany.mockResolvedValue(fakeLogs);
      mockPrisma.adminLog.count.mockResolvedValue(5);

      const result = await service.getAllLogs({ page: 1, limit: 10 });

      expect(result.logs).toHaveLength(1);
      expect(result.pagination.totalPages).toBe(1);
    });
  });

  // ---- createLog ----
  describe('createLog', () => {
    it('calls adminLog.write with correct args', async () => {
      await service.createLog(
        { actionType: 'TEST', module: 'DEPARTMENT', targetId: 1, targetName: 'HR', details: null },
        1,
      );

      expect(mockAdminLog.write).toHaveBeenCalledWith(
        1, 'TEST', 'DEPARTMENT', 1, 'HR', null,
      );
    });
  });
});
