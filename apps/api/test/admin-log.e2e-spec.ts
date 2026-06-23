import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

describe('AdminLog e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;

  const fakeLog = {
    id: 1,
    actorId: 1,
    actionType: 'DEPT_CREATE',
    module: 'DEPARTMENT',
    targetId: 1,
    targetName: 'HR',
    details: null,
    createdAt: new Date('2026-01-01T10:00:00Z'),
    actor: { id: 1, name: 'Admin', lastname: null, email: 'admin@test.com' },
  };

  const mockPrismaService = {
    adminLog: {
      findMany: jest.fn().mockResolvedValue([fakeLog]),
      count: jest.fn().mockResolvedValue(1),
      create: jest.fn().mockResolvedValue({}),
    },
    memoType: { findMany: jest.fn().mockResolvedValue([]) },
    department: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    businessUnit: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    user: { findUnique: jest.fn().mockResolvedValue({ deletedAt: null }) },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const mockAdminLogService = { write: jest.fn().mockResolvedValue(undefined) };

  let adminJwt: string;
  let dccJwt: string;
  let userJwt: string;

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

    const jwtService = moduleFixture.get<JwtService>(JwtService);
    adminJwt = jwtService.sign({ id: 1, name: 'Admin', role: 'admin', businessUnitId: 1 });
    dccJwt = jwtService.sign({ id: 2, name: 'DCC', role: 'dcc', businessUnitId: 1 });
    userJwt = jwtService.sign({ id: 3, name: 'User', role: 'user', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaService.user.findUnique.mockResolvedValue({ deletedAt: null });
    mockPrismaService.adminLog.findMany.mockResolvedValue([fakeLog]);
    mockPrismaService.adminLog.count.mockResolvedValue(1);
    mockAdminLogService.write.mockResolvedValue(undefined);
  });

  // ---- GET /api/admin-logs (with module filter) ----
  describe('GET /api/admin-logs', () => {
    it('returns 200 for admin (any module)', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/admin-logs?module=DEPARTMENT')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);

      expect(res.body).toHaveProperty('logs');
      expect(res.body).toHaveProperty('pagination');
    });

    it('returns 200 for DCC reading MEMO_TYPE', async () => {
      await request(app.getHttpServer())
        .get('/api/admin-logs?module=MEMO_TYPE')
        .set('Authorization', `Bearer ${dccJwt}`)
        .expect(200);
    });

    it('returns 403 for DCC reading DEPARTMENT', async () => {
      await request(app.getHttpServer())
        .get('/api/admin-logs?module=DEPARTMENT')
        .set('Authorization', `Bearer ${dccJwt}`)
        .expect(403);
    });

    it('returns 403 for regular user', async () => {
      await request(app.getHttpServer())
        .get('/api/admin-logs?module=MEMO_TYPE')
        .set('Authorization', `Bearer ${userJwt}`)
        .expect(403);
    });

    it('returns 401 without token', async () => {
      await request(app.getHttpServer())
        .get('/api/admin-logs')
        .expect(401);
    });

    it('returns formatted createdAtFormatted in response', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/admin-logs?module=DEPARTMENT')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);

      expect(res.body.logs[0]).toHaveProperty('createdAtFormatted');
      expect(typeof res.body.logs[0].createdAtFormatted).toBe('string');
    });
  });

  // ---- GET /api/admin-logs/all ----
  describe('GET /api/admin-logs/all', () => {
    it('returns 200 for admin', async () => {
      await request(app.getHttpServer())
        .get('/api/admin-logs/all')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
    });

    it('returns 403 for DCC', async () => {
      await request(app.getHttpServer())
        .get('/api/admin-logs/all')
        .set('Authorization', `Bearer ${dccJwt}`)
        .expect(403);
    });

    it('returns 403 for regular user', async () => {
      await request(app.getHttpServer())
        .get('/api/admin-logs/all')
        .set('Authorization', `Bearer ${userJwt}`)
        .expect(403);
    });
  });

  // ---- POST /api/admin-logs ----
  describe('POST /api/admin-logs', () => {
    it('returns 200 and calls adminLog.write for admin', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/admin-logs')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ actionType: 'TEST', module: 'DEPARTMENT' })
        .expect(200);

      expect(res.body).toEqual({ success: true });
      expect(mockAdminLogService.write).toHaveBeenCalledWith(
        1, 'TEST', 'DEPARTMENT', null, null, null,
      );
    });

    it('returns 403 for DCC', async () => {
      await request(app.getHttpServer())
        .post('/api/admin-logs')
        .set('Authorization', `Bearer ${dccJwt}`)
        .send({ actionType: 'TEST', module: 'MEMO_TYPE' })
        .expect(403);
    });

    it('returns 400 when actionType is missing', async () => {
      await request(app.getHttpServer())
        .post('/api/admin-logs')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ module: 'DEPARTMENT' })
        .expect(400);
    });
  });
});
