/**
 * MemoPdfService (Nest) — memo PDF downloads.
 * Ported from backend/src/services/memoPdf.service.ts.
 *
 *   merged → main PDFs + signatures/stamps (pdf.core), ?preview=1 for draft view
 *   raw    → main PDFs concatenated, no overlays
 *   main   → one uploaded main file as stored
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import * as fs from 'fs';
import * as path from 'path';
import contentDisposition = require('content-disposition');
import { PrismaService } from '../../prisma/prisma.service';
import { UPLOADS_DIR } from '../../common/upload/upload.config';
import { MemoAccessService } from '../memo-query/memo-access.service';
import { createPdfForDownload } from './pdf.core';

export type PdfResponse = { body: Buffer; contentDisposition: string };
export type MainFileResponse = { absolutePath: string; contentDisposition: string };

/** DB stores main files as "uploads/<name>" relative to UPLOADS_DIR (same rule as pdf.core). */
function resolveMainFile(filePath: string): string {
  const rel = String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^uploads\//i, '');
  return path.resolve(UPLOADS_DIR, rel);
}

@Injectable()
export class MemoPdfService {
  private readonly logger = new Logger(MemoPdfService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memoAccess: MemoAccessService,
  ) {}

  private async assertCanView(userId: number, memoId: number): Promise<void> {
    if (!(await this.memoAccess.canViewMemo(userId, memoId))) {
      throw new ForbiddenException({ error: 'Access denied' });
    }
  }

  // ── GET /api/memos/:id/download[/:filename] ─────────────────────────────

  async downloadMerged(
    userId: number,
    memoId: number,
    opts: { preview: boolean; inline: boolean },
  ): Promise<PdfResponse> {
    await this.assertCanView(userId, memoId);

    let merged: PDFDocument;
    try {
      merged = await createPdfForDownload(memoId, opts.preview);
    } catch (err: any) {
      if (err?.status === 404 || err?.message?.includes('No main PDF files found')) {
        throw new NotFoundException({
          error: 'ไม่พบไฟล์ PDF สำหรับบันทึกข้อความนี้ (ไฟล์อาจถูกลบออกจากระบบ)',
        });
      }
      this.logger.error(`downloadMergedPdf failed: ${err?.stack ?? err}`);
      throw new InternalServerErrorException({ error: 'Failed to generate PDF' });
    }

    const memoRow = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { memonumber: true, subject: true },
    });
    const baseRaw =
      memoRow?.memonumber && memoRow?.subject
        ? `${memoRow.memonumber}-${memoRow.subject}`
        : `memo-${memoId}`;
    const safeBase = baseRaw.replace(/[\r\n]/g, ' ').trim();

    return {
      body: Buffer.from(await merged.save()),
      contentDisposition: contentDisposition(`${safeBase}.pdf`, {
        type: opts.preview || opts.inline ? 'inline' : 'attachment',
      }),
    };
  }

  // ── GET /api/memos/:id/raw ──────────────────────────────────────────────

  async downloadRaw(userId: number, memoId: number): Promise<PdfResponse> {
    await this.assertCanView(userId, memoId);

    const files = await this.prisma.mainFile.findMany({
      where: { memoId },
      orderBy: { orderNo: 'asc' },
    });
    if (!files.length) {
      throw new NotFoundException({ error: 'No files found for this memo' });
    }

    try {
      const meta = await this.prisma.masterMemo.findUnique({
        where: { id: memoId },
        select: { memonumber: true, subject: true },
      });

      const merged = await PDFDocument.create();
      for (const f of files) {
        // Express resolved filePath against cwd, which only worked when cwd
        // happened to be the uploads parent; resolve under UPLOADS_DIR instead.
        const srcBytes = fs.readFileSync(resolveMainFile(f.filePath ?? ''));
        const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
        const pages = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      }

      const baseName = meta ? `${meta.memonumber}-${meta.subject}` : `Memo_${memoId}`;
      const fileName = `${baseName
        .replace(/[\r\n]/g, ' ')
        .replace(/[/\\?%*:|"<>]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180)}.pdf`;

      return {
        body: Buffer.from(await merged.save()),
        // Express wrote the raw (often Thai) name into filename="…", which Node
        // rejects as an invalid header → every Thai-subject memo got a 500.
        contentDisposition: contentDisposition(fileName, { type: 'inline' }),
      };
    } catch (err) {
      this.logger.error(`downloadRawPdf failed: ${(err as Error)?.stack ?? err}`);
      throw new InternalServerErrorException({ error: 'Failed to generate raw PDF' });
    }
  }

  // ── GET /api/memos/:id/pdf?fileId= ──────────────────────────────────────

  async getMainFile(userId: number, memoId: number, fileId?: number): Promise<MainFileResponse> {
    await this.assertCanView(userId, memoId);

    const target = await this.prisma.mainFile.findFirst({
      where: fileId !== undefined ? { memoId, id: fileId } : { memoId },
      orderBy: fileId !== undefined ? undefined : { orderNo: 'asc' },
      select: { id: true, filePath: true, fileName: true },
    });
    if (!target) {
      throw new NotFoundException({ error: 'File not found' });
    }

    const absolutePath = path.resolve(UPLOADS_DIR, path.basename(target.filePath ?? ''));
    if (!fs.existsSync(absolutePath)) {
      throw new NotFoundException({ error: 'File missing on disk' });
    }
    if (!absolutePath.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
      throw new ForbiddenException({ error: 'Access denied' });
    }

    return {
      absolutePath,
      contentDisposition: contentDisposition(target.fileName || `memo-${memoId}.pdf`, {
        type: 'inline',
        fallback: false,
      }),
    };
  }
}

export function parseMemoId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new BadRequestException({ error: 'Invalid memoId' });
  }
  return id;
}
