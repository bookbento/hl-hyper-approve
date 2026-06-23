import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import * as cookieParser from 'cookie-parser';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

describe('Type e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;

  const mockPrismaService = {
    memoType: {
      findMany: jest.fn().mockResolvedValue([{ id: 1, name: 'Annual' }]),
    },
    department: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    businessUnit: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    adminLog: { create: jest.fn().mockResolvedValue({}) },
    user: { findUnique: jest.fn().mockResolvedValue({ deletedAt: null }) },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const mockAdminLogService = { write: jest.fn().mockResolvedValue(undefined) };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .overrideProvider(AdminLogService)
      .useValue(mockAdminLogService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaService.user.findUnique.mockResolvedValue({ deletedAt: null });
  });

  describe('GET /api/types', () => {
    it('returns 200 with list — no auth required', async () => {
      mockPrismaService.memoType.findMany.mockResolvedValue([
        { id: 1, name: 'Annual' },
        { id: 2, name: 'Memo' },
      ]);

      const res = await request(app.getHttpServer())
        .get('/api/types')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(2);
      expect(res.body[0]).toMatchObject({ id: 1, name: 'Annual' });
    });

    it('returns 200 with empty array when no types', async () => {
      mockPrismaService.memoType.findMany.mockResolvedValue([]);
      const res = await request(app.getHttpServer())
        .get('/api/types')
        .expect(200);

      expect(res.body).toEqual([]);
    });
  });
});
