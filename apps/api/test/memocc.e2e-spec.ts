import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

describe('MemoCc e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;

  const fakeMemo = { id: 10, userId: 2 };
  const fakeCcRow = {
    user: { id: 5, name: 'Bob', lastname: 'Smith', nickname: null, email: 'bob@test.com', profileImagePath: null },
    createdAt: new Date('2024-01-01'),
  };

  const mockPrismaService = {
    masterMemo: {
      findUnique: jest.fn().mockResolvedValue(fakeMemo),
      findMany: jest.fn().mockResolvedValue([]),
    },
    memoCc: {
      findMany: jest.fn().mockResolvedValue([fakeCcRow]),
      create: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    memoApproverAction: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    lineOfApprovalUserPivot: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    ccGroupMember: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    // Other models for AppModule
    notification: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), updateMany: jest.fn(), deleteMany: jest.fn() },
    ccGroup: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    lineOfApproval: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn().mockResolvedValue({ name: 'Test' }), update: jest.fn() },
    memoType: { findMany: jest.fn().mockResolvedValue([]) },
    department: { findMany: jest.fn(), findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
    businessUnit: { findMany: jest.fn(), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    adminLog: { findMany: jest.fn(), count: jest.fn(), create: jest.fn().mockResolvedValue({}) },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ deletedAt: null }),
    },
    $transaction: jest.fn().mockImplementation((fn: any) => fn(mockPrismaService)),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const mockAdminLogService = { write: jest.fn().mockResolvedValue(undefined) };

  let ownerJwt: string;  // userId=2 is owner of fakeMemo
  let otherJwt: string;  // userId=3 is not owner

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
    ownerJwt = jwtService.sign({ id: 2, name: 'Owner', role: 'USER', businessUnitId: 1 });
    otherJwt = jwtService.sign({ id: 3, name: 'Other', role: 'USER', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaService.masterMemo.findUnique.mockResolvedValue(fakeMemo);
    mockPrismaService.memoCc.findMany.mockResolvedValue([fakeCcRow]);
    mockPrismaService.memoApproverAction.findMany.mockResolvedValue([]);
    mockPrismaService.memoApproverAction.findFirst.mockResolvedValue(null);
    mockPrismaService.user.findUnique.mockResolvedValue({ deletedAt: null });
  });

  describe('GET /api/memos/cc/me', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).get('/api/memos/cc/me');
      expect(res.status).toBe(401);
    });

    it('returns array of memos CC to me', async () => {
      mockPrismaService.masterMemo.findMany.mockResolvedValue([]);
      const res = await request(app.getHttpServer())
        .get('/api/memos/cc/me')
        .set('Cookie', `refreshToken=${ownerJwt}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('GET /api/memos/:id/cc', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).get('/api/memos/10/cc');
      expect(res.status).toBe(401);
    });

    it('returns 404 when memo not found', async () => {
      mockPrismaService.masterMemo.findUnique.mockResolvedValue(null);
      const res = await request(app.getHttpServer())
        .get('/api/memos/999/cc')
        .set('Cookie', `refreshToken=${ownerJwt}`);
      expect(res.status).toBe(404);
    });

    it('returns CC list with users, groups, groupIds', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/memos/10/cc')
        .set('Cookie', `refreshToken=${ownerJwt}`);
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('users');
      expect(res.body).toHaveProperty('groups');
      expect(res.body).toHaveProperty('groupIds');
    });
  });

  describe('PUT /api/memos/:id/cc', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).put('/api/memos/10/cc').send({ userIds: [], groupIds: [] });
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-owner', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/memos/10/cc')
        .set('Cookie', `refreshToken=${otherJwt}`)
        .send({ userIds: [5], groupIds: [] });
      expect(res.status).toBe(403);
    });

    it('returns 200 for memo owner', async () => {
      mockPrismaService.memoCc.findMany.mockResolvedValue([]);
      const res = await request(app.getHttpServer())
        .put('/api/memos/10/cc')
        .set('Cookie', `refreshToken=${ownerJwt}`)
        .send({ userIds: [5], groupIds: [] });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('memoId', 10);
    });
  });

  describe('POST /api/memos/:id/cc/:userId', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).post('/api/memos/10/cc/5');
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-owner', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/memos/10/cc/5')
        .set('Cookie', `refreshToken=${otherJwt}`);
      expect(res.status).toBe(403);
    });

    it('returns 201 when adding CC successfully', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/memos/10/cc/5')
        .set('Cookie', `refreshToken=${ownerJwt}`);
      expect(res.status).toBe(201);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns 400 when adding owner as CC', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/memos/10/cc/2')  // userId=2 is owner
        .set('Cookie', `refreshToken=${ownerJwt}`);
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/memos/:id/cc/:userId', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).delete('/api/memos/10/cc/5');
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-owner', async () => {
      const res = await request(app.getHttpServer())
        .delete('/api/memos/10/cc/5')
        .set('Cookie', `refreshToken=${otherJwt}`);
      expect(res.status).toBe(403);
    });

    it('returns 200 when owner removes CC', async () => {
      const res = await request(app.getHttpServer())
        .delete('/api/memos/10/cc/5')
        .set('Cookie', `refreshToken=${ownerJwt}`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });
});
