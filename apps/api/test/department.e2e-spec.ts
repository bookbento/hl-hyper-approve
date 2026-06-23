import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

describe('Department e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;

  const mockDept = {
    id: 1,
    name: 'Engineering',
    abbreviation: 'ENG',
    businessUnitId: 1,
    businessUnit: { id: 1, name: 'BU1' },
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPrismaService = {
    department: {
      findMany: jest.fn().mockResolvedValue([mockDept]),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    businessUnit: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    adminLog: { create: jest.fn().mockResolvedValue({}) },
    user: {
      findUnique: jest.fn().mockResolvedValue({ deletedAt: null }),
    },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  const mockAdminLogService = {
    write: jest.fn().mockResolvedValue(undefined),
  };

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
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const jwtService = moduleFixture.get<JwtService>(JwtService);
    adminJwt = jwtService.sign({ id: 1, name: 'Admin', role: 'admin', businessUnitId: 1 });
    userJwt = jwtService.sign({ id: 99, name: 'User', role: 'user', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaService.user.findUnique.mockResolvedValue({ deletedAt: null });
    mockAdminLogService.write.mockResolvedValue(undefined);
  });

  // ---- GET /api/departments (public) ----
  describe('GET /api/departments', () => {
    it('returns 200 with list — no auth required', async () => {
      mockPrismaService.department.findMany.mockResolvedValue([mockDept]);

      const res = await request(app.getHttpServer())
        .get('/api/departments')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toMatchObject({ id: 1, name: 'Engineering' });
    });
  });

  // ---- GET /api/departments/archived ----
  describe('GET /api/departments/archived', () => {
    it('returns 200 for admin', async () => {
      mockPrismaService.department.findMany.mockResolvedValue([]);
      await request(app.getHttpServer())
        .get('/api/departments/archived')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
    });

    it('returns 401 without token', async () => {
      await request(app.getHttpServer())
        .get('/api/departments/archived')
        .expect(401);
    });

    it('returns 403 for non-admin (user id != param id)', async () => {
      // param :id defaults to "archived" → NaN → not self, not admin → 403
      await request(app.getHttpServer())
        .get('/api/departments/archived')
        .set('Authorization', `Bearer ${userJwt}`)
        .expect(403);
    });
  });

  // ---- GET /api/departments/:id ----
  describe('GET /api/departments/:id', () => {
    it('returns 200 for admin', async () => {
      mockPrismaService.department.findUnique.mockResolvedValue(mockDept);
      await request(app.getHttpServer())
        .get('/api/departments/1')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(200);
    });

    it('returns 404 when not found', async () => {
      mockPrismaService.department.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .get('/api/departments/999')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(404);
    });

    it('returns 401 without token', async () => {
      await request(app.getHttpServer())
        .get('/api/departments/1')
        .expect(401);
    });
  });

  // ---- POST /api/departments ----
  describe('POST /api/departments', () => {
    it('returns 201 and creates department for admin', async () => {
      mockPrismaService.department.create.mockResolvedValue(mockDept);

      const res = await request(app.getHttpServer())
        .post('/api/departments')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ name: 'Engineering', abbreviation: 'ENG' })
        .expect(201);

      expect(res.body).toMatchObject({ name: 'Engineering' });
      expect(mockAdminLogService.write).toHaveBeenCalledWith(
        1,
        'DEPARTMENT_CREATE',
        'DEPARTMENT',
        expect.any(Number),
        'Engineering',
        expect.any(Object),
      );
    });

    it('returns 400 when name is missing', async () => {
      await request(app.getHttpServer())
        .post('/api/departments')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ abbreviation: 'ENG' })
        .expect(400);
    });

    it('returns 403 for non-admin (isSelf=false, isAdmin=false)', async () => {
      await request(app.getHttpServer())
        .post('/api/departments')
        .set('Authorization', `Bearer ${userJwt}`)
        .send({ name: 'HR', abbreviation: 'HR' })
        .expect(403);
    });

    it('returns 401 without token', async () => {
      await request(app.getHttpServer())
        .post('/api/departments')
        .send({ name: 'HR', abbreviation: 'HR' })
        .expect(401);
    });
  });

  // ---- PUT /api/departments/:id ----
  describe('PUT /api/departments/:id', () => {
    it('returns 200 and updates department for admin', async () => {
      const updated = { ...mockDept, name: 'Updated' };
      mockPrismaService.department.findUnique.mockResolvedValue(mockDept);
      mockPrismaService.department.update.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .put('/api/departments/1')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ name: 'Updated', abbreviation: 'UPD' })
        .expect(200);

      expect(res.body).toMatchObject({ name: 'Updated' });
    });

    it('returns 404 when not found', async () => {
      mockPrismaService.department.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .put('/api/departments/999')
        .set('Authorization', `Bearer ${adminJwt}`)
        .send({ name: 'X', abbreviation: 'X' })
        .expect(404);
    });
  });

  // ---- DELETE /api/departments/:id ----
  describe('DELETE /api/departments/:id', () => {
    it('returns 204 and soft-deletes for admin', async () => {
      mockPrismaService.department.findUnique.mockResolvedValue(mockDept);
      mockPrismaService.department.update.mockResolvedValue({ ...mockDept, deletedAt: new Date() });

      await request(app.getHttpServer())
        .delete('/api/departments/1')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(204);
    });

    it('returns 404 when not found', async () => {
      mockPrismaService.department.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .delete('/api/departments/999')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(404);
    });
  });

  // ---- PUT /api/departments/restore/:id ----
  describe('PUT /api/departments/restore/:id', () => {
    it('returns 204 and restores for admin', async () => {
      const archived = { ...mockDept, deletedAt: new Date() };
      mockPrismaService.department.findUnique.mockResolvedValue(archived);
      mockPrismaService.department.update.mockResolvedValue({ ...archived, deletedAt: null });

      await request(app.getHttpServer())
        .put('/api/departments/restore/1')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(204);
    });

    it('returns 400 when department is not archived', async () => {
      mockPrismaService.department.findUnique.mockResolvedValue(mockDept);
      await request(app.getHttpServer())
        .put('/api/departments/restore/1')
        .set('Authorization', `Bearer ${adminJwt}`)
        .expect(400);
    });
  });
});
