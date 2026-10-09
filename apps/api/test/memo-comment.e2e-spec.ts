import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService } from '../src/common/mail/mail.service';
import { AdminLogService } from '../src/common/admin-log/admin-log.service';
import { MemoAccessService } from '../src/modules/memo-query/memo-access.service';

// Uploads land in a temp dir; upload.config reads UPLOADS_DIR at import time,
// so AppModule is required only after this is set.
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-comment-e2e-'));
process.env['UPLOADS_DIR'] = uploadsDir;

describe('MemoComment + MemoPosition e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;
  let jwt: string;

  const mockPrisma: any = {
    memoStatusPivot: { findFirst: jest.fn() },
    comment: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn(), delete: jest.fn() },
    commentAttachment: { create: jest.fn() },
    commentTag: { createMany: jest.fn() },
    memoHistory: { create: jest.fn() },
    masterMemo: { findUnique: jest.fn() },
    notification: { createMany: jest.fn() },
    user: { findMany: jest.fn(), findUnique: jest.fn() },
    signaturePosition: { create: jest.fn() },
    datePosition: { create: jest.fn() },
    notePosition: { create: jest.fn() },
    notificationType: { findUnique: jest.fn() },
    userNotificationPreference: { findMany: jest.fn() },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };
  const mockMail = { sendEmail: jest.fn().mockResolvedValue(undefined) };
  const mockAccess = { canViewMemo: jest.fn(), canViewMemoSimple: jest.fn() };

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(MailService)
      .useValue(mockMail)
      .overrideProvider(MemoAccessService)
      .useValue(mockAccess)
      .overrideProvider(AdminLogService)
      .useValue({ write: jest.fn() })
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
    await app.init();

    jwt = moduleFixture.get(JwtService).sign({ id: 2, name: 'Actor', role: 'USER', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ deletedAt: null });
    mockAccess.canViewMemo.mockResolvedValue(true);
    mockPrisma.user.findMany.mockResolvedValue([{ name: 'Tagged', lastname: null, nickname: null }]);
    mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ status: { id: 1, name: 'Draft' } });
    mockPrisma.comment.create.mockResolvedValue({ id: 50 });
    mockPrisma.comment.findUnique.mockResolvedValue({
      id: 50,
      comment: 'hi',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      user: { id: 2, name: 'Actor', lastname: null, profileImagePath: null },
      attachments: [{ id: 1, url: '/uploads/comments/x.pdf', filename: 'x.pdf', mimetype: 'application/pdf' }],
    });
  });

  const auth = (r: request.Test) => r.set('Cookie', `refreshToken=${jwt}`);

  describe('comments', () => {
    it('requires auth', async () => {
      const res = await request(app.getHttpServer()).get('/api/memos/9/comments');
      expect(res.status).toBe(401);
    });

    it('400s with the Express error body for a non-numeric memo id', async () => {
      const res = await auth(request(app.getHttpServer()).get('/api/memos/abc/comments'));
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid memo ID' });
    });

    it('403s for a memo the user cannot see', async () => {
      mockAccess.canViewMemo.mockResolvedValue(false);
      const get = await auth(request(app.getHttpServer()).get('/api/memos/9/comments'));
      expect(get.status).toBe(403);
      expect(get.body).toEqual({ error: 'Access denied' });
      const post = await auth(request(app.getHttpServer()).post('/api/memos/9/comments')).field('content', 'hi');
      expect(post.status).toBe(403);
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    });

    it('lists comments', async () => {
      mockPrisma.comment.findMany.mockResolvedValue([]);
      const res = await auth(request(app.getHttpServer()).get('/api/memos/9/comments'));
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it('400s when there is neither text nor a file', async () => {
      const res = await auth(request(app.getHttpServer()).post('/api/memos/9/comments')).field('content', '   ');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Comment or attachment is required' });
    });

    it('creates a comment with an uploaded file stored under uploads/comments', async () => {
      const res = await auth(request(app.getHttpServer()).post('/api/memos/9/comments'))
        .field('content', 'hi')
        .field('mentionUserIds', '[3]')
        .attach('files', Buffer.from('%PDF-1.4'), { filename: 'my doc.pdf', contentType: 'application/pdf' });

      expect(res.status).toBe(201);
      expect(res.body.attachments[0].url).toMatch(/\/uploads\/comments\/x\.pdf$/);

      const stored = mockPrisma.commentAttachment.create.mock.calls[0][0].data;
      expect(stored.url).toMatch(/^\/uploads\/comments\/\d+-my_doc\.pdf$/);
      expect(stored.filename).toBe('my doc.pdf');
      expect(fs.existsSync(path.join(uploadsDir, 'comments', stored.url.split('/').pop()))).toBe(true);
      expect(mockPrisma.commentTag.createMany).toHaveBeenCalled();
    });

    it('rejects an unsupported file type', async () => {
      const res = await auth(request(app.getHttpServer()).post('/api/memos/9/comments'))
        .attach('files', Buffer.from('MZ'), { filename: 'evil.exe', contentType: 'application/x-msdownload' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('UNSUPPORTED_FILE_TYPE');
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    });

    it('rejects more than 6 files', async () => {
      let req = auth(request(app.getHttpServer()).post('/api/memos/9/comments'));
      for (let i = 0; i < 7; i++) {
        req = req.attach('files', Buffer.from('x'), { filename: `f${i}.png`, contentType: 'image/png' });
      }
      const res = await req;
      expect(res.status).toBe(400);
      expect(mockPrisma.comment.create).not.toHaveBeenCalled();
    });

    it('deletes a comment with mentions → 204', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({
        memoId: 9,
        userId: 2,
        comment: 'ping',
        tags: [{ userId: 3 }],
        memo: { subject: 'S', memonumber: null, userId: 2 },
        user: { name: 'Actor', lastname: null },
      });
      mockPrisma.user.findMany.mockResolvedValue([]);
      mockPrisma.notificationType.findUnique.mockResolvedValue(null);

      const res = await auth(request(app.getHttpServer()).delete('/api/comments/50'));
      expect(res.status).toBe(204);
      expect(mockPrisma.comment.delete).toHaveBeenCalledWith({ where: { id: 50 } });
    });

    it('403s deleting a comment without mentions', async () => {
      mockPrisma.comment.findUnique.mockResolvedValue({ memoId: 9, userId: 2, tags: [], memo: {}, user: {} });
      const res = await auth(request(app.getHttpServer()).delete('/api/comments/50'));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Only comments with mentions can be deleted.' });
    });
  });

  describe('positions', () => {
    it('saves a signature position', async () => {
      mockPrisma.signaturePosition.create.mockResolvedValue({ id: 1 });
      const body = { memoId: 9, fileId: 1, userId: 2, page: 1, x: 0.5, y: 0.25 };
      const res = await auth(request(app.getHttpServer()).post('/api/memos/signature')).send(body);
      expect(res.status).toBe(201);
      expect(mockPrisma.signaturePosition.create).toHaveBeenCalledWith({ data: body });
    });

    it('saves a date position with a parsed date', async () => {
      mockPrisma.datePosition.create.mockResolvedValue({ id: 1 });
      const res = await auth(request(app.getHttpServer()).post('/api/memos/date')).send({
        memoId: 9, fileId: 1, userId: 2, page: 1, x: 0, y: 0, date: '2026-02-03',
      });
      expect(res.status).toBe(201);
      expect(mockPrisma.datePosition.create.mock.calls[0][0].data.date).toEqual(new Date('2026-02-03'));
    });

    it('saves a note position', async () => {
      mockPrisma.notePosition.create.mockResolvedValue({ id: 1 });
      const res = await auth(request(app.getHttpServer()).post('/api/memos/note')).send({
        memoId: 9, fileId: 1, page: 1, x: 0, y: 0, text: 'n',
      });
      expect(res.status).toBe(201);
    });
  });
});
