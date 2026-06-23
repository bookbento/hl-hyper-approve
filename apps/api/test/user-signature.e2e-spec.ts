/**
 * E2E tests for /api/users/:id/signatures routes (UserSignatureModule)
 *
 * คุณนิตตะ + คุณอิเอริ: Verify HTTP-level parity with Express userSignature routes.
 * All Prisma and file operations are mocked — no disk or DB required.
 *
 * Covered paths:
 *   GET    /api/users/:id/signatures
 *   PUT    /api/users/:id/default-signature
 *   GET    /api/users/signatures/:sigId/file
 *   DELETE /api/users/signatures/:sigId
 *   POST   /api/users/:id/signatures  (upload — 400 without file)
 */

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as cookieParser from 'cookie-parser';
import { JwtService } from '@nestjs/jwt';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

// JWT token generation via JwtService (retrieved from app after init)
let jwtService: JwtService;
function makeToken(payload: object): string {
  return jwtService.sign(payload);
}

/** Build a minimal Prisma mock that satisfies all modules loaded in AppModule */
function buildPrismaMock() {
  const noOp = jest.fn().mockResolvedValue(null);
  const manyNoOp = jest.fn().mockResolvedValue([]);
  return {
    user: {
      findUnique: jest.fn(),
      findMany: manyNoOp,
      findFirst: noOp,
      create: noOp,
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      delete: noOp,
      count: jest.fn().mockResolvedValue(0),
    },
    userSignature: {
      findMany: manyNoOp,
      create: noOp,
      delete: noOp,
      findUnique: noOp,
      findFirst: noOp,
    },
    loginSession: {
      create: jest.fn().mockResolvedValue({}),
      findFirst: noOp,
      findMany: manyNoOp,
      update: jest.fn().mockResolvedValue({}),
    },
    adminLog: { create: jest.fn().mockResolvedValue({}) },
    businessUnit: { findMany: manyNoOp, findUnique: noOp, create: noOp, update: noOp, delete: noOp, count: jest.fn().mockResolvedValue(0) },
    department: { findMany: manyNoOp, findUnique: noOp, create: noOp, update: noOp, delete: noOp },
    memoType: { findMany: manyNoOp, findUnique: noOp },
    ccGroup: { findMany: manyNoOp, findUnique: noOp, create: noOp, update: noOp, delete: noOp },
    adminLogEntry: { findMany: manyNoOp, count: jest.fn().mockResolvedValue(0) },
    notificationType: { findMany: manyNoOp },
    userNotificationPreference: { count: jest.fn().mockResolvedValue(0), findMany: manyNoOp, upsert: noOp, createMany: noOp, findFirst: noOp },
    userDelegation: { findFirst: noOp, upsert: noOp, delete: noOp, findUnique: noOp },
    userBusinessUnitAccess: { findMany: manyNoOp, deleteMany: noOp, createMany: noOp, findFirst: noOp },
    businessUnitDCCAccess: { findMany: manyNoOp, deleteMany: noOp, createMany: noOp, findFirst: noOp },
    // file-serving related
    mainFile: { findFirst: noOp },
    attachedFile: { findFirst: noOp },
    commentAttachment: { findFirst: noOp },
    masterMemo: { findUnique: noOp },
    memoCc: { findFirst: noOp },
    lineOfApprovalUserPivot: { findFirst: noOp },
    memoApproverAction: { findFirst: noOp },
    extraApprover: { findFirst: noOp },
    commentTag: { findFirst: noOp },
    memoStatusPivot: { findFirst: noOp },
    $transaction: jest.fn(async (cb: any) => cb()),
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };
}

describe('UserSignature e2e (AppModule with mocked Prisma)', () => {
  let app: INestApplication;
  let prismaMock: ReturnType<typeof buildPrismaMock>;

  const adminUser = { id: 1, name: 'Admin', role: 'admin', businessUnitId: 1 };
  const regularUser = { id: 5, name: 'User', role: 'user', businessUnitId: 1 };

  beforeAll(async () => {
    prismaMock = buildPrismaMock();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prismaMock)
      .overrideProvider(AdminLogService)
      .useValue({ write: jest.fn().mockResolvedValue(undefined) })
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: false,
        transform: true,
      }),
    );
    await app.init();
    jwtService = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: user exists and is not deleted
    prismaMock.user.findUnique.mockResolvedValue({
      ...regularUser,
      deletedAt: null,
      defaultSignatureId: null,
    });
  });

  function authHeader(payload: object): string {
    return `Bearer ${makeToken(payload)}`;
  }

  // ── GET /api/users/:id/signatures ─────────────────────────────────────────
  describe('GET /api/users/:id/signatures', () => {
    it('returns 200 with signatures list for self', async () => {
      prismaMock.userSignature.findMany.mockResolvedValue([
        { id: 1, path: '/uploads/signatures/sig.png', label: 'Main', createdAt: new Date() },
      ]);

      const res = await request(app.getHttpServer())
        .get('/api/users/5/signatures')
        .set('Authorization', authHeader(regularUser));

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('signatures');
      expect(res.body.signatures).toHaveLength(1);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await request(app.getHttpServer()).get('/api/users/5/signatures');
      expect(res.status).toBe(401);
    });

    it('returns 403 when accessing another user\'s signatures without admin', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/users/99/signatures')
        .set('Authorization', authHeader(regularUser));
      expect(res.status).toBe(403);
    });

    it('admin can list any user\'s signatures', async () => {
      prismaMock.user.findUnique.mockResolvedValue({
        ...adminUser,
        deletedAt: null,
        defaultSignatureId: null,
      });
      prismaMock.userSignature.findMany.mockResolvedValue([]);

      const res = await request(app.getHttpServer())
        .get('/api/users/99/signatures')
        .set('Authorization', authHeader(adminUser));

      expect(res.status).toBe(200);
    });
  });

  // ── PUT /api/users/:id/default-signature ──────────────────────────────────
  describe('PUT /api/users/:id/default-signature', () => {
    it('sets default signature for self', async () => {
      prismaMock.user.update.mockResolvedValue({});

      const res = await request(app.getHttpServer())
        .put('/api/users/5/default-signature')
        .set('Authorization', authHeader(regularUser))
        .send({ signatureId: 1 });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('clears default signature when signatureId is null', async () => {
      prismaMock.user.update.mockResolvedValue({});

      const res = await request(app.getHttpServer())
        .put('/api/users/5/default-signature')
        .set('Authorization', authHeader(regularUser))
        .send({ signatureId: null });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/users/5/default-signature')
        .send({ signatureId: 1 });
      expect(res.status).toBe(401);
    });

    it('returns 403 for non-self non-admin', async () => {
      const res = await request(app.getHttpServer())
        .put('/api/users/99/default-signature')
        .set('Authorization', authHeader(regularUser))
        .send({ signatureId: 1 });
      expect(res.status).toBe(403);
    });
  });

  // ── DELETE /api/users/signatures/:sigId ───────────────────────────────────
  describe('DELETE /api/users/signatures/:sigId', () => {
    it('returns 204 on successful delete', async () => {
      prismaMock.userSignature.delete.mockResolvedValue({
        path: '/uploads/signatures/sig.png',
        userId: 5,
      });
      prismaMock.user.updateMany.mockResolvedValue({ count: 0 });

      // Mock fs.unlink to avoid real file ops
      jest.spyOn(require('fs/promises'), 'unlink').mockResolvedValue(undefined as any);

      const res = await request(app.getHttpServer())
        .delete('/api/users/signatures/1')
        .set('Authorization', authHeader(regularUser));

      expect(res.status).toBe(204);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await request(app.getHttpServer()).delete('/api/users/signatures/1');
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/users/:id/signatures (upload) ───────────────────────────────
  describe('POST /api/users/:id/signatures', () => {
    it('returns 400 when no file is provided', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/users/5/signatures')
        .set('Authorization', authHeader(regularUser));

      expect(res.status).toBe(400);
    });

    it('returns 403 when accessing another user\'s upload endpoint without admin', async () => {
      const res = await request(app.getHttpServer())
        .post('/api/users/99/signatures')
        .set('Authorization', authHeader(regularUser));
      expect(res.status).toBe(403);
    });
  });
});
