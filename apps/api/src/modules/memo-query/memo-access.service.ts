/**
 * MemoAccessService (Nest)
 *
 * Ported from backend/src/services/memoAccess.service.ts — pure logic,
 * no req/res. Designed to be exported from MemoQueryModule so future
 * memo sub-batch modules can import and reuse it without re-implementing.
 *
 * canViewMemo       — full check including recursive reference traversal
 *                     (visited-set protection against circular references, D-5 fix).
 * canViewMemoSimple — same checks without reference traversal.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class MemoAccessService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Returns true when userId is allowed to view memoId.
   *
   * Access rules (checked in order):
   * 1. Owner always has access.
   * 2. Draft memos are blocked for everyone except the owner.
   * 3. Extra-approver (current or past) has access.
   * 4. User tagged in a comment has access.
   * 5. Approver in the latest version has access.
   * 6. CC recipient has access.
   * 7. User has access to a memo that references this memo (recursive, visited-set protected).
   */
  async canViewMemo(
    userId: number,
    memoId: number,
    visited: Set<number> = new Set(),
  ): Promise<boolean> {
    if (visited.has(memoId)) return false;
    visited.add(memoId);

    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { id: true, userId: true },
    });
    if (!memo) return false;

    if (memo.userId === userId) return true;

    const latestStatus = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: 'desc' },
      include: { status: { select: { name: true } } },
    });
    if ((latestStatus?.status?.name || '').toLowerCase() === 'draft') {
      return false;
    }

    const extraEver = await this.prisma.extraApprover.findFirst({
      where: { userId, extra: { memoId } },
      select: { id: true },
    });
    if (extraEver) return true;

    const mentioned = await this.prisma.commentTag.findFirst({
      where: { memoId, userId },
      select: { id: true },
    });
    if (mentioned) return true;

    const { _max } = await this.prisma.memoApproverAction.aggregate({
      where: { memoId },
      _max: { version: true },
    });
    const latestVer = _max.version ?? 1;

    const approverRow = await this.prisma.memoApproverAction.findFirst({
      where: { memoId, version: latestVer, loaUser: { userId } },
      select: { id: true },
    });
    if (approverRow) return true;

    const ccRow = await this.prisma.memoCc.findFirst({
      where: { memoId, userId },
      select: { id: true },
    });
    if (ccRow) return true;

    const referencingMemos = await this.prisma.memoReference.findMany({
      where: { referenceMemoId: memoId },
      select: { mainMemoId: true },
    });

    for (const ref of referencingMemos) {
      const hasAccessToMainMemo = await this.canViewMemo(userId, ref.mainMemoId, visited);
      if (hasAccessToMainMemo) return true;
    }

    return false;
  }

  /**
   * Same rules as canViewMemo but WITHOUT the recursive reference check.
   */
  async canViewMemoSimple(userId: number, memoId: number): Promise<boolean> {
    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { id: true, userId: true },
    });
    if (!memo) return false;

    if (memo.userId === userId) return true;

    const latestStatus = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: 'desc' },
      include: { status: { select: { name: true } } },
    });
    if ((latestStatus?.status?.name || '').toLowerCase() === 'draft') {
      return false;
    }

    const extraEver = await this.prisma.extraApprover.findFirst({
      where: { userId, extra: { memoId } },
      select: { id: true },
    });
    if (extraEver) return true;

    const mentioned = await this.prisma.commentTag.findFirst({
      where: { memoId, userId },
      select: { id: true },
    });
    if (mentioned) return true;

    const { _max } = await this.prisma.memoApproverAction.aggregate({
      where: { memoId },
      _max: { version: true },
    });
    const latestVer = _max.version ?? 1;

    const approverRow = await this.prisma.memoApproverAction.findFirst({
      where: { memoId, version: latestVer, loaUser: { userId } },
      select: { id: true },
    });
    if (approverRow) return true;

    const ccRow = await this.prisma.memoCc.findFirst({
      where: { memoId, userId },
      select: { id: true },
    });
    if (ccRow) return true;

    return false;
  }
}
