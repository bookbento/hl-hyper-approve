/**
 * MemoLifecycleController (Nest)
 *
 * Handles Batch 6b WRITE/lifecycle endpoints:
 *   POST   /api/memos               — createMemo
 *   PUT    /api/memos/:id           — updateMemo
 *   DELETE /api/memos/:id           — deleteMemo (soft)
 *   DELETE /api/memos/:id/force     — forceDeleteMemo (hard)
 *   POST   /api/memos/:id/renew-expiry — renewExpiry
 *   POST   /api/memos/:id/upload-main  — uploadMainPDF
 *
 * Path ordering: specific paths (upload-main, renew-expiry, force) are declared
 * BEFORE the :id wildcard to prevent shadowing.
 *
 * File uploads: FileFieldsInterceptor (create/update) and FileInterceptor
 * (upload-main) write to the same UPLOADS_DIR as Express.
 *
 * Security (คุณอิเอริ):
 *   - JwtAuthGuard on all endpoints.
 *   - actorId from JWT payload (never from body) for sensitive ops.
 *   - File validation: PDF MIME + extension whitelist via fileFilter.
 *   - No arbitrary field access from body in controller — all delegated to service.
 */

import {
  Controller,
  Post,
  Put,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
  UseInterceptors,
  UploadedFiles,
  UploadedFile,
  HttpCode,
  HttpStatus,
  Req,
  BadRequestException,
} from '@nestjs/common';
import {
  FileFieldsInterceptor,
  FileInterceptor,
} from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import * as path from 'path';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MemoLifecycleService } from './memo-lifecycle.service';
import { RenewExpiryDto } from './dto/renew-expiry.dto';
import { UPLOADS_DIR } from '../../common/upload/upload.config';
import { Request } from 'express';

// ── Multer disk storage (mirrors backend/src/middlewares/upload.ts) ──────────

function sanitizeName(name: string): string {
  return name.normalize('NFC').replace(/[^\w.\-]+/g, '_');
}

const memoFilesStorage = diskStorage({
  destination: (_req, file, cb) => {
    const dest = file.fieldname === 'attachedFiles'
      ? path.join(UPLOADS_DIR, 'attached')
      : UPLOADS_DIR;
    cb(null, dest);
  },
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${sanitizeName(file.originalname)}`);
  },
});

const mainPdfStorage = diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${sanitizeName(file.originalname)}`);
  },
});

/**
 * File filter: accept PDF for main files; all doc types for attachments.
 * Mirrors Express fileFilter in backend/src/middlewares/upload.ts.
 */
function memoFileFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
): void {
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  if (file.fieldname === 'files') {
    if (file.mimetype !== 'application/pdf' && ext !== '.pdf') {
      return cb(new BadRequestException('Only PDF files are allowed for main files'), false);
    }
  }
  // attachedFiles: all doc types allowed (same as Express)
  cb(null, true);
}

// ─────────────────────────────────────────────────────────────────────────────

@UseGuards(JwtAuthGuard)
@Controller('api/memos')
export class MemoLifecycleController {
  constructor(private readonly lifecycleService: MemoLifecycleService) {}

  /**
   * POST /api/memos
   * Create a new memo with file uploads.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'files', maxCount: 50 },
        { name: 'attachedFiles', maxCount: 50 },
      ],
      { storage: memoFilesStorage, fileFilter: memoFileFilter },
    ),
  )
  async createMemo(
    @Body() body: Record<string, unknown>,
    @UploadedFiles()
    uploadedFiles: { files?: Express.Multer.File[]; attachedFiles?: Express.Multer.File[] } | undefined,
    @CurrentUser() actor: JwtPayload,
  ): Promise<unknown> {
    const files = {
      files: uploadedFiles?.files ?? [],
      attachedFiles: uploadedFiles?.attachedFiles ?? [],
    };
    return this.lifecycleService.createMemo({ body, files, actorId: actor.id });
  }

  /**
   * POST /api/memos/:id/upload-main
   * Add a main PDF to an existing memo.
   * MUST be declared before PUT /api/memos/:id.
   */
  @Post(':id/upload-main')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: mainPdfStorage,
      fileFilter: (_req, file, cb) => {
        const ext = (path.extname(file.originalname || '') || '').toLowerCase();
        if (file.mimetype !== 'application/pdf' && ext !== '.pdf') {
          return cb(new BadRequestException('Only PDF files are allowed'), false);
        }
        cb(null, true);
      },
    }),
  )
  async uploadMainPDF(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ): Promise<unknown> {
    if (!file) throw new BadRequestException('No file uploaded');
    return this.lifecycleService.uploadMainPDF(id, file);
  }

  /**
   * POST /api/memos/:id/renew-expiry
   */
  @Post(':id/renew-expiry')
  async renewExpiry(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RenewExpiryDto,
    @CurrentUser() actor: JwtPayload,
  ): Promise<unknown> {
    return this.lifecycleService.renewExpiry({
      memoId: id,
      actorId: actor.id,
      actorRole: actor.role ?? '',
      expiresAt: dto.expiresAt,
      targetStatus: dto.targetStatus,
    });
  }

  /**
   * PUT /api/memos/:id
   * Update memo fields, files, and approver list.
   */
  @Put(':id')
  @UseInterceptors(
    FileFieldsInterceptor(
      [
        { name: 'files', maxCount: 50 },
        { name: 'attachedFiles', maxCount: 50 },
      ],
      { storage: memoFilesStorage, fileFilter: memoFileFilter },
    ),
  )
  async updateMemo(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: Record<string, unknown>,
    @UploadedFiles()
    uploadedFiles: { files?: Express.Multer.File[]; attachedFiles?: Express.Multer.File[] } | undefined,
  ): Promise<unknown> {
    const files = {
      files: uploadedFiles?.files ?? [],
      attachedFiles: uploadedFiles?.attachedFiles ?? [],
    };
    return this.lifecycleService.updateMemo({ id, body, files });
  }

  /**
   * DELETE /api/memos/:id/force
   * Hard delete with full file cleanup.
   * MUST be declared before DELETE /api/memos/:id.
   */
  @Delete(':id/force')
  @HttpCode(HttpStatus.NO_CONTENT)
  async forceDeleteMemo(@Param('id', ParseIntPipe) id: number): Promise<void> {
    return this.lifecycleService.forceDeleteMemo(id);
  }

  /**
   * DELETE /api/memos/:id
   * Soft delete.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMemo(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() actor: JwtPayload,
  ): Promise<void> {
    return this.lifecycleService.deleteMemo(id, actor.id);
  }
}
