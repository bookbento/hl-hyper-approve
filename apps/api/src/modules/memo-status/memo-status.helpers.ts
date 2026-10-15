/**
 * Shared bits for the Batch 8b status/approve/recall services.
 * Ported from backend memoStatus.controller / memoApproveAction / memoRecall.
 */
import { Prisma } from '@prisma/client';
import { LATEST_STATUS_ORDER } from '../../common/latest-status-order';

/** MemoStatusPivot / Status ids (mirrors the DB seed). */
export const STATUS = {
  DRAFT: 1,
  APPROVED: 3,
  REJECTED: 4,
  PROCESSING: 5,
  RECALL: 6,
  TERMINATED: 7,
} as const;

/** 409 `statusCode` keys the frontend maps to i18n text (approve / reject / recall). */
export const STATUS_CHANGED_KEY: Record<number, string> = {
  1: 'DRAFT_APPROVE',
  3: 'APPROVED',
  4: 'REJECTED',
  6: 'RECALLED',
  7: 'TERMINATED',
  8: 'EXPIRED',
};

/** Same as STATUS_CHANGED_KEY but a Draft memo reads "cannot terminate a draft". */
export const TERMINATE_CHANGED_KEY: Record<number, string> = {
  ...STATUS_CHANGED_KEY,
  1: 'DRAFT_TERMINATE',
};

type Tx = Prisma.TransactionClient;

/**
 * Move the actor's latest pivot row to `newStatusId` (Express updateCurrentMemoStatusTx).
 * Keeps one row per (memoId, userId): the latest row is re-used, and an older row
 * with the same status is deleted first so the unique (memoId, userId, statusId) holds.
 */
export async function setCurrentStatusTx(
  tx: Tx,
  memoId: number,
  actorUserId: number,
  newStatusId: number,
) {
  const cur = await tx.memoStatusPivot.findFirst({
    where: { memoId, userId: actorUserId },
    orderBy: LATEST_STATUS_ORDER,
    select: { id: true, statusId: true },
  });

  if (cur) {
    if (cur.statusId === newStatusId) {
      return tx.memoStatusPivot.update({
        where: { id: cur.id },
        data: { createdAt: new Date() },
      });
    }

    await tx.memoStatusPivot.deleteMany({
      where: { memoId, userId: actorUserId, statusId: newStatusId, id: { not: cur.id } },
    });

    return tx.memoStatusPivot.update({
      where: { id: cur.id },
      data: { statusId: newStatusId, createdAt: new Date() },
    });
  }

  return tx.memoStatusPivot.create({
    data: { memoId, userId: actorUserId, statusId: newStatusId },
  });
}

export type ClonePivot = {
  id: number;
  userId: number | null;
  level: number;
  approvalRequirement: string;
};
