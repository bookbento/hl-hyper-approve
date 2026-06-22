/**
 * memoApproveAction.service.ts
 *
 * Wave 7 extract: approval action + core state machine.
 * Moved from memoStatus.controller.ts + memo.controller.ts — behaviour parity 100%.
 *
 * Responsibilities:
 *  - getLatestVersion          (helper — used by state machine & notification service)
 *  - evaluateAndUpdateMemoStatus  (CORE state machine: decides Approved/Rejected/Processing)
 *  - approveAction             (Express RequestHandler: validates → records → triggers state machine)
 *
 * Imports (no circular deps):
 *  prisma, ActionType            ← prisma client & Prisma enums
 *  updateCurrentMemoStatus       ← memoStatus.controller (status pivot write)
 *  notifyStatusUpdate            ← memoNotification.service (push/email after state change)
 *  hasActiveExtraLine            ← extraApproval.service
 *  getUserDisplayName            ← memoStatus.controller (user display name helper)
 *  sendEmail                     ← lib/mailer
 *  pushNoti, filterUsersForEmail ← lib/notify, lib/notificationPreferences
 */

import { RequestHandler } from "express";
import { ActionType } from "@prisma/client";
import { prisma } from "../../prisma/client";
import {
  updateCurrentMemoStatus,
  getUserDisplayName,
  toDisplayName,
} from "../controllers/memoStatus.controller";
import { notifyStatusUpdate } from "./memoNotification.service";
import { hasActiveExtraLine } from "./extraApproval.service";
import { sendEmail } from "../lib/mailer";
import { pushNoti } from "../lib/notify";
import { filterUsersForEmail } from "../lib/notificationPreferences";

/* ───── FRONTEND_URL ───── */
if (!process.env.FRONTEND_URL) {
  throw new Error("Environment variable FRONTEND_URL is not set");
}
const FRONTEND_URL: string = process.env.FRONTEND_URL as string;

// ─── Types ────────────────────────────────────────────────────────────────────

type ClonePivot = {
  id: number;
  userId: number | null;
  level: number;
  approvalRequirement?: string;
  user: { id: number; name: string } | null;
};

// ─── getLatestVersion ─────────────────────────────────────────────────────────

/**
 * Returns the latest version number for memoApproverAction rows of a given memo.
 * Defaults to 1 when no rows exist yet.
 */
export async function getLatestVersion(memoId: number): Promise<number> {
  const v = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  return v._max.version ?? 1;
}

// ─── getClonePivots (internal) ────────────────────────────────────────────────

async function getClonePivots(memoId: number): Promise<ClonePivot[]> {
  const latestVer = await getLatestVersion(memoId);

  const rows = await prisma.memoApproverAction.findMany({
    where: { memoId, version: latestVer },
    orderBy: [{ loaUser: { level: "asc" } }],
    distinct: ["loaUserId"],
    select: {
      loaUser: {
        select: {
          id: true,
          userId: true,
          level: true,
          approvalRequirement: true,
          user: {
            select: { id: true, name: true, lastname: true, nickname: true },
          },
        },
      },
    },
  }) as any[];

  return rows.map((r: any) => ({
    id: r.loaUser.id,
    userId: r.loaUser.userId,
    level: r.loaUser.level,
    approvalRequirement: r.loaUser.approvalRequirement ?? "ALL",
    user: r.loaUser.user
      ? {
          id: r.loaUser.user.id,
          name:
            toDisplayName(r.loaUser.user, { includeNickname: true }) ||
            `User#${r.loaUser.user.id}`,
        }
      : null,
  }));
}

// ─── upsertStatusWithHistory (internal) ──────────────────────────────────────

async function upsertStatusWithHistory(
  memoId: number,
  ownerId: number,
  newStatusId: number,
  _actorId: number | null,
  _actorName: string,
  _actionType: ActionType,
  _fileId?: number
) {
  await updateCurrentMemoStatus(memoId, ownerId, newStatusId);
}

// ─── evaluateAndUpdateMemoStatus ─────────────────────────────────────────────

/**
 * Core state machine: evaluates all approver actions for a memo and sets the
 * memo status to Approved (3), Rejected (4), or Processing (5).
 *
 * Called after every approver action (approve / reject / recall / processing).
 * Runs inside setImmediate in approveAction and actOnMemo to keep latency low.
 */
export async function evaluateAndUpdateMemoStatus(
  memoId: number,
  actorPivotId: number
): Promise<void> {
  const loaPivot = await prisma.lineOfApprovalUserPivotForUse.findUnique({
    where: { id: actorPivotId },
    include: {
      user: { select: { id: true, name: true, lastname: true, nickname: true } },
    },
  });
  if (!loaPivot) throw new Error("loaUserPivotId ไม่ถูกต้อง");

  const actorId = loaPivot.userId;
  const actorName = loaPivot.user?.name || "Unknown User";
  const myLevel = loaPivot.level;

  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true, subject: true },
  });
  if (!memo) throw new Error("memo not found");

  const approverPivots = await getClonePivots(memoId);
  const approverPivotIds = approverPivots.map((a) => a.id);

  const version = await getLatestVersion(memoId);
  const actions = (await prisma.memoApproverAction.findMany({
    where: { memoId, version, loaUserId: { in: approverPivotIds } },
    select: {
      id: true,
      loaUserId: true,
      status: { select: { code: true } },
      loaUser: { select: { level: true, approvalRequirement: true } },
    },
  })) as any[];

  // Group actions by level
  const actionsByLevel = new Map<number, typeof actions>();
  for (const action of actions) {
    const level = action.loaUser.level;
    const levelActions = actionsByLevel.get(level) || [];
    levelActions.push(action);
    actionsByLevel.set(level, levelActions);
  }

  // Group approver pivots by level
  const pivotsByLevel = new Map<number, typeof approverPivots>();
  for (const pivot of approverPivots) {
    const level = pivot.level;
    const levelPivots = pivotsByLevel.get(level) || [];
    levelPivots.push(pivot);
    pivotsByLevel.set(level, levelPivots);
  }

  // Check if any level has rejected actions
  let anyRejected = false;
  for (const levelActions of actionsByLevel.values()) {
    if (levelActions.some((a: any) => a.status.code === "rejected")) {
      anyRejected = true;
      break;
    }
  }

  // Check if all levels are approved based on approval requirements
  let allLevelsApproved = true;

  for (const [level, levelPivots] of pivotsByLevel) {
    const levelActions = actionsByLevel.get(level) || [];

    if (levelPivots.length === 0) continue;

    const approvalRequirement = levelPivots[0].approvalRequirement || "ALL";

    const approvedActions = levelActions.filter(
      (a: any) => a.status.code === "approved"
    );
    const rejectedActions = levelActions.filter(
      (a: any) => a.status.code === "rejected"
    );

    if (approvalRequirement === "ANY") {
      const hasApproval = approvedActions.length > 0;
      const allRejected = rejectedActions.length === levelPivots.length;

      if (allRejected || !hasApproval) {
        allLevelsApproved = false;
        break;
      }
    } else {
      // ALL requirement
      const allApproved = approvedActions.length === levelPivots.length;
      if (!allApproved) {
        allLevelsApproved = false;
        break;
      }
    }
  }

  if (anyRejected) {
    await upsertStatusWithHistory(
      memoId,
      memo.userId,
      4,
      actorId,
      actorName,
      ActionType.REJECT
    );
    if (actorId) {
      await notifyStatusUpdate(memoId, actorId, actorName, 4, myLevel);
    }
  } else if (allLevelsApproved) {
    await upsertStatusWithHistory(
      memoId,
      memo.userId,
      3,
      actorId,
      actorName,
      ActionType.APPROVE
    );
    if (actorId) {
      await notifyStatusUpdate(memoId, actorId, actorName, 3, myLevel);
    }
  } else {
    await upsertStatusWithHistory(
      memoId,
      memo.userId,
      5,
      actorId,
      actorName,
      ActionType.PROCESSING
    );
    if (actorId) {
      await notifyStatusUpdate(memoId, actorId, actorName, 5, myLevel);
    }
  }
}

// ─── approveAction ────────────────────────────────────────────────────────────

/**
 * POST /api/memos/:id/approve
 *
 * Validates approver authorization, records the action, returns 200 immediately,
 * then fires evaluateAndUpdateMemoStatus + optional approve-with-condition emails
 * asynchronously via setImmediate (preserves original async behaviour).
 */
export const approveAction: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  if (await hasActiveExtraLine(memoId)) {
    res
      .status(409)
      .json({ error: "มีการอนุมัติพิเศษค้างอยู่ ต้องปิดให้เสร็จก่อน" });
    return;
  }

  const actionTypeMap: Record<string, ActionType> = {
    approved: ActionType.APPROVE,
    rejected: ActionType.REJECT,
    processing: ActionType.PROCESSING,
    recalled: ActionType.RECALL,
    terminated: ActionType.TERMINATE,
    draft: ActionType.DRAFT,
  };

  const actionVerbMap: Record<string, string> = {
    approved: "approved",
    rejected: "rejected",
    processing: "marked as processing",
    recalled: "recalled",
    terminated: "terminated",
    draft: "set to draft",
  };

  const {
    loaUserId,
    statusCode,
    signatureImageId,
    signatureText,
    approveWithCondition,
  } = req.body;

  if (isNaN(memoId) || !loaUserId || !statusCode) {
    res.status(400).json({ error: "Invalid data" });
    return;
  }

  try {
    const actorId = req.user!.id;

    // Check current memo status
    const currentStatusPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: "desc" },
      include: { status: { select: { id: true, name: true } } },
    });

    const currentStatusId = currentStatusPivot?.status?.id ?? null;
    const currentStatusName = currentStatusPivot?.status?.name ?? "Unknown";

    console.log(
      `[approveAction] memoId=${memoId}, action=${statusCode}, currentStatus=${currentStatusName}(${currentStatusId}), actor=${actorId}`
    );

    // For approve/reject, memo must be in "Processing" (statusId = 5)
    if (statusCode === "approved" || statusCode === "rejected") {
      if (currentStatusId !== 5) {
        console.warn(
          `[approveAction] BLOCKED: memoId=${memoId} is not in Processing. Current status: ${currentStatusName}(${currentStatusId}). Action: ${statusCode} by user ${actorId}`
        );

        const statusCodeMap: Record<number, string> = {
          1: "DRAFT_APPROVE",
          3: "APPROVED",
          4: "REJECTED",
          6: "RECALLED",
          7: "TERMINATED",
          8: "EXPIRED",
        };

        const statusCodeKey =
          statusCodeMap[currentStatusId ?? 0] || "UNKNOWN";

        res.status(409).json({
          code: "MEMO_STATUS_CHANGED",
          statusCode: statusCodeKey,
          currentStatus: currentStatusName,
          currentStatusId,
        });
        return;
      }
    }

    // Check if current user can act on behalf of assigned approver
    const approverAction = await prisma.memoApproverAction.findFirst({
      where: {
        memoId,
        loaUserId,
        version: {
          in: await prisma.memoApproverAction
            .findMany({
              where: { memoId },
              select: { version: true },
              orderBy: { version: "desc" },
              take: 1,
            })
            .then((versions) => versions.map((v) => v.version)),
        },
      },
      include: {
        loaUser: {
          include: {
            user: {
              include: {
                delegatedToUser: true,
              },
            },
          },
        },
      },
    });

    if (!approverAction) {
      res.status(404).json({ error: "Approver action not found" });
      return;
    }

    const originalUserId =
      approverAction.assignedUserId ??
      approverAction.loaUser?.userId ??
      null;
    let canApprove = false;
    let isDelegatedApproval = false;
    let delegationInfo = null;

    if (originalUserId === actorId) {
      canApprove = true;
    } else if (originalUserId && approverAction.loaUser?.user) {
      const originalUser = approverAction.loaUser.user;
      if (
        originalUser.delegatedToUserId === actorId &&
        originalUser.delegationStartDate &&
        originalUser.delegationEndDate
      ) {
        const now = new Date();
        const isActiveDelegation =
          now >= originalUser.delegationStartDate &&
          now <= originalUser.delegationEndDate;

        if (isActiveDelegation) {
          canApprove = true;
          isDelegatedApproval = true;
          delegationInfo = {
            originalUserId: originalUserId,
            originalUserName: `${originalUser.name} ${
              originalUser.lastname || ""
            }`.trim(),
            delegatedUserName: `${
              originalUser.delegatedToUser?.name
            } ${originalUser.delegatedToUser?.lastname || ""}`.trim(),
            startDate: originalUser.delegationStartDate,
            endDate: originalUser.delegationEndDate,
          };
        }
      }
    }

    if (!canApprove) {
      res
        .status(403)
        .json({ error: "You are not authorized to approve this memo" });
      return;
    }

    // 1) lookup statusId by code
    const statusRec = await prisma.approvalActionStatus.findUnique({
      where: { code: statusCode },
      select: { id: true },
    });
    if (!statusRec) {
      res.status(400).json({ error: "Invalid statusCode" });
      return;
    }

    // 2) find latest version
    const { _max } = await prisma.memoApproverAction.aggregate({
      where: { memoId },
      _max: { version: true },
    });
    const latestVersion = _max.version ?? 1;

    // 3) update approver action row
    const action = await prisma.memoApproverAction.update({
      where: {
        memoId_loaUserId_version: {
          memoId,
          loaUserId,
          version: latestVersion,
        },
      },
      data: {
        statusId: statusRec.id,
        signatureImageId: signatureImageId
          ? Number(signatureImageId)
          : null,
        signatureText:
          (signatureText as string | undefined)?.trim() ?? null,
        actedAt: new Date(),
        actualActorId: actorId,
        approveWithCondition:
          (approveWithCondition as string | undefined)?.trim() || null,
      },
    });

    // 4) record memo history
    const actorName = await getUserDisplayName(actorId);

    const historyStatusName =
      statusCode.charAt(0).toUpperCase() + statusCode.slice(1);
    const historyStatus = await prisma.status.findFirst({
      where: { name: historyStatusName },
      select: { id: true },
    });

    let historyAction = `${actorName} ${
      actionVerbMap[statusCode] ?? statusCode
    } the memo`;
    if (approveWithCondition?.trim()) {
      historyAction += ` (with condition: ${approveWithCondition.trim()})`;
    }
    if (isDelegatedApproval && delegationInfo) {
      historyAction += ` (on behalf of ${delegationInfo.originalUserName})`;
    }

    await prisma.memoHistory.create({
      data: {
        memoId,
        userId: actorId,
        statusId: historyStatus?.id,
        action: historyAction,
        actiontype: actionTypeMap[statusCode] ?? ActionType.UPDATE,
        timestamp: new Date(),
      },
    });

    // 5) FAST PATH — respond immediately
    res.status(200).json({
      ...action,
      isDelegatedApproval,
      delegationInfo,
    });

    // 6) HEAVY PATH (async) — evaluate state machine + optional condition email
    setImmediate(async () => {
      try {
        await evaluateAndUpdateMemoStatus(memoId, loaUserId);
      } catch (e) {
        console.error("evaluateAndUpdateMemoStatus (async) failed:", e);
      }

      // Send approve-with-condition emails
      if (approveWithCondition?.trim()) {
        try {
          const conditionText = approveWithCondition.trim();
          const actorNameForEmail = await getUserDisplayName(actorId);

          const memoData = await prisma.masterMemo.findUnique({
            where: { id: memoId },
            select: {
              userId: true,
              subject: true,
              memonumber: true,
              memoNumberRecord: { select: { memonumber: true } },
              memoType: { select: { name: true } },
              businessUnit: { select: { name: true } },
              department: { select: { name: true } },
            },
          });
          if (!memoData) return;

          const memoSubject = memoData.subject ?? `Memo #${memoId}`;
          const memoRef =
            memoData.memonumber ??
            memoData.memoNumberRecord?.memonumber ??
            `memo-${memoId}`;

          const recipientIds = new Set<number>();

          if (memoData.userId && memoData.userId !== actorId) {
            recipientIds.add(memoData.userId);
          }

          const ccUsers = await prisma.memoCc.findMany({
            where: { memoId },
            select: { userId: true },
          });
          for (const cc of ccUsers) {
            if (cc.userId !== actorId) {
              recipientIds.add(cc.userId);
            }
          }

          if (!recipientIds.size) return;

          const recipientArr = Array.from(recipientIds);
          const filteredIds = await filterUsersForEmail(
            recipientArr,
            "approve-with-condition"
          );
          if (!filteredIds.length) return;

          const notiMessage = `${actorNameForEmail} approved memo "${memoSubject}" with condition: ${conditionText}`;
          await pushNoti(
            filteredIds,
            actorId,
            {
              notificationTypeId: 3,
              memoId,
              statusId: 5,
              message: notiMessage,
            },
            "status-approved"
          );

          const users = await prisma.user.findMany({
            where: { id: { in: filteredIds } },
            select: {
              id: true,
              name: true,
              lastname: true,
              nickname: true,
              email: true,
            },
          });

          const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
          const typeName = memoData.memoType?.name ?? "Unknown";
          const buName = memoData.businessUnit?.name ?? "-";
          const deptName = memoData.department?.name ?? "-";

          for (const u of users) {
            if (!u.email) continue;
            const display = [u.name, u.lastname].filter(Boolean).join(" ");
            const nickname = (u as any).nickname;
            const displayName = nickname
              ? `${display} (${nickname})`
              : display || `User#${u.id}`;

            const emailSubject = `Memo ${memoRef}: Approved with Conditions by ${actorNameForEmail}`;
            const emailPlain = `Dear ${displayName},\n\n${actorNameForEmail} has approved memo "${memoSubject}" (${memoRef}) with the following condition:\n\n"${conditionText}"\n\nMemo Type: ${typeName}\nBusiness Unit: ${buName}\nDepartment: ${deptName}\n\nView memo: ${viewLink}\n`;
            const emailHtml = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f4f5f7;">
  <div style="max-width:600px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
    <div style="background:linear-gradient(135deg,#d97706,#f59e0b);padding:24px 28px;">
      <h2 style="margin:0;color:#374151;font-size:18px;">Approved with Conditions</h2>
      <p style="margin:6px 0 0;color:rgba(255,255,255,.9);font-size:13px;">${memoRef} — ${memoSubject}</p>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;color:#374151;">Dear <strong>${displayName}</strong>,</p>
      <p style="margin:0 0 16px;color:#374151;"><strong>${actorNameForEmail}</strong> has approved memo <strong>"${memoSubject}"</strong> with the following condition:</p>
      <div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:0 8px 8px 0;margin:0 0 16px;">
        <p style="margin:0;color:#92400e;font-weight:600;font-size:13px;">Condition:</p>
        <p style="margin:6px 0 0;color:#78350f;white-space:pre-wrap;">${conditionText}</p>
      </div>
      <table style="width:100%;margin:0 0 16px;font-size:13px;color:#6b7280;">
        <tr><td style="padding:4px 0;"><strong>Memo Type:</strong></td><td>${typeName}</td></tr>
        <tr><td style="padding:4px 0;"><strong>Business Unit:</strong></td><td>${buName}</td></tr>
        <tr><td style="padding:4px 0;"><strong>Department:</strong></td><td>${deptName}</td></tr>
      </table>
      <a href="${viewLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">View Memo</a>
    </div>
  </div>
</body>
</html>`;

            await sendEmail([u.email], emailSubject, emailPlain, emailHtml);
            console.log(
              `[approve-with-condition] email sent to ${u.email}`
            );
          }
        } catch (err) {
          console.error("approve-with-condition email failed:", err);
        }
      }
    });

    return;
  } catch (err) {
    console.error("approveAction failed:", err);
    res.status(500).json({ error: "Approve action failed" });
    return;
  }
};
