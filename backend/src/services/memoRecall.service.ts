/**
 * memoRecall.service.ts
 *
 * Wave 8 extract: all recall workflows.
 * Moved from memo.controller.ts + memoStatus.controller.ts — behaviour parity 100%.
 *
 * Entry points (HTTP handlers):
 *  - recallMemo        (POST /api/memos/:id/recall)       — legacy recall: clear history
 *  - recallMemoPreserve (POST /api/memos/:id/recall-preserve via memo.controller) — legacy preserve
 *  - recallPreserve    (POST /api/memos/:id/recall-preserve) — status-gated preserve
 *  - recallClear       (POST /api/memos/:id/recall-clear) — status-gated clear + delete extra lines
 *
 * Internal helpers (shared / re-used):
 *  - handleRecall      (called from actOnMemo in memoStatus.controller)
 *  - recallClearCore   (shared business logic between recallMemo and recallClear)
 *
 * Imports (no circular deps):
 *  prisma                          ← prisma client
 *  ActionType, ExtraStatus, Prisma ← @prisma/client enums
 *  getLatestVersion                ← memoApproveAction.service
 *  updateCurrentMemoStatus,
 *  getUserDisplayName              ← memoStatus.controller (status pivot helpers)
 *  notifyRecallUpdate              ← memoNotification.service
 */

import { RequestHandler } from "express";
import { ActionType, ExtraStatus, Prisma } from "@prisma/client";
import { prisma } from "../../prisma/client";
import {
  updateCurrentMemoStatus,
  getUserDisplayName,
} from "../controllers/memoStatus.controller";
import { getLatestVersion } from "../services/memoApproveAction.service";
import { notifyRecallUpdate } from "../services/memoNotification.service";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Status IDs (hardcoded as constants for speed; mirrors the DB seed) */
const STATUS = {
  DRAFT: 1,
  REJECTED: 4,
  PROCESSING: 5,
  RECALL: 6,
} as const;

/** Status codes that block a recall */
const UNRECALLABLE_STATUSES: Record<number, string> = {
  1: "DRAFT_APPROVE",
  3: "APPROVED",
  6: "RECALLED",
  7: "TERMINATED",
  8: "EXPIRED",
};

// ─── Private helpers ──────────────────────────────────────────────────────────

/** Returns the waiting-status id from approvalActionStatus table. */
async function getWaitingActionStatusId(): Promise<number> {
  const row = await prisma.approvalActionStatus.findUnique({
    where: { code: "waiting" },
    select: { id: true },
  });
  if (!row) throw new Error("approvalActionStatus 'waiting' not found in DB");
  return row.id;
}

/**
 * Returns the DB status id for the given status name.
 * Handles "Recall" / "Recalled" aliases transparently.
 */
async function getStatusIdByName(
  name: string,
  tx?: Prisma.TransactionClient
): Promise<number> {
  const client = tx ?? prisma;

  const aliases = new Set<string>([name]);
  if (/^recall(ed)?$/i.test(name)) {
    aliases.add("Recall");
    aliases.add("Recalled");
  }

  const row = await client.status.findFirst({
    where: { name: { in: Array.from(aliases) } },
    select: { id: true },
  });
  if (!row) throw new Error(`Status not found: ${name}`);
  return row.id;
}

/**
 * Returns user IDs that already have "approved" action in the latest version.
 * Used to determine recall notification recipients.
 */
async function getApprovedUsersInLatestVersion(
  memoId: number
): Promise<number[]> {
  const latest = await getLatestVersion(memoId);
  const rows = await prisma.memoApproverAction.findMany({
    where: { memoId, version: latest, status: { code: "approved" } },
    select: { loaUser: { select: { userId: true } } },
  });
  const ids = rows
    .map((r) => r.loaUser.userId)
    .filter((id): id is number => id !== null);
  return Array.from(new Set(ids));
}

/**
 * Resets approver actions in the current (latest) version back to "waiting".
 * When opts.only === "waiting_or_rejected" only those statuses are reset
 * (leaving "approved" rows untouched — used by handleRecall).
 * Returns the version number that was reset.
 */
async function resetActionsInCurrentVersion(
  memoId: number,
  opts?: { only?: "waiting_or_rejected" }
): Promise<number> {
  const waitingId = await getWaitingActionStatusId();

  const currentVersion =
    (
      await prisma.memoApproverAction.aggregate({
        where: { memoId },
        _max: { version: true },
      })
    )._max.version ?? 1;

  await prisma.memoApproverAction.updateMany({
    where: {
      memoId,
      version: currentVersion,
      ...(opts?.only === "waiting_or_rejected"
        ? { status: { code: { in: ["waiting", "rejected"] } } }
        : {}),
    },
    data: {
      statusId: waitingId,
      actedAt: null,
      signatureImageId: null,
      signatureText: null,
      emailToken: null,
      approveWithCondition: null,
    },
  });

  return currentVersion;
}

/**
 * upsert a memoStatusPivot row, always bumping createdAt so it sorts as "latest".
 */
async function touchPivot(
  tx: Prisma.TransactionClient,
  memoId: number,
  userId: number,
  statusId: number
): Promise<void> {
  await tx.memoStatusPivot.upsert({
    where: { memoId_userId_statusId: { memoId, userId, statusId } },
    create: { memoId, userId, statusId },
    update: { createdAt: new Date() },
  });
}

// ─── Shared business-logic core ──────────────────────────────────────────────

/**
 * Core recall-clear logic shared between the legacy `recallMemo` handler
 * (POST /api/memos/:id/recall) and the status-gated `recallClear` handler
 * (POST /api/memos/:id/recall-clear).
 *
 * Differences between the two callers are handled via options:
 *  - deleteProcessingHistory: the legacy handler deletes memoHistory rows with
 *    statusId=5; the modern recallClear handler does NOT.
 *  - deleteExtraLines: recallClear deletes all extra approval lines; the
 *    legacy recallMemo only resets PENDING/IN_PROGRESS extra lines back to
 *    PENDING (soft reset).
 */
export async function recallClearCore(
  memoId: number,
  actorId: number,
  opts: {
    deleteProcessingHistory?: boolean;
    deleteExtraLines?: boolean;
    fileId?: number;
    actorName?: string;
    prevStatusId?: number;
  } = {}
): Promise<{ currentVersion: number; removedExtraLines: number }> {
  const {
    deleteProcessingHistory = false,
    deleteExtraLines = false,
    fileId,
    actorName,
    prevStatusId = 0,
  } = opts;

  const userName = actorName ?? (await getUserDisplayName(actorId));

  // ── 1) Reset approver actions to waiting (all, not just waiting_or_rejected)
  const currentVersion = await resetActionsInCurrentVersion(memoId);

  // ── 2) Legacy: delete Processing history rows
  if (deleteProcessingHistory) {
    await prisma.memoStatusPivot.deleteMany({
      where: { memoId, statusId: STATUS.PROCESSING },
    });
    await prisma.memoHistory.deleteMany({
      where: { memoId, statusId: STATUS.PROCESSING },
    });
  }

  // ── 3) Handle extra approval lines
  let removedExtraLines = 0;

  if (deleteExtraLines) {
    // recallClear: delete all extra lines, detach comments
    const extraLineIds = await prisma.extraApprovalLine
      .findMany({ where: { memoId }, select: { id: true } })
      .then((rows) => rows.map((r) => r.id));

    if (extraLineIds.length > 0) {
      await prisma.comment.updateMany({
        where: { extraApprovalLineId: { in: extraLineIds } },
        data: { isRecallExtra: true, extraApprovalLineId: null },
      });
      await prisma.extraApprover.deleteMany({
        where: { extraId: { in: extraLineIds } },
      });
      await prisma.extraApprovalLine.deleteMany({
        where: { id: { in: extraLineIds } },
      });
      removedExtraLines = extraLineIds.length;

      await prisma.memoHistory.create({
        data: {
          memoId,
          userId: actorId,
          actiontype: ActionType.UPDATE,
          action: `The Extra Approval line was removed due to the recall process`,
          fileId,
          timestamp: new Date(),
        },
      });
    }
  } else {
    // recallMemo (legacy): soft-reset active extra lines
    const activeExtraLines = await prisma.extraApprovalLine.findMany({
      where: {
        memoId,
        status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] },
      },
      select: { id: true },
    });

    if (activeExtraLines.length > 0) {
      const lineIds = activeExtraLines.map((l) => l.id);
      await prisma.$transaction([
        prisma.extraApprovalLine.updateMany({
          where: { id: { in: lineIds } },
          data: { status: ExtraStatus.PENDING, closedAt: null },
        }),
        prisma.extraApprover.updateMany({
          where: { extraId: { in: lineIds } },
          data: { statusId: null, actedAt: null },
        }),
      ]);
    }
  }

  return { currentVersion, removedExtraLines };
}

// ─── HTTP Handlers ────────────────────────────────────────────────────────────

/**
 * POST /api/memos/:id/recall  (legacy handler from memo.controller.ts)
 *
 * Recall behaviour:
 *  - Create pivot statusId=6 (Recall)
 *  - Delete Processing(5) pivot + memoHistory rows
 *  - Reset all approver actions → waiting
 *  - Soft-reset PENDING/IN_PROGRESS extra lines
 *
 * Does NOT check current status before recalling (legacy behaviour preserved).
 */
export const recallMemo: RequestHandler = async (req, res) => {
  const memoId = +req.params.id;
  const { userId, fileId } = req.body;

  if (isNaN(memoId) || isNaN(userId)) {
    res.status(400).json({ error: "Invalid memoId or userId" });
    return;
  }

  try {
    // 1) Create Recall pivot
    await prisma.memoStatusPivot.create({
      data: { memoId, userId, statusId: STATUS.RECALL },
    });

    // 2) Shared clear core: delete processing history + soft-reset extra lines
    await recallClearCore(memoId, userId, {
      deleteProcessingHistory: true,
      deleteExtraLines: false,
      fileId: fileId ? Number(fileId) : undefined,
    });

    res.status(201).json({
      message:
        "Memo recalled; previous approvals cleared (including Extra waiting reset).",
    });
  } catch (err) {
    console.error("recallMemo failed:", err);
    res.status(500).json({ error: "Recall failed" });
  }
};

/**
 * POST /api/memos/:id/recall-preserve  (legacy handler from memo.controller.ts)
 *
 * Preserve-style recall: upsert Recall(6) pivot + write history.
 * Does NOT reset approver actions or extra lines.
 */
export const recallMemoPreserve: RequestHandler = async (req, res) => {
  const memoId = +req.params.id;
  const { userId, fileId } = req.body;

  try {
    await prisma.memoStatusPivot.upsert({
      where: {
        memoId_userId_statusId: { memoId, userId, statusId: STATUS.RECALL },
      },
      update: {},
      create: { memoId, userId, statusId: STATUS.RECALL },
    });

    await prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        statusId: STATUS.RECALL,
        action: `${userId} recalled memo (preserve)`,
        actiontype: ActionType.RECALL,
        timestamp: new Date(),
        fileId: fileId ? Number(fileId) : undefined,
      },
    });

    res.status(201).json({ message: "Recalled (preserve)." });
  } catch (err) {
    console.error("recallMemoPreserve failed:", err);
    res.status(500).json({ error: "Recall preserve failed" });
  }
};

/**
 * Internal helper called by actOnMemo in memoStatus.controller.ts
 * when statusCode === 'recalled'.
 *
 * Resets only waiting/rejected actions (approved rows preserved) and
 * transitions pivot: Recall(6) → Draft(1).
 */
export async function handleRecall({
  memoId,
  loaUserId,
  latestVersion,
}: {
  memoId: number;
  loaUserId: number;
  latestVersion: number;
}): Promise<void> {
  // 1) Reset only waiting/rejected actions (approved stay)
  await resetActionsInCurrentVersion(memoId, { only: "waiting_or_rejected" });

  // 2) Transition pivot atomically: Recall(6) → Draft(1)
  await prisma.$transaction(async (tx) => {
    const bump = async (newStatusId: number) => {
      // Remove any existing row for this (memoId, loaUserId, newStatusId) first
      await tx.memoStatusPivot.deleteMany({
        where: { memoId, userId: loaUserId, statusId: newStatusId },
      });

      const cur = await tx.memoStatusPivot.findFirst({
        where: { memoId, userId: loaUserId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });

      if (cur) {
        await tx.memoStatusPivot.update({
          where: { id: cur.id },
          data: { statusId: newStatusId, createdAt: new Date() },
        });
      } else {
        await tx.memoStatusPivot.create({
          data: { memoId, userId: loaUserId, statusId: newStatusId },
        });
      }
    };

    await bump(STATUS.RECALL);
    await bump(STATUS.DRAFT);
  });
}

/**
 * POST /api/memos/:id/recall-preserve  (status-gated, from memoStatus.controller.ts)
 *
 * Guards: memo must be in Processing(5) or Rejected(4).
 * Transitions pivot: delete (3,4,5) → Recall(6) → Draft(1).
 * Writes two history entries (one for recall, one for draft restore).
 * Fires notifyRecallUpdate async.
 */
export const recallPreserve: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const userId = Number(req.body.userId);
  const fileId = req.body.fileId ? Number(req.body.fileId) : undefined;

  // Guard: only Processing(5) or Rejected(4)
  const currentStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    select: { statusId: true },
  });
  const currentStatusId = currentStatus?.statusId ?? 0;

  if (currentStatusId !== STATUS.PROCESSING && currentStatusId !== STATUS.REJECTED) {
    const statusCodeKey = UNRECALLABLE_STATUSES[currentStatusId] ?? "UNKNOWN";
    console.warn(
      `[recallPreserve] BLOCKED: memoId=${memoId} status=${currentStatusId} user=${userId}`
    );
    res.status(409).json({
      code: "MEMO_STATUS_CHANGED",
      statusCode: statusCodeKey,
      currentStatusId,
    });
    return;
  }

  const userRec = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true },
  });
  const userName = userRec?.name ?? `User#${userId}`;

  // Snapshot approved users before any pivot changes
  await getApprovedUsersInLatestVersion(memoId);

  const prevStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { id: "desc" },
    select: { statusId: true },
  });
  const prevStatusId = prevStatus?.statusId ?? 0;

  // Remove Processing / Approved / Rejected pivots
  await prisma.memoStatusPivot.deleteMany({
    where: { memoId, statusId: { in: [3, 4, 5] } },
  });

  // Transition: Recall(6) → Draft(1)
  await updateCurrentMemoStatus(memoId, userId, STATUS.RECALL);
  await updateCurrentMemoStatus(memoId, userId, STATUS.DRAFT);

  // Two history entries
  await prisma.memoHistory.create({
    data: {
      memoId,
      userId,
      fileId,
      statusId: prevStatusId,
      action: `${userName} recalled memo (preserve)`,
      actiontype: ActionType.RECALL,
      timestamp: new Date(),
    },
  });
  await prisma.memoHistory.create({
    data: {
      memoId,
      userId,
      fileId,
      statusId: STATUS.RECALL,
      action: `${userName} set memo back to Draft (preserve)`,
      actiontype: ActionType.RECALL,
      timestamp: new Date(),
    },
  });

  res.json({ message: "Recall (preserve) done" });

  setImmediate(() => {
    notifyRecallUpdate(memoId, userId, userName).catch(console.error);
  });
};

/**
 * POST /api/memos/:id/recall-clear  (status-gated, from memoStatus.controller.ts)
 *
 * Guards: memo must be in Processing(5) or Rejected(4).
 * Resets all approver actions. Deletes all extra approval lines.
 * Writes history (REVISE if any rejection existed, RECALL otherwise).
 * Fires notifyRecallUpdate async.
 */
export const recallClear: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const actorId = (req as any).user!.id;
  const fileId = req.body.fileId ? Number(req.body.fileId) : undefined;

  if (!Number.isFinite(memoId)) {
    res.status(400).json({ error: "invalid memoId" });
    return;
  }

  // Guard: only Processing(5) or Rejected(4)
  const currentStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    select: { statusId: true },
  });
  const currentStatusId = currentStatus?.statusId ?? 0;

  if (currentStatusId !== STATUS.PROCESSING && currentStatusId !== STATUS.REJECTED) {
    const statusCodeKey = UNRECALLABLE_STATUSES[currentStatusId] ?? "UNKNOWN";
    console.warn(
      `[recallClear] BLOCKED: memoId=${memoId} status=${currentStatusId} user=${actorId}`
    );
    res.status(409).json({
      code: "MEMO_STATUS_CHANGED",
      statusCode: statusCodeKey,
      currentStatusId,
    });
    return;
  }

  try {
    const [rejectedId, recallId, draftId, rawName] = await Promise.all([
      getStatusIdByName("Rejected"),
      getStatusIdByName("Recalled"),
      getStatusIdByName("Draft"),
      getUserDisplayName(actorId),
    ]);
    const userName = rawName ?? `User#${actorId}`;

    // Snapshot approved users + owner before tx
    const [owner, approvedBefore] = await Promise.all([
      prisma.masterMemo
        .findUnique({ where: { id: memoId }, select: { userId: true } })
        .then((r) => r!),
      getApprovedUsersInLatestVersion(memoId),
    ]);

    const result = await prisma.$transaction(async (tx) => {
      // Detect if any rejection occurred (owner, extra line, or extra approver)
      const prev = await tx.memoStatusPivot.findFirst({
        where: { memoId, userId: owner.userId },
        orderBy: { createdAt: "desc" },
        select: { statusId: true },
      });
      const prevStatusId = prev?.statusId ?? 0;

      const [extraLineRejected, extraApproverRejected] = await Promise.all([
        tx.extraApprovalLine
          .count({ where: { memoId, status: ExtraStatus.REJECTED } })
          .then((c) => c > 0),
        tx.extraApprover
          .count({ where: { extra: { memoId }, statusId: rejectedId } })
          .then((c) => c > 0),
      ]);
      const ownerRejected = prevStatusId === rejectedId;
      const isRevise = ownerRejected || extraLineRejected || extraApproverRejected;

      // 1) Reset approver actions
      const currentVersion = await resetActionsInCurrentVersion(memoId);

      // 2) Transition pivot: Recall(6) → Draft(1)
      await touchPivot(tx, memoId, owner.userId, recallId);
      await touchPivot(tx, memoId, owner.userId, draftId);

      // 3) Delete all extra lines + detach comments
      const extraLineIds = await tx.extraApprovalLine
        .findMany({ where: { memoId }, select: { id: true } })
        .then((rows) => rows.map((r) => r.id));

      if (extraLineIds.length > 0) {
        await tx.comment.updateMany({
          where: { extraApprovalLineId: { in: extraLineIds } },
          data: { isRecallExtra: true, extraApprovalLineId: null },
        });
        await tx.extraApprover.deleteMany({
          where: { extraId: { in: extraLineIds } },
        });
        await tx.extraApprovalLine.deleteMany({
          where: { id: { in: extraLineIds } },
        });
        await tx.memoHistory.create({
          data: {
            memoId,
            userId: actorId,
            actiontype: ActionType.UPDATE,
            action: `The Extra Approval line was removed due to the recall process`,
            fileId,
            timestamp: new Date(),
          },
        });
      }

      // 4) Main history: REVISE if any rejection, else RECALL
      await tx.memoHistory.create({
        data: {
          memoId,
          userId: actorId,
          fileId,
          statusId: prevStatusId || undefined,
          action: isRevise
            ? `${userName} revised the memo`
            : `${userName} recalled the memo`,
          actiontype: isRevise ? ActionType.REVISE : ActionType.RECALL,
          timestamp: new Date(),
        },
      });

      return { currentVersion, removedExtraLines: extraLineIds.length };
    });

    res.json({
      message: `Recall done on version ${result.currentVersion}`,
      removedExtraLines: result.removedExtraLines,
      performedBy: { id: actorId, name: userName },
    });

    setImmediate(async () => {
      notifyRecallUpdate(memoId, actorId, userName).catch(console.error);
    });
  } catch (e) {
    console.error("recall error:", e);
    res.status(500).json({ error: "internal error" });
  }
};
