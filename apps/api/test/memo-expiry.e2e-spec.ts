import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService } from '../src/common/mail/mail.service';
import { MemoExpiryService } from '../src/modules/memo-expiry/memo-expiry.service';
import { MemoExpiryScheduler } from '../src/modules/memo-expiry/memo-expiry.scheduler';

describe('MemoExpiry e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;
  let adminJwt: string;
  let userJwt: string;

  const mockPrisma: any = {
    masterMemo: { update: jest.fn() },
    memoHistory: { deleteMany: jest.fn() },
    user: { findUnique: jest.fn() },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };
  const mockExpiry = { sweepOnce: jest.fn() };

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(MailService)
      .useValue({ sendEmail: jest.fn() })
      .overrideProvider(MemoExpiryService)
      .useValue(mockExpiry)
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();
    const jwt = moduleFixture.get(JwtService);
    adminJwt = jwt.sign({ id: 1, name: 'A', role: 'ADMIN', businessUnitId: 1 });
    userJwt = jwt.sign({ id: 2, name: 'U', role: 'USER', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ deletedAt: null });
    mockExpiry.sweepOnce.mockResolvedValue(undefined);
  });

  const post = (url: string, jwt?: string) => {
    const r = request(app.getHttpServer()).post(url);
    return jwt ? r.set('Cookie', `refreshToken=${jwt}`) : r;
  };

  it('the cron is off under e2e (setup-env) so boot did not sweep', () => {
    expect(MemoExpiryScheduler.isEnabled()).toBe(false);
    expect(mockExpiry.sweepOnce).not.toHaveBeenCalled();
  });

  describe('/api/dev/expiry/*', () => {
    it('requires login and the admin role (Express had no auth)', async () => {
      expect((await post('/api/dev/expiry/run')).status).toBe(401);
      expect((await post('/api/dev/expiry/run', userJwt)).status).toBe(403);
      expect(mockExpiry.sweepOnce).not.toHaveBeenCalled();
    });

    it('POST run sweeps with pretendNow', async () => {
      const res = await post('/api/dev/expiry/run', adminJwt).send({
        pretendNow: '2026-10-20T03:00:00.000Z',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(mockExpiry.sweepOnce).toHaveBeenCalledWith(new Date('2026-10-20T03:00:00.000Z'));
    });

    it('POST set/:memoId with mode=date sets 23:59:59.999Z of that day', async () => {
      mockPrisma.masterMemo.update.mockResolvedValue({});
      const res = await post('/api/dev/expiry/set/7', adminJwt).send({ mode: 'date', date: '2026-12-31' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, memoId: 7, expiresAt: '2026-12-31T23:59:59.999Z' });
      expect(mockPrisma.masterMemo.update).toHaveBeenCalledWith({
        where: { id: 7 },
        data: { expiresAt: new Date('2026-12-31T23:59:59.999Z') },
      });
    });

    it('POST reset/:memoId forgets sent reminders', async () => {
      const res = await post('/api/dev/expiry/reset/7', adminJwt);
      expect(res.status).toBe(200);
      expect(mockPrisma.memoHistory.deleteMany).toHaveBeenCalledWith({
        where: { memoId: 7, action: { contains: '[expiry:' } },
      });
    });

    it('rejects a non-numeric memoId', async () => {
      expect((await post('/api/dev/expiry/reset/abc', adminJwt)).status).toBe(400);
    });
  });
});
