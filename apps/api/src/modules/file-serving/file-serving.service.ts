/**
 * FileServingService
 *
 * Mirrors backend/src/routes/file.routes.ts logic for secure file serving.
 *
 * Security (คุณอิเอริ — CRITICAL):
 *   1. Path traversal: resolveSafeUploadPath() enforces that the resolved
 *      absolute path stays under UPLOADS_DIR.
 *   2. Access control:
 *      - profiles/  → any authenticated user
 *      - signatures/ → owner OR user with access to a memo that used the sig
 *      - types/      → any authenticated user
 *      - other paths → must map to a memoId the user can access (canAccessMemo)
 *      - memoId = -1  → MemoType template → any authenticated user
 *   3. No raw user path is used to serve files — always resolved through
 *      resolveSafeUploadPath() which rejects traversal attempts.
 *   4. GET only — other methods return 405.
 */

import { Injectable, Logger } from '@nestjs/common';
import * as path from 'path';
import * as fs from 'fs';
import { ExtraStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  UPLOADS_DIR,
  resolveSafeUploadPath,
  coerceToRelative,
} from '../../common/upload/upload.config';

export interface ServeResult {
  absPath: string;
  mimeHint?: string;
}

@Injectable()
export class FileServingService {
  private readonly logger = new Logger(FileServingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve and authorise a file request.
   * Returns the absolute path to serve, or throws with an appropriate status.
   *
   * @param rawTail  The path segment from the URL after /api/secure-uploads
   * @param userId   Authenticated user ID (already validated by JwtAuthGuard)
   */
  async resolveFile(rawTail: string, userId: number): Promise<string> {
    const coerced = coerceToRelative(rawTail);
    if (!coerced) {
      const err = new Error('Missing path');
      (err as NodeJS.ErrnoException & { status?: number }).status = 400;
      throw err;
    }

    const { abs, rel } = resolveSafeUploadPath(coerced);

    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      const err = new Error('File not found');
      (err as NodeJS.ErrnoException & { status?: number }).status = 404;
      throw err;
    }

    // Special folder rules (profiles, signatures, types)
    const specialOk = await this.specialFolderAllow(rel, userId);
    if (specialOk) {
      this.logger.debug(`Special folder allowed: ${rel} for user ${userId}`);
      return abs;
    }

    // Generic memo-based access control
    const memoId = await this.findMemoIdByPath(rel);

    if (memoId === -1) {
      // MemoType template — authenticated user is enough
      return abs;
    }

    if (!memoId) {
      const err = new Error('Access denied: unknown file mapping');
      (err as NodeJS.ErrnoException & { status?: number }).status = 403;
      throw err;
    }

    const ok = await this.canAccessMemo(userId, memoId);
    if (!ok) {
      const err = new Error('Access denied');
      (err as NodeJS.ErrnoException & { status?: number }).status = 403;
      throw err;
    }

    return abs;
  }

  // ---------------------------------------------------------------------------
  // Private helpers (mirrored from Express file.routes.ts)
  // ---------------------------------------------------------------------------

  private async specialFolderAllow(relPath: string, userId: number): Promise<boolean> {
    const p = relPath.replace(/\\/g, '/');

    // profiles/ — any authenticated user
    if (p.startsWith('profiles/')) return true;

    // types/ — any authenticated user
    if (p.startsWith('types/')) return true;

    // signatures/ — owner or linked to an accessible memo
    if (p.startsWith('signatures/')) {
      const base = path.basename(p).toLowerCase();
      const sig = await this.prisma.userSignature.findFirst({
        where: {
          OR: [
            { path: { equals: base, mode: 'insensitive' } },
            { path: { endsWith: '/' + base, mode: 'insensitive' } },
          ],
        },
        select: { id: true, userId: true },
      });
      if (!sig) return false;
      if (sig.userId === userId) return true;

      const act = await this.prisma.memoApproverAction.findFirst({
        where: { signatureImageId: sig.id },
        select: { memoId: true },
      });
      if (act && (await this.canAccessMemo(userId, act.memoId))) return true;

      return false;
    }

    return false;
  }

  /**
   * Find memoId by matching file path against MainFile, AttachedFile, or
   * CommentAttachment records.
   * Returns null if no match, -1 if the file is a MemoType template.
   */
  private async findMemoIdByPath(relPath: string): Promise<number | null> {
    const base = path.basename(relPath).toLowerCase();
    const relFwd = relPath.replace(/\\/g, '/');
    const relBack = relFwd.replace(/\//g, '\\');
    const withUploadsFwd = `uploads/${relFwd}`;
    const withUploadsBack = `uploads\\${relBack}`;

    // 1) MainFile
    const mf = await this.prisma.mainFile.findFirst({
      where: {
        OR: [
          { fileName: { equals: base, mode: 'insensitive' } },
          { filePath: { endsWith: '/' + base, mode: 'insensitive' } },
          { filePath: { endsWith: '\\' + base, mode: 'insensitive' } },
          { filePath: { equals: relFwd, mode: 'insensitive' } },
          { filePath: { equals: relBack, mode: 'insensitive' } },
          { filePath: { equals: withUploadsFwd, mode: 'insensitive' } },
          { filePath: { equals: withUploadsBack, mode: 'insensitive' } },
        ],
      },
      select: { memoId: true, memoTypeId: true },
    });
    if (mf?.memoId) return mf.memoId;
    if (mf && !mf.memoId) return -1; // MemoType template

    // 2) AttachedFile
    const af = await this.prisma.attachedFile.findFirst({
      where: {
        OR: [
          { fileName: { equals: base, mode: 'insensitive' } },
          { filePath: { endsWith: '/' + base, mode: 'insensitive' } },
          { filePath: { endsWith: '\\' + base, mode: 'insensitive' } },
          { filePath: { equals: relFwd, mode: 'insensitive' } },
          { filePath: { equals: relBack, mode: 'insensitive' } },
          { filePath: { equals: withUploadsFwd, mode: 'insensitive' } },
          { filePath: { equals: withUploadsBack, mode: 'insensitive' } },
        ],
      },
      select: { memoId: true },
    });
    if (af?.memoId) return af.memoId;

    // 3) CommentAttachment
    const ca = await this.prisma.commentAttachment.findFirst({
      where: {
        OR: [
          { filename: { equals: base, mode: 'insensitive' } },
          { url: { endsWith: '/' + base, mode: 'insensitive' } },
          { url: { endsWith: '\\' + base, mode: 'insensitive' } },
          { url: { endsWith: relFwd, mode: 'insensitive' } },
          { url: { endsWith: relBack, mode: 'insensitive' } },
          { url: { endsWith: withUploadsFwd, mode: 'insensitive' } },
          { url: { endsWith: withUploadsBack, mode: 'insensitive' } },
        ],
      },
      select: { comment: { select: { memoId: true } } },
    });
    if (ca?.comment?.memoId) return ca.comment.memoId;

    return null;
  }

  /**
   * Mirrors filesec.ts canAccessMemo() — checks roles, ownership, CC, LOA,
   * ApproverAction, ExtraApprover, and CommentTag.
   */
  private async canAccessMemo(userId: number, memoId: number): Promise<boolean> {
    const me = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const isAdmin =
      !!me && ['admin', 'superadmin', 'system'].includes(me.role);

    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true, approvalLineId: true },
    });
    if (!memo) return false;

    if (await this.isMemoDraft(memoId)) {
      return memo.userId === userId || isAdmin;
    }

    if (isAdmin) return true;
    if (memo.userId === userId) return true;

    const isCc = await this.prisma.memoCc.findFirst({
      where: { memoId, userId },
      select: { id: true },
    });
    if (isCc) return true;

    if (memo.approvalLineId) {
      const isInLoa = await this.prisma.lineOfApprovalUserPivot.findFirst({
        where: { lineOfApprovalId: memo.approvalLineId, userId },
        select: { id: true },
      });
      if (isInLoa) return true;
    }

    const hasAction = await this.prisma.memoApproverAction.findFirst({
      where: { memoId, loaUser: { userId } },
      select: { id: true },
    });
    if (hasAction) return true;

    const isExtra = await this.prisma.extraApprover.findFirst({
      where: {
        userId,
        extra: {
          memoId,
          status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] },
        },
      },
      select: { id: true },
    });
    if (isExtra) return true;

    const isMentioned = await this.prisma.commentTag.findFirst({
      where: { memoId, userId },
      select: { id: true },
    });
    if (isMentioned) return true;

    return false;
  }

  private async isMemoDraft(memoId: number): Promise<boolean> {
    const DRAFT_STATUS_IDS = [1];
    const last = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: 'desc' },
      select: { statusId: true },
    });
    return !last || DRAFT_STATUS_IDS.includes(last.statusId);
  }
}
