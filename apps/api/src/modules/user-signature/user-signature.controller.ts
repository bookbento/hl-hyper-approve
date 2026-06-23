/**
 * UserSignatureController
 *
 * Handles signature file upload/listing/deletion for a user.
 * Paths mirror Express userSignature.route.ts mounted at /api/users.
 *
 * Routes:
 *   GET    /api/users/:id/signatures             — list signatures
 *   POST   /api/users/:id/signatures             — upload signature (PNG only)
 *   PUT    /api/users/:id/default-signature      — set/clear default
 *   GET    /api/users/signatures/:sigId/file     — serve signature file
 *   DELETE /api/users/signatures/:sigId          — delete signature
 *
 * Security (คุณอิเอริ):
 *   - JwtAuthGuard on all routes (mirrors Express authenticate).
 *   - SelfOrAdminGuard on /:id routes (mirrors authorizeSelfOrAdmin).
 *   - /signatures/:sigId routes: JwtAuthGuard only (any authenticated user
 *     may view/delete via sigId — mirrors Express behaviour).
 *   - File magic-byte validation in service (PNG only for signatures).
 *   - getSignatureFile uses DB lookup — no user-controlled path traversal.
 *
 * Note: Route ordering matters — "signatures/:sigId" must appear BEFORE
 * ":id/signatures" so NestJS does not misroute "signatures" as :id.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  Res,
  ParseIntPipe,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { Response } from 'express';
import { UserSignatureService } from './user-signature.service';
import { SetDefaultSignatureDto } from './dto/set-default-signature.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { SelfOrAdminGuard } from '../../common/guards/self-or-admin.guard';
import { SIG_DIR, sanitizeName } from '../../common/upload/upload.config';

/** Multer disk storage for PNG signatures — mirrors Express pngOnlyUpload */
const signatureStorage = diskStorage({
  destination: (_req, _file, cb) => cb(null, SIG_DIR),
  filename: (_req, file, cb) => {
    const safeName = sanitizeName(file.originalname);
    // Strip extension then force .png suffix (mirrors Express route)
    const base = safeName.replace(/\.[^.]+$/, '');
    cb(null, `${Date.now()}-${base}.png`);
  },
});

/** Multer fileFilter — only accept PNG by MIME + extension (mirrors Express) */
function pngOnlyFilter(
  _req: Express.Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
): void {
  const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
  if (file.mimetype !== 'image/png' || ext !== 'png') {
    return cb(new Error('PNG only'), false);
  }
  cb(null, true);
}

@Controller('api/users')
export class UserSignatureController {
  constructor(private readonly signatureService: UserSignatureService) {}

  // ── Routes with static "signatures" segment (MUST precede :id routes) ──

  /**
   * GET /api/users/signatures/:sigId/file
   * Serve the PNG file. Path is resolved from DB (no traversal risk).
   */
  @Get('signatures/:sigId/file')
  @UseGuards(JwtAuthGuard)
  async getSignatureFile(
    @Param('sigId', ParseIntPipe) sigId: number,
    @Res() res: Response,
  ): Promise<void> {
    const absPath = await this.signatureService.getSignatureAbsPath(sigId);
    res.sendFile(absPath);
  }

  /**
   * DELETE /api/users/signatures/:sigId
   */
  @Delete('signatures/:sigId')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSignature(
    @Param('sigId', ParseIntPipe) sigId: number,
  ): Promise<void> {
    await this.signatureService.deleteSignature(sigId);
  }

  // ── Routes with dynamic :id segment ──────────────────────────────────────

  /**
   * GET /api/users/:id/signatures
   */
  @Get(':id/signatures')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  async listSignatures(@Param('id', ParseIntPipe) id: number) {
    return this.signatureService.listSignatures(id);
  }

  /**
   * POST /api/users/:id/signatures
   * Upload a PNG signature file.
   * Multer filter rejects non-PNG before service validation.
   * Service validates magic bytes + image integrity.
   */
  @Post(':id/signatures')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: signatureStorage,
      fileFilter: pngOnlyFilter,
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async uploadSignature(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('label') label?: string,
  ) {
    if (!file) {
      throw new BadRequestException('file required');
    }
    return this.signatureService.uploadSignature(id, file, label);
  }

  /**
   * PUT /api/users/:id/default-signature
   * Set or clear the default signature.
   */
  @Put(':id/default-signature')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  async setDefaultSignature(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: SetDefaultSignatureDto,
  ) {
    // signatureId may be number or null (DTO transform handles "")
    const sigId = body.signatureId !== undefined ? body.signatureId : null;
    return this.signatureService.setDefaultSignature(id, sigId);
  }
}
