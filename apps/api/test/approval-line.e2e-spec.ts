import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

describe('ApprovalLine e2e', () => {
  let app: INestApplication;

  const fakeApprovalLine = {
    id: 1,
    name: 'Test Line',
    approvalUsers: [
      {
        level: 0,
        isSigReq: false,
        slotType: 'FIXED_USER',
        roleDescription: null,
        approvalRequirement: 'ALL',
        user: { id: 10, name: 'Alice', lastname: null, nickname: null },
      },
    ],
  };

  const mockPrismaService = {
    department: { findMany: jest.fn().mockResolvedValue([]) },
    lineOfApproval: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn().mockResolvedValue(fakeApprovalLine),
      update: jest.fn(),
      delete: jest.fn().mockResolvedValue({ id: 1, name: 'Test Line' }),
    },
    lineOfApprovalUserPivot: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    masterMemo: {
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    memoStatusPivot: { findFirst: jest.fn().mockResolvedValue(null) },
    memoHistory: { findFirst: jest.fn().mockResolvedValue(null) },
    memoApproverAction: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    extraApprover: { findMany: jest.fn().mockResolvedValue([]) },
    memoType: { findMany: jest.fn().mockResolvedValue([]) },
    businessUnit: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    adminLog: { findMany: jest.fn(), count: jest.fn(), create: jest.fn().mockResolvedValue({}) },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ deletedAt: null }),
    },
    typeFile: { findMany: jest.fn().mockResolvedValue([]) },
    ccGroup: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    ccGroupMember: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    userSignature: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockImplementation((fn: any) => {
      if (typeof fn === 'function') return fn(mockPrismaService);
      return Promise.resolve();
    }),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const mockAdminLogService = { write: jest.fn().mockResolvedValue(undefined) };

  let adminJwt: string;

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
    adminJwt = jwtService.sign({ id: 1, name: 'Admin', role: 'admin', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  // ── GET /api/teams ──────────────────────────────────────────────────────────

  it('GET /api/teams — returns 200 for authenticated user', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/teams')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/teams — returns 401 without token', async () => {
    const res = await request(app.getHttpServer()).get('/api/teams');
    expect(res.status).toBe(401);
  });

  // ── POST /api/approval-lines ────────────────────────────────────────────────

  it('POST /api/approval-lines — creates approval line with 201', async () => {
    // Setup: create returns minimal, then findUnique returns full line
    mockPrismaService.lineOfApproval.create.mockResolvedValueOnce({ id: 1, name: 'Test Line' });
    mockPrismaService.lineOfApprovalUserPivot.createMany.mockResolvedValueOnce({ count: 1 });
    mockPrismaService.lineOfApproval.findUnique.mockResolvedValueOnce(fakeApprovalLine);
    const res = await request(app.getHttpServer())
      .post('/api/approval-lines')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        name: 'Test Line',
        levels: [{ users: [{ id: 10, isSigReq: false, slotType: 'FIXED_USER' }] }],
      });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name', 'Test Line');
  });

  it('POST /api/approval-lines — returns 400 when name is missing', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/approval-lines')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ levels: [] });
    expect(res.status).toBe(400);
  });

  it('POST /api/approval-lines — returns 401 without token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/approval-lines')
      .send({ name: 'Test', levels: [] });
    expect(res.status).toBe(401);
  });

  // ── DELETE /api/approval-lines/:id ─────────────────────────────────────────

  it('DELETE /api/approval-lines/:id — returns 204', async () => {
    const res = await request(app.getHttpServer())
      .delete('/api/approval-lines/1')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(204);
  });

  // ── GET /api/memos/:id/approvers ────────────────────────────────────────────

  it('GET /api/memos/:id/approvers — returns 200 for valid memo', async () => {
    mockPrismaService.masterMemo.findUnique.mockResolvedValueOnce({ id: 1 });
    mockPrismaService.lineOfApproval.findFirst.mockResolvedValueOnce({
      id: 1,
      approvalUsers: [
        { level: 0, user: { id: 5, name: 'Bob', lastname: null, nickname: null } },
      ],
    });

    const res = await request(app.getHttpServer())
      .get('/api/memos/1/approvers')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/memos/:id/approvers — returns 404 for non-existent memo', async () => {
    mockPrismaService.masterMemo.findUnique.mockResolvedValueOnce(null);

    const res = await request(app.getHttpServer())
      .get('/api/memos/9999/approvers')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(404);
  });

  // ── GET /api/memos/:id/approval-line ───────────────────────────────────────

  it('GET /api/memos/:id/approval-line — returns 200', async () => {
    mockPrismaService.memoApproverAction.findMany.mockResolvedValueOnce([]);

    const res = await request(app.getHttpServer())
      .get('/api/memos/1/approval-line')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('memoId');
    expect(res.body).toHaveProperty('levels');
  });

  // ── GET /api/approval-requests/my ──────────────────────────────────────────

  it('GET /api/approval-requests/my — returns 200 with items array', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/approval-requests/my')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    expect(Array.isArray(res.body.items)).toBe(true);
  });
});
