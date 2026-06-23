import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

describe('LOA Management e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;

  const mockPrismaService = {
    lineOfApprovalUserPivot: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    lineOfApproval: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ name: 'Test Line' }),
      update: jest.fn().mockResolvedValue({}),
    },
    memoType: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, name: 'Admin', deletedAt: null }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    ccGroupMember: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    // Other models needed by AppModule
    notification: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), updateMany: jest.fn(), deleteMany: jest.fn() },
    ccGroup: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    department: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    businessUnit: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    adminLog: { findMany: jest.fn(), count: jest.fn(), create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(mockPrismaService)),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const mockAdminLogService = { write: jest.fn().mockResolvedValue(undefined) };

  let adminJwt: string;
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
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
    );
    await app.init();

    const jwtService = moduleFixture.get<JwtService>(JwtService);
    adminJwt = jwtService.sign({ id: 1, name: 'Admin', role: 'ADMIN', businessUnitId: 1 });
    userJwt = jwtService.sign({ id: 3, name: 'User', role: 'USER', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaService.user.findUnique.mockResolvedValue({ id: 1, name: 'Admin', deletedAt: null });
    mockPrismaService.lineOfApproval.findUnique.mockResolvedValue({ name: 'Test Line' });
    mockPrismaService.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
    mockPrismaService.lineOfApproval.findMany.mockResolvedValue([]);
  });

  describe('GET /api/approver-lines', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).get('/api/approver-lines');
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin/dcc user', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/approver-lines')
        .set('Cookie', `refreshToken=${userJwt}`);
      expect(res.status).toBe(403);
    });

    it('returns array for admin', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/approver-lines')
        .set('Cookie', `refreshToken=${adminJwt}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/approver-lines/:userId', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).get('/api/approver-lines/5');
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin/dcc user', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/approver-lines/5')
        .set('Cookie', `refreshToken=${userJwt}`);
      expect(res.status).toBe(403);
    });

    it('returns empty array when no lines found', async () => {
      mockPrismaService.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);
      const res = await request(app.getHttpServer())
        .get('/api/approver-lines/5')
        .set('Cookie', `refreshToken=${adminJwt}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('POST /api/approvers/bulk-update', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).post('/api/approvers/bulk-update').send({});
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-admin/dcc user', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/approvers/bulk-update')
        .set('Cookie', `refreshToken=${userJwt}`)
        .send({ fromUserId: 1, action: 'replace', toUserId: 2 });
      expect(res.status).toBe(403);
    });

    it('returns 400 for missing fromUserId', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/approvers/bulk-update')
        .set('Cookie', `refreshToken=${adminJwt}`)
        .send({ action: 'replace', toUserId: 2 });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/approvers/replace', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).post('/api/approvers/replace').send({});
      expect(res.status).toBe(401);
    });

    it('returns 403 for regular user', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/approvers/replace')
        .set('Cookie', `refreshToken=${userJwt}`)
        .send({ fromUserId: 1, toUserId: 2 });
      expect(res.status).toBe(403);
    });
  });

  describe('PUT /api/approver-lines/:id', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).put('/api/approver-lines/1').send({ slots: [] });
      expect(res.status).toBe(401);
    });

    it('returns 403 for regular user', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/approver-lines/1')
        .set('Cookie', `refreshToken=${userJwt}`)
        .send({ slots: [] });
      expect(res.status).toBe(403);
    });

    it('saves empty slots for admin', async () => {
      mockPrismaService.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .put('/api/approver-lines/1')
        .set('Cookie', `refreshToken=${adminJwt}`)
        .send({ slots: [] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, saved: 0 });
    });
  });

  describe('POST /api/approval-lines/:id/update-approvers (legacy alias)', () => {
    it('returns 200 for admin with empty slots', async () => {
      mockPrismaService.lineOfApprovalUserPivot.findMany.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .post('/api/approval-lines/1/update-approvers')
        .set('Cookie', `refreshToken=${adminJwt}`)
        .send({ slots: [] });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, saved: 0 });
    });
  });
});
