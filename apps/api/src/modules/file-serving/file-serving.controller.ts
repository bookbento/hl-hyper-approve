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

    // Strip the controller prefix from the full path
    // req.path = "/some/file/path" relative to this controller's mount
    const rawTail = req.path.replace(/^\/+/, '');

    let absPath: string;
    try {
      absPath = await this.fileServingService.resolveFile(rawTail, user.id);
    } catch (err: unknown) {
      const e = err as Error & { status?: number };
      const status = e.status ?? 500;
      if (!res.headersSent) {
        res.status(status).json({ error: e.message ?? 'Internal error' });
      }
      return;
    }

    this.sendFile(absPath, res);
  }

  private sendFile(absPath: string, res: Response): void {
    const mime = String(mimeLookup(absPath) || 'application/octet-stream');
    const fileName = path.basename(absPath);
    // Strip timestamp prefix (e.g. "1234567890-original.pdf" → "original.pdf")
    const originalFileName = fileName.replace(/^\d+-/, '');

    res.setHeader('Content-Type', mime);
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

    if (mime === 'application/pdf') {
      const disposition = `inline; filename="${originalFileName}"; filename*=UTF-8''${encodeURIComponent(originalFileName)}`;
      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Cache-Control', 'private, no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      const disposition = `attachment; filename="${originalFileName}"; filename*=UTF-8''${encodeURIComponent(originalFileName)}`;
      res.setHeader('Content-Disposition', disposition);
      res.setHeader('Cache-Control', 'private, max-age=60');
    }

    res.sendFile(absPath);
  }
}
