import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';

describe('Notification e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;

  const fakeNoti = {
    id: 10,
    userId: 1,
    isRead: false,
    createdAt: new Date('2024-01-01'),
    type: { name: 'approval' },
    memo: { id: 5, subject: 'Test', memonumber: 'M001' },
    status: { name: 'Pending' },
    comment: null,
    actor: { id: 2, name: 'Actor', profileImagePath: 'avatar.png' },
  };

  const mockPrismaService = {
    notification: {
      findMany: jest.fn().mockResolvedValue([fakeNoti]),
      count: jest.fn().mockResolvedValue(3),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    // Other models needed by other modules wired in AppModule
    ccGroup: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
    ccGroupMember: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0), deleteMany: jest.fn().mockResolvedValue({ count: 0 }), createMany: jest.fn().mockResolvedValue({ count: 0 }) },
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
    userJwt = jwtService.sign({
      id: 1,
      name: 'Test User',
      role: 'USER',
      businessUnitId: 1,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrismaService.notification.findMany.mockResolvedValue([fakeNoti]);
    mockPrismaService.notification.count.mockResolvedValue(3);
    mockPrismaService.notification.updateMany.mockResolvedValue({ count: 1 });
    mockPrismaService.notification.deleteMany.mockResolvedValue({ count: 2 });
    mockPrismaService.user.findUnique.mockResolvedValue({ deletedAt: null });
  });

  describe('GET /api/notifications', () => {
    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).get('/api/notifications');
      expect(res.status).toBe(401);
    });

    it('returns notifications list with items and nextCursor', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/notifications?limit=10')
        .set('Cookie', `refreshToken=${userJwt}`);

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('items');
      expect(res.body).toHaveProperty('nextCursor');
      expect(Array.isArray(res.body.items)).toBe(true);
    });

    it('includes profileImageUrl in actor', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/notifications')
        .set('Cookie', `refreshToken=${userJwt}`);

      expect(res.status).toBe(200);
      expect(res.body.items[0].actor.profileImageUrl).toBe('/uploads/avatar.png');
    });

    it('passes unreadOnly filter', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/notifications?unreadOnly=true')
        .set('Cookie', `refreshToken=${userJwt}`);

      // unreadOnly=true should return 200; the filter is applied in service
      expect(res.status).toBe(200);
      expect(mockPrismaService.notification.findMany).toHaveBeenCalled();
    });
  });

  describe('GET /api/notifications/unread-count', () => {
    it('returns unread count', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/notifications/unread-count')
        .set('Cookie', `refreshToken=${userJwt}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ count: 3 });
    });

    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).get('/api/notifications/unread-count');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/notifications/mark-all-read', () => {
    it('marks all notifications as read', async () => {
      mockPrismaService.notification.updateMany.mockResolvedValue({ count: 5 });

      const res = await request(app.getHttpServer())
        .patch('/api/notifications/mark-all-read')
        .set('Cookie', `refreshToken=${userJwt}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: 5 });
    });

    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).patch('/api/notifications/mark-all-read');
      expect(res.status).toBe(401);
    });
  });

  describe('PATCH /api/notifications/:id/mark-read', () => {
    it('marks a single notification as read', async () => {
      const res = await request(app.getHttpServer())
        .patch('/api/notifications/10/mark-read')
        .set('Cookie', `refreshToken=${userJwt}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ updated: true });
    });

    it('returns 404 when notification not found', async () => {
      mockPrismaService.notification.updateMany.mockResolvedValue({ count: 0 });

      const res = await request(app.getHttpServer())
        .patch('/api/notifications/999/mark-read')
        .set('Cookie', `refreshToken=${userJwt}`);

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/notifications/clear-read', () => {
    it('deletes all read notifications', async () => {
      const res = await request(app.getHttpServer())
        .delete('/api/notifications/clear-read')
        .set('Cookie', `refreshToken=${userJwt}`);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ deleted: 2 });
    });

    it('returns 401 without auth', async () => {
      const res = await request(app.getHttpServer()).delete('/api/notifications/clear-read');
      expect(res.status).toBe(401);
    });
  });
});
