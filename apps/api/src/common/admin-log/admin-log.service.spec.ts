import { Test, TestingModule } from '@nestjs/testing';
import { AdminLogService } from './admin-log.service';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

const mockPrisma = {
  adminLog: {
    create: jest.fn(),
  },
};

describe('AdminLogService', () => {
  let service: AdminLogService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminLogService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<AdminLogService>(AdminLogService);
    jest.clearAllMocks();
  });

  describe('write', () => {
    it('creates an adminLog record with correct fields', async () => {
      mockPrisma.adminLog.create.mockResolvedValue({});

      await service.write(1, 'BU_CREATE', 'BUSINESS_UNIT', 42, 'TestBU', {
        abbreviation: 'TBU',
      });

      expect(mockPrisma.adminLog.create).toHaveBeenCalledWith({
        data: {
          actorId: 1,
          actionType: 'BU_CREATE',
          module: 'BUSINESS_UNIT',
          targetId: 42,
          targetName: 'TestBU',
          details: { abbreviation: 'TBU' },
        },
      });
    });

    it('uses Prisma.JsonNull when details is null', async () => {
      mockPrisma.adminLog.create.mockResolvedValue({});

      await service.write(1, 'BU_DELETE', 'BUSINESS_UNIT', 1, 'BU', null);

      expect(mockPrisma.adminLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ details: Prisma.JsonNull }),
        }),
      );
    });

    it('coerces undefined targetId and targetName to null', async () => {
      mockPrisma.adminLog.create.mockResolvedValue({});

      await service.write(1, 'BU_CREATE', 'BUSINESS_UNIT', undefined, undefined, null);

      expect(mockPrisma.adminLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ targetId: null, targetName: null }),
        }),
      );
    });

    it('does not throw when prisma.adminLog.create rejects', async () => {
      mockPrisma.adminLog.create.mockRejectedValue(new Error('DB down'));

      // Must resolve without throwing
      await expect(
        service.write(1, 'BU_CREATE', 'BUSINESS_UNIT', 1, 'BU', null),
      ).resolves.toBeUndefined();
    });
  });
});
