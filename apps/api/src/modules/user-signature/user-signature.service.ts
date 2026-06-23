/**
 * UserSignatureService
 *
 * Mirrors backend/src/controllers/userSignature.controller.ts.
 * Uses AdminLogService (@Global) for audit logs if needed.
 *
 * Security (คุณอิเอริ):
 *   - File type is validated by magic bytes (file-type) after multer saves to disk.
 *   - Image integrity is verified via sharp.metadata().
 *   - Only PNG is accepted for signatures (same as Express).
 *   - File is deleted from disk on any validation failure (no orphan files).
 *   - getSignatureFile() uses Prisma lookup — no raw path from user input.
 */

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import * as fs from 'fs/promises';
import { PrismaService } from '../../prisma/prisma.service';

// file-type v22 is pure ESM — use dynamic import() at call site

// sharp is a native module — require() is fine
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sharp = require('sharp') as typeof import('sharp');

@Injectable()
export class UserSignatureService {
  private readonly logger = new Logger(UserSignatureService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** GET /api/users/:id/signatures */
  async listSignatures(userId: number) {
    const [list, user] = await Promise.all([
      this.prisma.userSignature.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, path: true, label: true, createdAt: true },
      }),
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { defaultSignatureId: true },
      }),
    ]);

    return {
      defaultSignatureId: user?.defaultSignatureId ?? null,
      signatures: list,
    };
  }

  /**
   * POST /api/users/:id/signatures
   *
   * Validates:
   *   1. File exists (multer wrote it to disk)
   *   2. Magic bytes confirm image/png (fileTypeFromBuffer)
   *   3. sharp can decode the image (not corrupted)
   *
   * Cleans up disk file on any failure.
   */
  async uploadSignature(
    userId: number,
    file: Express.Multer.File,
    label?: string,
  ) {
    const savedPath = file.path;

    let fileBuffer: Buffer;
    try {
      fileBuffer = await fs.readFile(savedPath);
    } catch {
      throw new BadRequestException('Could not read uploaded file');
    }

    // file-type v22 is pure ESM. Use a dynamic import wrapped in a type-safe helper.
    // ts-ignore is required because tsconfig module=commonjs does not allow
    // import() of ESM-only packages to be statically typed.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: ESM import in CJS compilation — resolved at runtime
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const fileTypeModule: {
      fileTypeFromBuffer: (
        buf: Uint8Array | ArrayBuffer,
      ) => Promise<{ ext: string; mime: string } | undefined>;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require('file-type');
    const ft = await fileTypeModule.fileTypeFromBuffer(fileBuffer);
    if (!ft || ft.mime !== 'image/png') {
      await fs.unlink(savedPath).catch((err: unknown) =>
        this.logger.warn(`Failed to delete invalid file ${savedPath}: ${String(err)}`),
      );
      throw new BadRequestException('PNG only');
    }

    try {
      await sharp(fileBuffer).metadata();
    } catch {
      await fs.unlink(savedPath).catch((err: unknown) =>
        this.logger.warn(`Failed to delete corrupted file ${savedPath}: ${String(err)}`),
      );
      throw new BadRequestException('corrupted image');
    }

    const sig = await this.prisma.userSignature.create({
      data: {
        userId,
        path: savedPath,
        label: label ?? null,
      },
    });

    return sig;
  }

  /** PUT /api/users/:id/default-signature */
  async setDefaultSignature(userId: number, signatureId: number | null) {
    await this.prisma.user.update({
      where: { id: userId },
      data: { defaultSignatureId: signatureId },
    });
    return { ok: true };
  }

  /** DELETE /api/users/signatures/:sigId */
  async deleteSignature(sigId: number) {
    let sig: { path: string; userId: number };
    try {
      sig = await this.prisma.userSignature.delete({
        where: { id: sigId },
        select: { path: true, userId: true },
      });
    } catch {
      throw new NotFoundException('Signature not found');
    }

    // Clear defaultSignatureId if it points to the deleted signature
    await this.prisma.user.updateMany({
      where: { id: sig.userId, defaultSignatureId: sigId },
      data: { defaultSignatureId: null },
    });

    try {
      await fs.unlink(sig.path);
    } catch (err: unknown) {
      this.logger.warn(
        `Could not delete signature file ${sig.path}: ${String(err)}`,
      );
    }
  }

  /**
   * GET /api/users/signatures/:sigId/file
   *
   * Returns the absolute path from Prisma — never from user input directly.
   * The caller (controller) uses res.sendFile(absPath).
   */
  async getSignatureAbsPath(sigId: number): Promise<string> {
    const sig = await this.prisma.userSignature.findUnique({
      where: { id: sigId },
      select: { path: true },
    });
    if (!sig) {
      throw new NotFoundException('Signature not found');
    }
    return sig.path;
  }
}
