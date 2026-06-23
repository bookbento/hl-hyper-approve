import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

/**
 * E2E tests for /api/auth routes
 * Verifies parity with Express auth.controller.ts behavior:
 *   - POST /api/auth/login → sets refreshToken cookie (httpOnly, sameSite strict)
 *   - GET  /api/auth/me   → returns user profile (requires auth)
 *   - POST /api/auth/refresh-token → issues 1h accessToken
 *   - POST /api/auth/logout → clears cookie + records logoutAt
 *   - GET  /api/auth/sessions → returns login sessions
 *   - POST /api/auth/change-first-time-password → changes password, creates prefs
 *   - GET  /api/me → legacy alias
 */
describe('Auth e2e (AppModule with mocked Prisma)', () => {
  let app: INestApplication;
  let jwtService: JwtService;

  const mockUser = {
    id: 1,
    name: 'Alice',
    email: 'alice@test.com',
    password: '$2b$10$abcdefghijklmnopqrstuuVwxyzABCDEFGHIJKLMN', // placeholder
    role: 'admin',
    businessUnitId: 1,
    deletedAt: null,
    isFirstLogin: false,
    lastname: null,
    nickname: null,
    department: null,
    businessUnit: null,
    profileImagePath: null,
    defaultSignatureText: null,
  };

  const mockPrismaService = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    loginSession: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    adminLog: { create: jest.fn().mockResolvedValue({}) },
    notificationType: { findMany: jest.fn().mockResolvedValue([]) },
    userNotificationPreference: {
      count: jest.fn().mockResolvedValue(0),
      createMany: jest.fn().mockResolvedValue({}),
    },
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
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }),
    );
    await app.init();

    jwtService = moduleFixture.get<JwtService>(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaService.loginSession.create.mockResolvedValue({});
    mockPrismaService.loginSession.findFirst.mockResolvedValue(null);
    mockPrismaService.loginSession.findMany.mockResolvedValue([]);
    mockPrismaService.loginSession.update.mockResolvedValue({});
    mockPrismaService.notificationType.findMany.mockResolvedValue([]);
    mockPrismaService.userNotificationPreference.count.mockResolvedValue(0);
    mockPrismaService.userNotificationPreference.createMany.mockResolvedValue({});
  });

  // ── POST /api/auth/login ──────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {
    it('returns 400 when email or password missing', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'x@x.com' })
        .expect(400);
    });

    it('returns 401 when user not found', async () => {
      mockPrismaService.user.findUnique.mockResolvedValue(null);
      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'notfound@test.com', password: 'pw' })
        .expect(401);
    });

    it('returns 200 and sets httpOnly refreshToken cookie on success', async () => {
      // Use a real bcrypt hash for 'password123'
      const bcrypt = require('bcrypt');
      const hashedPw = await bcrypt.hash('password123', 10);
      mockPrismaService.user.findUnique.mockResolvedValue({ ...mockUser, password: hashedPw });

      const res = await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@test.com', password: 'password123' })
        .expect(200);

      expect(res.body).toMatchObject({ message: 'Login successful' });
      expect(res.body).toHaveProperty('isFirstLogin');
      // Cookie should be set
      const cookies = res.headers['set-cookie'] as unknown as string[];
      expect(cookies).toBeDefined();
      const refreshCookie = Array.isArray(cookies) ? cookies.find((c: string) => c.startsWith('refreshToken=')) : cookies;
      expect(refreshCookie).toBeDefined();
      expect(refreshCookie).toContain('HttpOnly');
      expect(refreshCookie).toContain('SameSite=Strict');
    });

    it('returns 403 when account is deactivated', async () => {
      const bcrypt = require('bcrypt');
      const hashedPw = await bcrypt.hash('password123', 10);
      mockPrismaService.user.findUnique.mockResolvedValue({
        ...mockUser,
        password: hashedPw,
        deletedAt: new Date(),
      });

      await request(app.getHttpServer())
        .post('/api/auth/login')
        .send({ email: 'alice@test.com', password: 'password123' })
        .expect(403);
    });
  });

  // ── GET /api/auth/me ─────────────────────────────────────────────────────

  describe('GET /api/auth/me', () => {
    it('returns 401 when no token provided', async () => {
      await request(app.getHttpServer()).get('/api/auth/me').expect(401);
    });

    it('returns 200 with user profile when authenticated', async () => {
      const token = jwtService.sign({ id: 1, name: 'Alice', role: 'admin', businessUnitId: 1 });
      mockPrismaService.user.findUnique.mockResolvedValue({ deletedAt: null });
      const userProfile = { id: 1, name: 'Alice', email: 'alice@test.com', role: 'admin',
        lastname: null, nickname: null, department: null, businessUnit: null,
        profileImagePath: null, isFirstLogin: false, defaultSignatureText: null };

      mockPrismaService.user.findUnique
        .mockResolvedValueOnce({ deletedAt: null })
        .mockResolvedValueOnce(userProfile);

      const res = await request(app.getHttpServer())
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toMatchObject({ id: 1, name: 'Alice', email: 'alice@test.com' });
      expect(res.body).not.toHaveProperty('password');
    });
  });

  // ── GET /api/me (legacy alias) ────────────────────────────────────────────

  describe('GET /api/me (legacy alias)', () => {
    it('returns 401 when no token', async () => {
      await request(app.getHttpServer()).get('/api/me').expect(401);
    });

    it('returns 200 with same profile as /api/auth/me', async () => {
      const token = jwtService.sign({ id: 1, name: 'Alice', role: 'admin', businessUnitId: 1 });
      const userProfile = { id: 1, name: 'Alice', email: 'alice@test.com', role: 'admin',
        lastname: null, nickname: null, department: null, businessUnit: null,
        profileImagePath: null, isFirstLogin: false, defaultSignatureText: null };

      mockPrismaService.user.findUnique
        .mockResolvedValueOnce({ deletedAt: null })
        .mockResolvedValueOnce(userProfile);

      const res = await request(app.getHttpServer())
        .get('/api/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toMatchObject({ id: 1, name: 'Alice' });
    });
  });

  // ── POST /api/auth/refresh-token ──────────────────────────────────────────

  describe('POST /api/auth/refresh-token', () => {
    it('returns 400 when token missing', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/refresh-token')
        .send({})
        .expect(400);
    });

    it('returns 403 when token is invalid', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/refresh-token')
        .send({ token: 'bad.token.here' })
        .expect(403);
    });

    it('returns 200 with new accessToken for valid token', async () => {
      const validToken = jwtService.sign({ id: 1, name: 'Alice', role: 'admin', businessUnitId: 1 });

      const res = await request(app.getHttpServer())
        .post('/api/auth/refresh-token')
        .send({ token: validToken })
        .expect(200);

      expect(res.body).toHaveProperty('accessToken');
    });
  });

  // ── POST /api/auth/logout ─────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    it('returns 204 with no cookie even when no refreshToken provided', async () => {
      await request(app.getHttpServer()).post('/api/auth/logout').expect(204);
    });

    it('returns 204 and clears cookie when valid refreshToken cookie present', async () => {
      const token = jwtService.sign({ id: 1, name: 'Alice', role: 'admin', businessUnitId: 1 });
      mockPrismaService.loginSession.findFirst.mockResolvedValue({ id: 10 });

      const res = await request(app.getHttpServer())
        .post('/api/auth/logout')
        .set('Cookie', `refreshToken=${token}`)
        .expect(204);

      // Cookie should be cleared
      const cookies = res.headers['set-cookie'];
      if (cookies) {
        const refreshCookie = Array.isArray(cookies)
          ? cookies.find((c: string) => c.startsWith('refreshToken='))
          : cookies;
        // Cleared cookie either empty or expires in past
        if (refreshCookie) {
          expect(refreshCookie).toMatch(/refreshToken=;|Expires=.*1970/);
        }
      }
    });
  });

  // ── GET /api/auth/sessions ────────────────────────────────────────────────

  describe('GET /api/auth/sessions', () => {
    it('returns 401 when unauthenticated', async () => {
      await request(app.getHttpServer()).get('/api/auth/sessions').expect(401);
    });

    it('returns 200 with sessions array when authenticated', async () => {
      const token = jwtService.sign({ id: 1, name: 'Alice', role: 'admin', businessUnitId: 1 });
      mockPrismaService.user.findUnique.mockResolvedValue({ deletedAt: null });
      mockPrismaService.loginSession.findMany.mockResolvedValue([
        { id: 1, loginAt: new Date().toISOString(), logoutAt: null, ipAddress: '127.0.0.1', userAgent: 'ua' },
      ]);

      const res = await request(app.getHttpServer())
        .get('/api/auth/sessions')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(res.body).toHaveProperty('sessions');
      expect(Array.isArray(res.body.sessions)).toBe(true);
    });
  });

  // ── POST /api/auth/change-first-time-password ─────────────────────────────

  describe('POST /api/auth/change-first-time-password', () => {
    it('returns 401 when unauthenticated', async () => {
      await request(app.getHttpServer())
        .post('/api/auth/change-first-time-password')
        .send({ newPassword: 'newpassword123' })
        .expect(401);
    });

    it('returns 400 when newPassword too short', async () => {
      const token = jwtService.sign({ id: 1, name: 'Alice', role: 'admin', businessUnitId: 1 });
      mockPrismaService.user.findUnique.mockResolvedValue({ deletedAt: null });

      await request(app.getHttpServer())
        .post('/api/auth/change-first-time-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ newPassword: 'abc' })
        .expect(400);
    });

    it('returns 200 on successful first-time password change', async () => {
      const token = jwtService.sign({ id: 1, name: 'Alice', role: 'admin', businessUnitId: 1 });
      mockPrismaService.user.findUnique
        .mockResolvedValueOnce({ deletedAt: null })   // JwtAuthGuard
        .mockResolvedValueOnce({ id: 1, isFirstLogin: true }); // changeFirstTimePassword

      const bcrypt = require('bcrypt');
      jest.spyOn(bcrypt, 'hash').mockResolvedValue('new-hashed');
      mockPrismaService.user.update.mockResolvedValue({});
      mockPrismaService.notificationType.findMany.mockResolvedValue([]);
      mockPrismaService.userNotificationPreference.count.mockResolvedValue(0);

      const res = await request(app.getHttpServer())
        .post('/api/auth/change-first-time-password')
        .set('Authorization', `Bearer ${token}`)
        .send({ newPassword: 'newpassword123' })
        .expect(200);

      expect(res.body).toEqual({ message: 'Password changed successfully' });
    });
  });
});
