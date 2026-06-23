import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

describe('CcGroup e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;

  const fakeGroup = {
    id: 1,
    name: 'My CC Group',
    ownerId: 2,
    members: [],
    updatedAt: new Date(),
  };

  const mockPrismaService = {
    ccGroup: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    ccGroupMember: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
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
    mockAdminLogService.write.mockResolvedValue(undefined);
  });

  // ---- GET /api/cc-groups/search ----
  describe('GET /api/cc-groups/search', () => {
    it('returns 200 for any authenticated user', async () => {
      mockPrismaService.ccGroup.findMany.mockResolvedValue([]);
      await request(app.getHttpServer())
        .get('/api/cc-groups/search?q=test')
        .set('Authorization', `Bearer ${userJwt}`)
        .expect(200);
    });

    it('returns 401 without token', async () => {
      await request(app.getHttpServer())
        .get('/api/cc-groups/search')
        .expect(401);
    });
  });

  // ---- GET /api/cc-groups ----
  describe('GET /api/cc-groups', () => {
    it('returns 200 for admin (all groups)', async () => {
      mockPrismaService.ccGroup.findMany.mockResolvedValue([fakeGroup]);
      await request(app.getHttpServer())
        .get('/api/cc-groups')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
    });

    it('returns 401 without token', async () => {
      await request(app.getHttpServer())
        .get('/api/cc-groups')
        .expect(401);
    });
  });

  // ---- POST /api/cc-groups ----
  describe('POST /api/cc-groups', () => {
    it('returns 201 for admin/dcc', async () => {
      mockPrismaService.ccGroup.create.mockResolvedValue({ ...fakeGroup, members: [] });
      mockPrismaService.user.findMany.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .post('/api/cc-groups')
        .set('Authorization', `Bearer ${dccJwt}`)
        .send({ name: 'New Group' })
        .expect(201);

      expect(res.body).toMatchObject({ name: 'My CC Group' });
    });

    it('returns 403 for regular user', async () => {
      await request(app.getHttpServer())
        .post('/api/cc-groups')
        .set('Authorization', `Bearer ${userJwt}`)
        .send({ name: 'New Group' })
        .expect(403);
    });

    it('returns 400 when name is missing', async () => {
      await request(app.getHttpServer())
        .post('/api/cc-groups')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({})
        .expect(400);
    });
  });

  // ---- GET /api/cc-groups/:id ----
  describe('GET /api/cc-groups/:id', () => {
    it('returns 200 for admin', async () => {
      mockPrismaService.ccGroup.findUnique
        .mockResolvedValueOnce({ ownerId: 2 })
        .mockResolvedValueOnce({ id: 1, name: 'G', members: [] });

      await request(app.getHttpServer())
        .get('/api/cc-groups/1')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
    });

    it('returns 403 for regular user', async () => {
      await request(app.getHttpServer())
        .get('/api/cc-groups/1')
        .set('Authorization', `Bearer ${userJwt}`)
        .expect(403);
    });
  });

  // ---- PUT /api/cc-groups/:id ----
  describe('PUT /api/cc-groups/:id', () => {
    it('returns 200 for admin', async () => {
      mockPrismaService.ccGroup.findUnique
        .mockResolvedValueOnce({ ownerId: 1 })
        .mockResolvedValueOnce({ id: 1, name: 'Old' });
      mockPrismaService.ccGroup.update.mockResolvedValue({ id: 1, name: 'New Name' });

      const res = await request(app.getHttpServer())
        .put('/api/cc-groups/1')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ name: 'New Name' })
        .expect(200);

      expect(res.body).toMatchObject({ name: 'New Name' });
    });

    it('returns 403 for regular user', async () => {
      await request(app.getHttpServer())
        .put('/api/cc-groups/1')
        .set('Authorization', `Bearer ${userJwt}`)
        .send({ name: 'X' })
        .expect(403);
    });
  });

  // ---- DELETE /api/cc-groups/:id ----
  describe('DELETE /api/cc-groups/:id', () => {
    it('returns 200 for admin', async () => {
      mockPrismaService.ccGroup.findUnique
        .mockResolvedValueOnce({ ownerId: 1 })
        .mockResolvedValueOnce({ id: 1, name: 'G', members: [] });
      mockPrismaService.ccGroup.delete.mockResolvedValue({});

      const res = await request(app.getHttpServer())
        .delete('/api/cc-groups/1')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);

      expect(res.body).toEqual({ ok: true });
    });

    it('returns 403 for regular user', async () => {
      await request(app.getHttpServer())
        .delete('/api/cc-groups/1')
        .set('Authorization', `Bearer ${userJwt}`)
        .expect(403);
    });
  });

  // ---- PUT /api/cc-groups/:id/members ----
  describe('PUT /api/cc-groups/:id/members', () => {
    it('returns 200 for admin', async () => {
      mockPrismaService.ccGroup.findUnique.mockResolvedValue({ ownerId: 1 });
      mockPrismaService.ccGroupMember.findMany.mockResolvedValue([]);
      mockPrismaService.user.findMany.mockResolvedValue([]);
      mockPrismaService.ccGroupMember.count.mockResolvedValue(0);

      await request(app.getHttpServer())
        .put('/api/cc-groups/1/members')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ userIds: [] })
        .expect(200);
    });
  });
});
