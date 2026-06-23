// src/controllers/memo.controller.ts

import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import {
  getUserDisplayName,
  toDisplayName,
  notifyStatusUpdate,
} from "./memoStatus.controller";
import { evaluateAndUpdateMemoStatus } from "../services/memoApproveAction.service";
import { getApproverLineStatus } from "../approverLine";
import { makeEmailToken } from "../lib/token";
import { ActionType, ExtraStatus, Prisma } from "@prisma/client";
import { AuthenticatedRequest } from "../types/request";
import { sendEmail } from "../lib/mailer";
import { verifyEmailToken } from "../lib/token";
import { toPublicUploadPath, UPLOADS_DIR } from "../middlewares/upload";
import sharp from "sharp";
import contentDisposition from "content-disposition";
import { decodeFilename, safeFileName } from "../lib/filename";
import { getUserId } from "../lib/filesec";
import { reserveMemoNumber } from "../lib/memoNumber";
import { pushNoti } from "../lib/notify";
import { filterUsersForEmail } from "../lib/notificationPreferences";
import { canViewMemo } from "../services/memoAccess.service";
import {
  hasActiveExtraLine,
} from "../services/extraApproval.service";
import { getWaitingStatusId } from "../services/memoQuery.service";
export {
  getAllMemos,
  searchMemosHandler,
  searchMemoStatsHandler,
  getCurrentApprovers,
  getMemoById,
  getApprovers,
  getMemoApprovalLine,
  getBusinessUnits,
  getApprovalLines,
  getAwaitingApproval,
  getWaitingStatusId,
} from "../services/memoQuery.service";
export {
  getCommentsByMemoId,
  addCommentToMemo,
  deleteComment,
  sendCommentEmailsAsync,
  sendDeleteCommentEmailsAsync,
} from "../services/memoComment.service";
export {
  recomputeExtraLineStatus,
  createExtraApprovalLine,
  appendExtraApprovers,
  actOnExtraApprovalLine,
  getActiveExtraApprovalLine,
  getActiveExtraApprovalLinesBulk,
  listExtraApprovalLines,
  removeExtraApprovalLine,
} from "../services/extraApproval.service";

/* ───── FRONTEND_URL: ต้องมีใน .env ───── */
if (!process.env.FRONTEND_URL) {
  throw new Error("Environment variable FRONTEND_URL is not set");
}
const FRONTEND_URL: string = process.env.FRONTEND_URL as string;

// ─── Lifecycle functions (Wave 9) — moved to memoLifecycle.service.ts ───
export {
  createMemo,
  updateMemo,
  deleteMemo,
  forceDeleteMemo,
  renewExpiry,
  parseExpiresAt,
  getStatusIdByName,
  absFromDbPath,
} from "../services/memoLifecycle.service";

// ─── PDF handlers (Wave 10) — moved to memoPdf.service.ts ───
export {
  uploadMainPDF,
  saveSignaturePosition,
  saveDatePosition,
  saveNotePosition,
  downloadMergedPdf,
  downloadRawPdf,
  getMainFilePdf,
} from "../services/memoPdf.service";

// GET /api/memos/:memoId/extra-approval-lines/:lineId?/eligible-users?q=...
export const searchEligibleUsersForExtra: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.memoId || req.params.id);
  const lineId = req.params.lineId ? Number(req.params.lineId) : null;
  const actorId = req.user!.id;
  const q = String(req.query.q || "").trim();

  if (!memoId || (req.params.lineId && !lineId)) {
    res.status(400).json({ error: "memoId/lineId ไม่ถูกต้อง" });
    return;
  }

  // ───────── ตรวจสิทธิ์ ─────────
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true },
  });
  if (!memo) {
    res.status(404).json({ error: "Memo not found" });
    return;
  }

  // 1) Owner
  const isOwner = memo.userId === actorId;

  // 2) Approver ที่ "กำลังรอ" ในเลเวลปัจจุบัน (ใช้ ForUse แล้ว)
  const { loaUserIdsAtLevel } = await getCurrentWaitingLevelInfo(memoId);

  const isCurrentLevelApprover =
    !!(await prisma.lineOfApprovalUserPivotForUse.findFirst({
      where: {
        id: { in: loaUserIdsAtLevel as number[] },
        memoId, // safety: ต้องเป็น memo เดียวกัน
        userId: actorId,
      },
      select: { id: true },
    }));

  // 3) ผู้อนุมัติใดๆ ใน "เวอร์ชันล่าสุด"
  const { _max } = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  const latestVersion = _max.version ?? 1;

  const isAnyApproverLatest = !!(await prisma.memoApproverAction.findFirst({
    where: {
      memoId,
      version: latestVersion,
      loaUser: { userId: actorId }, // ← loaUser = ForUse
    },
    select: { id: true },
  }));

  // 4) ผู้ถูก CC ในเมโม
  const isCc = !!(await prisma.memoCc.findFirst({
    where: { memoId, userId: actorId },
    select: { id: true },
  }));

  // 5) (ถ้ามี lineId) ผู้สร้าง extra line หรือคนที่อยู่ใน extra line นั้น
  let isExtraCreator = false;
  let isExtraApprover = false;

  if (lineId) {
    const extraLine = await prisma.extraApprovalLine.findFirst({
      where: { id: lineId, memoId }, // ensure belong to the same memo
      select: {
        createdById: true,
        approvers: { select: { userId: true } },
      },
    });

    if (!extraLine) {
      res.status(404).json({ error: "Extra line not found" });
      return;
    }

    isExtraCreator = extraLine.createdById === actorId;
    isExtraApprover = extraLine.approvers.some((a) => a.userId === actorId);
  } else {
    // ✅ กรณีไม่มี lineId (สร้างใหม่) ให้เช็คว่าเป็น Extra Approver ใน line ไหนก็ได้ของ memo นี้
    const anyExtra = await prisma.extraApprover.findFirst({
      where: {
        userId: actorId,
        extra: { memoId },
      },
      select: { id: true },
    });
    if (anyExtra) isExtraApprover = true;
  }

  // 6) ผู้ถูก Mention
  const isMentioned = !!(await prisma.commentTag.findFirst({
    where: { memoId, userId: actorId },
    select: { id: true },
  }));

  // รวมสิทธิ์ทั้งหมดที่อนุญาตให้ "ค้นหา"
  const allowed =
    isOwner ||
    isCurrentLevelApprover ||
    isAnyApproverLatest ||
    isCc ||
    isExtraCreator ||
    isExtraApprover ||
    isMentioned;

  if (!allowed) {
    res.status(403).json({ error: "ไม่มีสิทธิ์ค้นหาผู้อนุมัติพิเศษ" });
    return;
  }

  // ───────── ชุด "ต้องตัดออก" (กันเลือกซ้ำ/กันเลือกตัวเอง/owner) ─────────
  const approverUsers = await prisma.memoApproverAction.findMany({
    where: { memoId, version: latestVersion },
    select: {
      loaUser: {
        select: {
          userId: true,
          user: { select: { email: true } },
        },
      },
    },
  });

  const approverIdSet = new Set<number>(
    approverUsers
      .map((r) => r.loaUser?.userId)
      .filter((v): v is number => Number.isFinite(v)),
  );
  const approverEmailSet = new Set<string>(
    approverUsers
      .map((r) => r.loaUser?.user?.email?.toLowerCase())
      .filter((v): v is string => !!v),
  );


  // กัน "ตัวเอง" + "owner" + Approver หลัก
  const bannedIds = new Set<number>([
    ...approverIdSet,
    actorId,
    memo.userId,
  ]);
  const bannedEmails = new Set<string>([...approverEmailSet]);


  // ───────── ค้นหา (ตัดออกตั้งแต่ต้นทั้งตาม id และ email) ─────────
  const users = await prisma.user.findMany({
    where: {
      id: { notIn: Array.from(bannedIds) },
      ...(bannedEmails.size
        ? { email: { notIn: Array.from(bannedEmails) } }
        : {}),
      OR: q
        ? [
            { name: { contains: q, mode: "insensitive" } },
            { lastname: { contains: q, mode: "insensitive" } },
            { nickname: { contains: q, mode: "insensitive" } },
            { email: { contains: q, mode: "insensitive" } },
          ]
        : undefined,
    },
    orderBy: [{ name: "asc" }, { lastname: "asc" }],
    take: 20,
    select: {
      id: true,
      name: true,
      lastname: true,
      nickname: true,
      email: true,
      profileImagePath: true,
    },
  });

  res.json(users);
};

// Helper function to check for delegation and return effective approver
async function getEffectiveApprover(userId: number): Promise<{
  effectiveUserId: number;
  isDelegated: boolean;
  delegationInfo?: {
    originalUserId: number;
    originalUserName: string;
    delegatedUserName: string;
    startDate: Date;
    endDate: Date;
  };
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      delegatedToUser: {
        select: {
          id: true,
          name: true,
          lastname: true,
        },
      },
    },
  });

  if (!user) {
    return { effectiveUserId: userId, isDelegated: false };
  }

  // Check if user has active delegation
  if (
    user.delegatedToUserId &&
    user.delegationStartDate &&
    user.delegationEndDate
  ) {
    const now = new Date();
    const isActiveDelegation =
      now >= user.delegationStartDate && now <= user.delegationEndDate;

    if (isActiveDelegation && user.delegatedToUser) {
      return {
        effectiveUserId: user.delegatedToUserId,
        isDelegated: true,
        delegationInfo: {
          originalUserId: userId,
          originalUserName: `${user.name} ${user.lastname || ""}`.trim(),
          delegatedUserName:
            `${user.delegatedToUser.name} ${user.delegatedToUser.lastname || ""}`.trim(),
          startDate: user.delegationStartDate,
          endDate: user.delegationEndDate,
        },
      };
    }
  }

  return { effectiveUserId: userId, isDelegated: false };
}

// Get delegation info for multiple users (for memo creation)
export const getUsersDelegationInfo: RequestHandler = async (req, res) => {
  try {
    const userIds = req.body.userIds;
    if (!Array.isArray(userIds)) {
      res.status(400).json({ error: "userIds must be an array" });
      return;
    }

    const delegationInfos = await Promise.all(
      userIds.map(async (userId: number) => {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          include: {
            delegatedToUser: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
              },
            },
          },
        });

        if (!user) {
          return {
            originalUserId: userId,
            effectiveUserId: userId,
            isDelegated: false,
          };
        }

        // Check if user has active delegation
        if (
          user.delegatedToUserId &&
          user.delegationStartDate &&
          user.delegationEndDate
        ) {
          const now = new Date();
          const isActiveDelegation =
            now >= user.delegationStartDate && now <= user.delegationEndDate;

          if (isActiveDelegation && user.delegatedToUser) {
            const result = {
              originalUserId: userId,
              effectiveUserId: user.delegatedToUserId,
              isDelegated: true,
              delegationInfo: {
                originalUserId: userId,
                originalUserName: `${user.name} ${user.lastname || ""}`.trim(),
                delegatedUserName:
                  `${user.delegatedToUser.name} ${user.delegatedToUser.lastname || ""}`.trim(),
                startDate: user.delegationStartDate,
                endDate: user.delegationEndDate,
              },
              // Include the delegated user's full info for frontend display
              effectiveUser: {
                id: user.delegatedToUser.id,
                name: user.delegatedToUser.name,
                lastname: user.delegatedToUser.lastname,
                nickname: user.delegatedToUser.nickname,
              },
            };
            return result;
          }
        }

        return {
          originalUserId: userId,
          effectiveUserId: userId,
          isDelegated: false,
        };
      }),
    );

    res.json(delegationInfos);
  } catch (error) {
    console.error("Failed to get users delegation info:", error);
    res.status(500).json({ error: "Failed to get delegation info" });
  }
};

/** คืน {version, baseLevel, loaUserIdsAtLevel} ของเวอร์ชันล่าสุด */
async function getCurrentWaitingLevelInfo(memoId: number) {
  const waitingId = await getWaitingStatusId();
  const { _max } = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  const version = _max.version ?? 1;

  // หา waiting ทั้งหมดของเวอร์ชันนี้ พร้อมข้อมูล approvalRequirement
  const waiting = await prisma.memoApproverAction.findMany({
    where: { memoId, version, statusId: waitingId },
    include: { 
      loaUser: { 
        select: { 
          id: true, 
          level: true, 
          approvalRequirement: true 
        } 
      } 
    },
    orderBy: { loaUser: { level: "asc" } },
  });
  
  if (!waiting.length)
    return { version, baseLevel: 1, loaUserIdsAtLevel: [] as number[] };

  // Get all actions for this version to check if ANY requirements are met
  const allActions = await prisma.memoApproverAction.findMany({
    where: { memoId, version },
    include: {
      loaUser: { select: { level: true, approvalRequirement: true } },
      status: { select: { code: true } }
    },
  });

  // Group actions by level
  const actionsByLevel = new Map<number, typeof allActions>();
  for (const action of allActions) {
    const level = action.loaUser.level;
    const levelActions = actionsByLevel.get(level) || [];
    levelActions.push(action);
    actionsByLevel.set(level, levelActions);
  }

  // Find the first level that is truly waiting (not satisfied by ANY requirement)
  const uniqueLevels = Array.from(new Set(waiting.map(w => w.loaUser.level))).sort((a, b) => a - b);
  
  for (const level of uniqueLevels) {
    const levelWaiting = waiting.filter(w => w.loaUser.level === level);
    if (levelWaiting.length === 0) continue;
    
    const approvalRequirement = levelWaiting[0].loaUser.approvalRequirement || "ALL";
    
    // Check if this level's ANY requirement is already satisfied
    if (approvalRequirement === "ANY") {
      const levelActions = actionsByLevel.get(level) || [];
      const hasApproval = levelActions.some(a => a.status.code === "approved");
      
      if (hasApproval) {
        // This level is satisfied, skip to next level
        continue;
      }
    }
    
    // This is the actual waiting level
    const ids = levelWaiting.map((w) => w.loaUser.id);
    return { version, baseLevel: level, loaUserIdsAtLevel: ids };
  }

  // If we get here, all waiting levels are satisfied (shouldn't happen normally)
  const baseLevel = waiting[0].loaUser.level;
  const ids = waiting
    .filter((w) => w.loaUser.level === baseLevel)
    .map((w) => w.loaUser.id);
  return { version, baseLevel, loaUserIdsAtLevel: ids };
}

// recall handlers moved to memoRecall.service (Wave 8)
export { recallMemo, recallMemoPreserve } from "../services/memoRecall.service";

// POST /api/memos/:id/action-signature
// approveAction moved to memoApproveAction.service (Wave 7)
export { approveAction } from "../services/memoApproveAction.service";

// ===== MEMO REFERENCE ENDPOINTS (moved to memoReference.service.ts) =====
export {
  searchMemosForReference,
  getMemoReferences,
  updateMemoReferences,
  getReferenceMemoContent,
} from "../services/memoReference.service";

// ─── POST /api/memos/:id/renew-expiry ───
