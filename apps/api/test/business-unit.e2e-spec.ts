import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';

/**
 * E2E integration test for /api/business-units
 * Uses NestJS testing module — mocks PrismaService to avoid DB dependency.
 * Verifies behavior parity with Express controller.
 */
describe('BusinessUnit e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;

  const mockBu = { id: 1, name: 'TestBU', abbreviation: 'TBU', createdAt: new Date(), updatedAt: new Date(), departments: [] };

  const mockPrismaService = {
    businessUnit: {
      findMany: jest.fn().mockResolvedValue([mockBu]),
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    adminLog: { create: jest.fn().mockResolvedValue({}) },
    user: {
      findUnique: jest.fn().mockResolvedValue({ deletedAt: null }),
    },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };

  let jwtToken: string;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(mockPrismaService)
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // Generate a valid JWT for protected endpoints
    const jwtService = moduleFixture.get<JwtService>(JwtService);
    jwtToken = jwtService.sign({
      id: 1,
      name: 'Admin',
      role: 'admin',
      businessUnitId: 1,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaService.user.findUnique.mockResolvedValue({ deletedAt: null });
    mockPrismaService.businessUnit.findFirst.mockResolvedValue(null);
    mockPrismaService.adminLog.create.mockResolvedValue({});
  });

  // ---- GET /api/business-units (public) ----
  describe('GET /api/business-units', () => {
    it('returns list without auth', async () => {
      mockPrismaService.businessUnit.findMany.mockResolvedValue([mockBu]);

      const res = await request(app.getHttpServer())
        .get('/api/business-units')
        .expect(200);

      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body[0]).toMatchObject({ id: 1, name: 'TestBU' });
    });
  });

  // ---- GET /api/business-units/:id (public) ----
  describe('GET /api/business-units/:id', () => {
    it('returns 200 when found', async () => {
      mockPrismaService.businessUnit.findUnique.mockResolvedValue(mockBu);

      const res = await request(app.getHttpServer())
        .get('/api/business-units/1')
        .expect(200);

      expect(res.body).toMatchObject({ id: 1, name: 'TestBU' });
    });

    it('returns 404 when not found', async () => {
      mockPrismaService.businessUnit.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .get('/api/business-units/999')
        .expect(404);
    });
  });

  // ---- POST /api/business-units (admin|dcc only) ----
  describe('POST /api/business-units', () => {
    it('returns 401 without auth token', async () => {
      await request(app.getHttpServer())
        .post('/api/business-units')
        .send({ name: 'New BU' })
        .expect(401);
    });

    it('returns 201 and creates business unit with valid admin JWT', async () => {
      mockPrismaService.businessUnit.findUnique.mockResolvedValue(null); // no duplicate
      const created = { id: 2, name: 'New BU', abbreviation: null, createdAt: new Date(), updatedAt: new Date() };
      mockPrismaService.businessUnit.create.mockResolvedValue(created);

      const res = await request(app.getHttpServer())
        .post('/api/business-units')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({ name: 'New BU' })
        .expect(201);

      expect(res.body).toMatchObject({ name: 'New BU' });
    });

    it('returns 409 when name already exists', async () => {
      mockPrismaService.businessUnit.findUnique.mockResolvedValue({ id: 1, name: 'Existing' });

      await request(app.getHttpServer())
        .post('/api/business-units')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({ name: 'Existing' })
        .expect(409);
    });

    it('returns 400 when name is missing', async () => {
      await request(app.getHttpServer())
        .post('/api/business-units')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({ abbreviation: 'X' })
        .expect(400);
    });

    it('returns 403 when role is not admin or dcc', async () => {
      const jwtService = app.get<JwtService>(JwtService);
      const userToken = jwtService.sign({ id: 2, name: 'User', role: 'user', businessUnitId: 1 });

      await request(app.getHttpServer())
        .post('/api/business-units')
        .set('Authorization', `Bearer ${userToken}`)
        .send({ name: 'X' })
        .expect(403);
    });
  });

  // ---- PUT /api/business-units/:id ----
  describe('PUT /api/business-units/:id', () => {
    it('returns 401 without auth', async () => {
      await request(app.getHttpServer())
        .put('/api/business-units/1')
        .send({ name: 'Updated' })
        .expect(401);
    });

    it('returns 200 on successful update', async () => {
      const existing = { id: 1, name: 'Old', abbreviation: null };
      const updated = { id: 1, name: 'Updated', abbreviation: null };
      mockPrismaService.businessUnit.findUnique.mockResolvedValue(existing);
      mockPrismaService.businessUnit.findFirst.mockResolvedValue(null);
      mockPrismaService.businessUnit.update.mockResolvedValue(updated);

      const res = await request(app.getHttpServer())
        .put('/api/business-units/1')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({ name: 'Updated' })
        .expect(200);

      expect(res.body).toMatchObject({ name: 'Updated' });
    });

    it('returns 404 when target not found', async () => {
      mockPrismaService.businessUnit.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .put('/api/business-units/999')
        .set('Authorization', `Bearer ${jwtToken}`)
        .send({ name: 'X' })
        .expect(404);
    });
  });

  // ---- DELETE /api/business-units/:id ----
  describe('DELETE /api/business-units/:id', () => {
    it('returns 401 without auth', async () => {
      await request(app.getHttpServer())
        .delete('/api/business-units/1')
        .expect(401);
    });

    it('returns 204 on successful delete', async () => {
      const existing = { id: 1, name: 'ToDelete', abbreviation: null };
      mockPrismaService.businessUnit.findUnique.mockResolvedValue(existing);
      mockPrismaService.businessUnit.delete.mockResolvedValue(existing);

      await request(app.getHttpServer())
        .delete('/api/business-units/1')
        .set('Authorization', `Bearer ${jwtToken}`)
        .expect(204);
    });

    it('returns 404 when not found', async () => {
      mockPrismaService.businessUnit.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .delete('/api/business-units/99')
        .set('Authorization', `Bearer ${jwtToken}`)
        .expect(404);
    });
  });
});
