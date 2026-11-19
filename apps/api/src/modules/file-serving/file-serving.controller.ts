/**
 * FileServingController
 *
 * Mirrors backend/src/routes/file.routes.ts — serves files under /api/secure-uploads/*.
 *
 * Security (คุณอิเอริ):
 *   - JwtAuthGuard on every request.
 *   - GET only — 405 for other methods.
 *   - Path coercion + traversal guard in FileServingService.resolveFile().
 *   - Content-Disposition and Content-Type set appropriately.
 *   - PDF: inline with no-cache headers.
 *   - Others: attachment with short cache.
 *   - Access-Control-Expose-Headers exposes Content-Disposition to frontend.
 */

import {
  Controller,
  Get,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { lookup as mimeLookup } from 'mime-types';
import * as path from 'path';
import contentDisposition = require('content-disposition');

/**
 * Drop the storage prefixes added on upload so downloads keep the user's name:
 *   "1712345678901-name.pdf"       (memo / comment files)
 *   "1712345678901_0_name.doc"     (memo type templates: `${Date.now()}_${idx}_`)
 */
export function stripStoragePrefix(fileName: string): string {
  return fileName.replace(/^\d{10,}(?:-|_\d+_)/, '');
}
import { Request, Response } from 'express';
import { FileServingService } from './file-serving.service';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';

@Controller('api/secure-uploads')
export class FileServingController {
  constructor(private readonly fileServingService: FileServingService) {}

  /**
   * GET /api/secure-uploads/*path
   *
   * The wildcard segment captures everything after the mount point.
   * NestJS @Get('*') with req.params[0] or req.path covers this.
   */
  @Get('*')
  @UseGuards(JwtAuthGuard)
  async serveFile(
    @Req() req: Request & { user?: JwtPayload },
    @Res() res: Response,
  ): Promise<void> {
    const user = req.user;
    if (!user) {
      res.status(401).json({ error: 'Unauthenticated' });
      return;
    }

    // In Nest req.path is the FULL path ("/api/secure-uploads/types/x.doc"), not
    // relative to the controller as in an Express sub-router — strip the prefix.
    // (Before this every file under /api/secure-uploads answered 404.)
    const rawTail = req.path.replace(/^\/+/, '').replace(/^api\/secure-uploads\/?/i, '');

    let absPath: string;
    let displayName: string | undefined;
    try {
      ({ abs: absPath, displayName } = await this.fileServingService.resolveDownload(rawTail, user.id));
    } catch (err: unknown) {
      const e = err as Error & { status?: number };
      const status = e.status ?? 500;
      if (!res.headersSent) {
        res.status(status).json({ error: e.message ?? 'Internal error' });
      }
      return;
    }

    this.sendFile(absPath, res, displayName);
  }

  private sendFile(absPath: string, res: Response, displayName?: string): void {
    const mime = String(mimeLookup(absPath) || 'application/octet-stream');
    const fileName = path.basename(absPath);
    // the saved upload name (e.g. Thai) when known; the disk name is sanitized
    const originalFileName = displayName?.trim() || stripStoragePrefix(fileName);

    res.setHeader('Content-Type', mime);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    // content-disposition builds an ASCII fallback + RFC 5987 filename*; a raw
    // Thai name inside filename="…" is not valid header content (and was what
    // users then re-uploaded as mojibake).
    if (mime === 'application/pdf') {
      res.setHeader('Content-Disposition', contentDisposition(originalFileName, { type: 'inline' }));
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      res.setHeader('Content-Disposition', contentDisposition(originalFileName, { type: 'attachment' }));
      res.setHeader('Cache-Control', 'private, max-age=60');
    }

    res.sendFile(absPath);
  }
}
