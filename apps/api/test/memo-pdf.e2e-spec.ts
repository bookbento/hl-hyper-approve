import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { PDFDocument } from 'pdf-lib';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService } from '../src/common/mail/mail.service';
import { MemoAccessService } from '../src/modules/memo-query/memo-access.service';

// pdf.core reads the shared Prisma client directly (no DI) — stub it here;
// its output is verified byte-for-byte against Express separately.
const createPdfForDownload = jest.fn();
jest.mock('../src/modules/memo-pdf/pdf.core', () => ({
  createPdfForDownload: (...args: unknown[]) => createPdfForDownload(...args),
}));

const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-pdf-e2e-'));
process.env['UPLOADS_DIR'] = uploadsDir;

async function onePagePdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  return Buffer.from(await doc.save());
}

describe('MemoPdf e2e (AppModule with Prisma mock)', () => {
  let app: INestApplication;
  let jwt: string;

  const mockPrisma: any = {
    masterMemo: { findUnique: jest.fn() },
    mainFile: { findMany: jest.fn(), findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };
  const mockAccess = { canViewMemo: jest.fn(), canViewMemoSimple: jest.fn() };

  beforeAll(async () => {
    fs.writeFileSync(path.join(uploadsDir, 'a.pdf'), await onePagePdf());
    fs.writeFileSync(path.join(uploadsDir, 'b.pdf'), await onePagePdf());

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(MailService)
      .useValue({ sendEmail: jest.fn() })
      .overrideProvider(MemoAccessService)
      .useValue(mockAccess)
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();
    jwt = moduleFixture.get(JwtService).sign({ id: 2, name: 'U', role: 'USER', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ deletedAt: null });
    mockAccess.canViewMemo.mockResolvedValue(true);
    mockPrisma.masterMemo.findUnique.mockResolvedValue({ memonumber: 'MN-1', subject: 'งบประมาณ' });
  });

  const get = (url: string) => request(app.getHttpServer()).get(url).set('Cookie', `refreshToken=${jwt}`);

  describe('GET /api/memos/:id/download', () => {
    it('requires auth', async () => {
      expect((await request(app.getHttpServer()).get('/api/memos/1/download')).status).toBe(401);
    });

    it('403s without memo access', async () => {
      mockAccess.canViewMemo.mockResolvedValue(false);
      const res = await get('/api/memos/1/download');
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Access denied' });
      expect(createPdfForDownload).not.toHaveBeenCalled();
    });

    it('400s for a bad id', async () => {
      expect((await get('/api/memos/abc/download')).status).toBe(400);
    });

    it('returns the merged PDF as an attachment named after the memo', async () => {
      createPdfForDownload.mockResolvedValue(await PDFDocument.load(await onePagePdf()));
      const res = await get('/api/memos/1/download');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('application/pdf');
      expect(res.headers['content-disposition']).toMatch(/^attachment;/);
      expect(res.headers['content-disposition']).toContain(encodeURIComponent('MN-1-งบประมาณ.pdf'));
      expect(createPdfForDownload).toHaveBeenCalledWith(1, false);
    });

    it('serves inline for preview=1 (draft render) and inline=1', async () => {
      createPdfForDownload.mockResolvedValue(await PDFDocument.load(await onePagePdf()));
      const preview = await get('/api/memos/1/download?preview=1');
      expect(preview.headers['content-disposition']).toMatch(/^inline;/);
      expect(createPdfForDownload).toHaveBeenLastCalledWith(1, true);

      const inline = await get('/api/memos/1/download/whatever.pdf?inline=1');
      expect(inline.status).toBe(200);
      expect(inline.headers['content-disposition']).toMatch(/^inline;/);
      expect(createPdfForDownload).toHaveBeenLastCalledWith(1, false);
    });

    it('404s with the Thai message when the memo has no main PDFs', async () => {
      createPdfForDownload.mockRejectedValue(Object.assign(new Error('No main PDF files found'), { status: 404 }));
      const res = await get('/api/memos/1/download');
      expect(res.status).toBe(404);
      expect(res.body.error).toContain('ไม่พบไฟล์ PDF');
    });
  });

  describe('GET /api/memos/:id/raw', () => {
    it('concatenates main files resolved under UPLOADS_DIR', async () => {
      mockPrisma.mainFile.findMany.mockResolvedValue([
        { filePath: 'uploads/a.pdf' },
        { filePath: 'b.pdf' },
      ]);
      const res = await get('/api/memos/1/raw').buffer(true).parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
      expect(res.status).toBe(200);
      expect((await PDFDocument.load(res.body)).getPageCount()).toBe(2);
      // Thai subject: ASCII fallback + RFC 5987 filename* (Express 500'd here)
      expect(res.headers['content-disposition']).toBe(
        `inline; filename="MN-1-????????.pdf"; filename*=UTF-8''${encodeURIComponent('MN-1-งบประมาณ.pdf')}`,
      );
    });

    it('404s when the memo has no files', async () => {
      mockPrisma.mainFile.findMany.mockResolvedValue([]);
      const res = await get('/api/memos/1/raw');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'No files found for this memo' });
    });
  });

  describe('GET /api/memos/:id/pdf', () => {
    it('streams the requested main file inline', async () => {
      mockPrisma.mainFile.findFirst.mockResolvedValue({ id: 5, filePath: 'uploads/a.pdf', fileName: 'ไฟล์.pdf' });
      const res = await get('/api/memos/1/pdf?fileId=5');
      expect(res.status).toBe(200);
      expect(mockPrisma.mainFile.findFirst.mock.calls[0][0].where).toEqual({ memoId: 1, id: 5 });
      expect(res.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('ไฟล์.pdf')}`);
      expect(res.headers['access-control-expose-headers']).toBe('Content-Disposition');
    });

    it('400s for a bad fileId and 404s for a missing file on disk', async () => {
      expect((await get('/api/memos/1/pdf?fileId=x')).status).toBe(400);
      mockPrisma.mainFile.findFirst.mockResolvedValue({ id: 5, filePath: 'uploads/gone.pdf', fileName: null });
      const res = await get('/api/memos/1/pdf');
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'File missing on disk' });
    });
  });
});
