/**
 * MemoAccessService
 *
 * Extracted from memo.controller.ts (functions canViewMemo and canViewMemoSimple).
 * Behavior is identical to the original — no logic changes.
 *
 * canViewMemo    — full check including recursive reference traversal (with
 *                  visited-set protection against circular references, D-5 fix).
 * canViewMemoSimple — same checks without reference traversal (used in contexts
 *                  where recursive lookup would be redundant or unsafe).
 */

import { prisma } from "../../prisma/client";

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
 *
 * The visited set prevents infinite recursion when memo A references B and B
 * references A (D-5 fix committed in 1efc758).
 */
export async function canViewMemo(
  userId: number,
  memoId: number,
  visited: Set<number> = new Set()
): Promise<boolean> {
  if (visited.has(memoId)) return false;
  visited.add(memoId);

  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { id: true, userId: true },
  });
  if (!memo) return false;

  // Owner sees all
  if (memo.userId === userId) return true;

  // Block non-owners from Draft memos
  const latestStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    include: { status: { select: { name: true } } },
  });
  if ((latestStatus?.status?.name || "").toLowerCase() === "draft") {
    return false;
  }

  // Extra-approver (ever)
  const extraEver = await prisma.extraApprover.findFirst({
    where: { userId, extra: { memoId } },
    select: { id: true },
  });
  if (extraEver) return true;

  // Tagged in a comment
  const mentioned = await prisma.commentTag.findFirst({
    where: { memoId, userId },
    select: { id: true },
  });
  if (mentioned) return true;

  // Approver in latest version
  const { _max } = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  const latestVer = _max.version ?? 1;

  const approverRow = await prisma.memoApproverAction.findFirst({
    where: { memoId, version: latestVer, loaUser: { userId } },
    select: { id: true },
  });
  if (approverRow) return true;

  // CC recipient
  const ccRow = await prisma.memoCc.findFirst({
    where: { memoId, userId },
    select: { id: true },
  });
  if (ccRow) return true;

  // Recursive: user has access to a memo that references this memo
  const referencingMemos = await prisma.memoReference.findMany({
    where: { referenceMemoId: memoId },
    select: { mainMemoId: true },
  });

  for (const ref of referencingMemos) {
    const hasAccessToMainMemo = await canViewMemo(userId, ref.mainMemoId, visited);
    if (hasAccessToMainMemo) return true;
  }

  return false;
}

/**
 * Returns true when userId is allowed to view memoId.
 *
 * Same rules as canViewMemo but WITHOUT the recursive reference check.
 * Used in contexts where transitive reference access is not required (e.g.
 * getMemoReferences, getReferenceMemoContent).
 */
export async function canViewMemoSimple(
  userId: number,
  memoId: number
): Promise<boolean> {
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { id: true, userId: true },
  });
  if (!memo) return false;

  // Owner sees all
  if (memo.userId === userId) return true;

  // Block non-owners from Draft memos
  const latestStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    include: { status: { select: { name: true } } },
  });
  if ((latestStatus?.status?.name || "").toLowerCase() === "draft") {
    return false;
  }

  // Extra-approver (ever)
  const extraEver = await prisma.extraApprover.findFirst({
    where: { userId, extra: { memoId } },
    select: { id: true },
  });
  if (extraEver) return true;

  // Tagged in a comment
  const mentioned = await prisma.commentTag.findFirst({
    where: { memoId, userId },
    select: { id: true },
  });
  if (mentioned) return true;

  // Approver in latest version
  const { _max } = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  const latestVer = _max.version ?? 1;

  const approverRow = await prisma.memoApproverAction.findFirst({
    where: { memoId, version: latestVer, loaUser: { userId } },
    select: { id: true },
  });
  if (approverRow) return true;

  // CC recipient
  const ccRow = await prisma.memoCc.findFirst({
    where: { memoId, userId },
    select: { id: true },
  });
  if (ccRow) return true;

  return false;
}
