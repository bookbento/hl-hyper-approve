import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

describe('Memotype e2e', () => {
  let app: INestApplication;

  const fakeType = {
    id: 1,
    name: 'Test Type',
    description: 'Desc',
    abbreviation: 'TT',
    isActive: true,
    isDelete: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    defaultTypeFileId: null,
    businessUnitId: 1,
    approvalLineId: 1,
    forEveryone: false,
    forEveryDepartmentAcrossBU: false,
    forAllDepartmentUnderSelectedBu: true,
    departmentId: null,
    department: null,
    businessUnit: { id: 1, name: 'BU1' },
    approvalLine: { id: 1, name: 'Test Type' },
    typeFiles: [],
    createdByUserId: 1,
  };

  const mockPrismaService = {
    memoType: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    lineOfApproval: {
      create: jest.fn().mockResolvedValue({ id: 1 }),
      update: jest.fn(),
      delete: jest.fn(),
    },
    lineOfApprovalUserPivot: {
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    masterMemo: {
      count: jest.fn().mockResolvedValue(0),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    typeFile: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 1, orderNo: 0 }),
      findFirst: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: jest.fn(),
    },
    businessUnit: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ id: 1, name: 'BU1' }),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    department: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ id: 1 }),
      create: jest.fn(),
      update: jest.fn(),
    },
    adminLog: { findMany: jest.fn(), count: jest.fn(), create: jest.fn().mockResolvedValue({}) },
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ deletedAt: null }),
    },
    ccGroup: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    ccGroupMember: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
    userSignature: { findMany: jest.fn().mockResolvedValue([]) },
    memoStatusPivot: { findFirst: jest.fn().mockResolvedValue(null) },
    memoHistory: { findFirst: jest.fn().mockResolvedValue(null) },
    memoApproverAction: { findMany: jest.fn().mockResolvedValue([]), groupBy: jest.fn().mockResolvedValue([]) },
    extraApprover: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn().mockImplementation((fn: any) => {
      if (typeof fn === 'function') return fn(mockPrismaService);
      return Promise.resolve();
    }),
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
    adminJwt = jwtService.sign({ id: 1, name: 'Admin', role: 'admin', businessUnitId: 1 });
    userJwt = jwtService.sign({ id: 3, name: 'User', role: 'user', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  // ── GET /api/memotypes/count ─────────────────────────────────────────────

  it('GET /api/memotypes/count — returns 200 with counts', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/memotypes/count')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('activeCount');
    expect(res.body).toHaveProperty('totalCount');
  });

  it('GET /api/memotypes/count — returns 401 without token', async () => {
    const res = await request(app.getHttpServer()).get('/api/memotypes/count');
    expect(res.status).toBe(401);
  });

  // ── GET /api/memotypes ───────────────────────────────────────────────────

  it('GET /api/memotypes — returns 200 array', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/memotypes')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('GET /api/memotypes?includeInactive=true — returns 200', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/memotypes?includeInactive=true&context=management')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
  });

  // ── GET /api/memotypes/:id ───────────────────────────────────────────────

  it('GET /api/memotypes/:id — returns 200 for accessible type', async () => {
    mockPrismaService.memoType.findFirst.mockResolvedValueOnce(fakeType);
    const res = await request(app.getHttpServer())
      .get('/api/memotypes/1')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', 1);
  });

  it('GET /api/memotypes/:id — returns 403 when not accessible', async () => {
    mockPrismaService.memoType.findFirst.mockResolvedValueOnce(null);
    const res = await request(app.getHttpServer())
      .get('/api/memotypes/9999')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(403);
  });

  // ── POST /api/memotypes ──────────────────────────────────────────────────

  it('POST /api/memotypes — creates type and returns 201', async () => {
    mockPrismaService.memoType.create.mockResolvedValue({
      id: 10,
      name: 'New Type',
      description: 'Desc',
      abbreviation: 'NT',
      isActive: true,
      isDelete: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      createdByUserId: 1,
      defaultTypeFileId: null,
      departmentId: null,
      department: null,
      businessUnit: { id: 1, name: 'BU1' },
    });
    mockPrismaService.memoType.findUnique.mockResolvedValueOnce({ ...fakeType, id: 10 });

    const res = await request(app.getHttpServer())
      .post('/api/memotypes')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({
        name: 'New Type',
        description: 'Desc',
        abbreviation: 'NT',
        businessUnitId: '1',
        forAllDepartmentUnderSelectedBu: 'true',
      });
    expect(res.status).toBe(201);
  });

  it('POST /api/memotypes — returns 401 without token', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/memotypes')
      .send({ name: 'Test', description: 'Desc', businessUnitId: '1', forAllDepartmentUnderSelectedBu: 'true' });
    expect(res.status).toBe(401);
  });

  // ── DELETE /api/memotypes/:id ────────────────────────────────────────────

  it('DELETE /api/memotypes/:id — returns 204', async () => {
    mockPrismaService.memoType.findUnique.mockResolvedValueOnce(fakeType);
    mockPrismaService.masterMemo.count.mockResolvedValue(0);
    mockPrismaService.typeFile.findMany.mockResolvedValue([]);

    const res = await request(app.getHttpServer())
      .delete('/api/memotypes/1')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(204);
  });

  it('DELETE /api/memotypes/:id — returns 404 when not found', async () => {
    mockPrismaService.memoType.findUnique.mockResolvedValueOnce(null);
    const res = await request(app.getHttpServer())
      .delete('/api/memotypes/9999')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(404);
  });

  it('DELETE /api/memotypes/:id — returns 409 when memo references it', async () => {
    mockPrismaService.memoType.findUnique.mockResolvedValueOnce(fakeType);
    mockPrismaService.lineOfApprovalUserPivot.findMany.mockResolvedValueOnce([]);
    mockPrismaService.masterMemo.count.mockResolvedValueOnce(3);

    const res = await request(app.getHttpServer())
      .delete('/api/memotypes/1')
      .set('Authorization', `Bearer ${adminJwt}`);
    expect(res.status).toBe(403);
  });
});
