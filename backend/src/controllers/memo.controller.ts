// src/controllers/memo.controller.ts

import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { PDFDocument, PDFPage, rgb, StandardFonts } from "pdf-lib";
import fs from "fs";
import path from "path";
import {
  getUserDisplayName,
  toDisplayName,
  notifyStatusUpdate,
} from "./memoStatus.controller";
import { evaluateAndUpdateMemoStatus } from "../services/memoApproveAction.service";
import { getApproverLineStatus } from "../approverLine";
import { makeEmailToken } from "../lib/token";
// @ts-ignore
import fontkit from "fontkit";
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
import { createPdfForDownload } from "../services/pdf.core";
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

async function getStatusIdByName(name: string) {
  const rec = await prisma.status.findFirst({
    where: { name },
    select: { id: true },
  });
  if (!rec) throw new Error(`ต้องมี Status.name = "${name}" ในตาราง Status`);
  return rec.id;
}
function parseExpiresAt(raw?: unknown): Date | null | undefined {
  if (raw === undefined) return undefined; // ไม่แตะค่า (useful สำหรับ update)
  const s = String(raw).trim();
  if (!s) return null; // ล้างเป็น NULL

  // รับจาก <input type="date" /> -> 'YYYY-MM-DD'
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    // เก็บสิ้นวันแบบ UTC เพื่อกัน timezone เพี้ยน
    return new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
  }

  const dt = new Date(s);
  return isNaN(dt.getTime()) ? null : dt; // string อื่น ๆ/ISO
}

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



// src/controllers/memo.controller.ts
export const createMemo: RequestHandler = async (req, res) => {
  let memo: any = null;
  try {
    /* -------- 1. แปลงค่าจาก body -------- */
    const {
      subject,
      businessUnitId,
      departmentId,
      userId,
      memotypeId,
      approvalLineId,
      sigPositions,
      datePositions,
      memoNumberPositions,
      notePositions,

      statusId,
      fileOrderTokens,
    } = req.body;

    type OverrideItem = {
      userId: number | null; // ✅ Allow null for flexible slots
      level: number;
      isSigReq?: boolean;
      roleDescription?: string | null;
      slotType?:
        | "FIXED_USER"
        | "MEMO_REQUESTER"
        | "DEPARTMENT_HEAD"
        | "FLEXIBLE_SLOT"
        | null;
      loaUserPivotId?: number | null;
      approvalRequirement?: "ALL" | "ANY"; // ✅ Add this field
    };

    let approversOverride: OverrideItem[] = [];
    try {
      approversOverride = JSON.parse(
        String(req.body.approversOverride ?? "[]"),
      );
      console.log(
        "📋 [createMemo] Received approversOverride:",
        JSON.stringify(approversOverride, null, 2),
      );
    } catch (err) {
      console.error("❌ [createMemo] Failed to parse approversOverride:", err);
      approversOverride = [];
    }
    const hasOverride =
      Array.isArray(approversOverride) && approversOverride.length > 0;

    // ✅ กัน 0/NaN ให้เป็น null
    const toIntOrNull = (v: any) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };

    const buId = toIntOrNull(businessUnitId)!;
    const deptIdNum = toIntOrNull(departmentId);
    const userIdNum = toIntOrNull(userId)!;
    const typeIdNum = memotypeId ? toIntOrNull(memotypeId) : null;
    const lineIdNum = toIntOrNull(approvalLineId);
    const initStatus = +statusId === 2 ? 2 : 1;

    /* -------------------------------------------------------------
       2) จอง MemoNumber (แบบใหม่ - ไม่ต้อง retry loop)
       ✅ ใช้ BU-Department จาก MemoType แทนที่จะใช้จาก User
    --------------------------------------------------------------*/
    // ✅ ดึง MemoType พร้อม BU และ Department ของมัน
    const typeRec = typeIdNum
      ? await prisma.memoType.findUnique({
          where: { id: typeIdNum },
          select: {
            abbreviation: true,
            businessUnitId: true,
            departmentId: true,
            businessUnit: { select: { abbreviation: true } },
            department: { select: { abbreviation: true } },
          },
        })
      : null;

    if (!typeRec) {
      res.status(400).json({ error: "MemoType not found" });
      return;
    }

    // ✅ ใช้ BU-Department จาก MemoType
    const memoTypeBuId = typeRec.businessUnitId;
    const memoTypeDeptId = typeRec.departmentId;

    if (!memoTypeBuId) {
      res.status(400).json({ error: "MemoType must have a Business Unit" });
      return;
    }

    const buAbbr = typeRec.businessUnit?.abbreviation ?? "";
    // ✅ ถ้าไม่มี department ใน memotype ให้ใช้ BU abbreviation แทน
    const deptAbbr = typeRec.department?.abbreviation ?? buAbbr;
    const typeAbbr = typeRec.abbreviation ?? "";

    const expCreate = parseExpiresAt(req.body.expiresAt);

    // ✅ จอง MemoNumber แบบ atomic โดยใช้ BU-Department จาก MemoType
    const memoNumberRecord = await reserveMemoNumber({
      businessUnitId: memoTypeBuId,
      departmentId: memoTypeDeptId,
      memotypeId: typeIdNum,
      buAbbr,
      deptAbbr,
      typeAbbr,
    });

    // ✅ สร้าง MasterMemo
    memo = await prisma.masterMemo.create({
      data: {
        subject,
        memonumber: memoNumberRecord.memonumber,
        memoNumberId: memoNumberRecord.id,
        businessUnitId: buId,
        ...(deptIdNum ? { departmentId: deptIdNum } : {}),
        userId: userIdNum,
        memotypeId: typeIdNum,
        approvalLineId: lineIdNum ?? null,
        ...(expCreate !== undefined ? { expiresAt: expCreate } : {}),
        statuses: { create: { statusId: initStatus, userId: userIdNum } },
      },
    });

    /* -------------------------------------------------------------
       3) ไฟล์หลัก/แนบ + order + map index → mainFileId
    --------------------------------------------------------------*/
    const allFiles = req.files as {
      [fieldname: string]: Express.Multer.File[];
    };
    const mainFiles = allFiles?.files || [];
    const attachedFiles = allFiles?.attachedFiles || [];

    if (!mainFiles.length) {
      res.status(400).json({ error: "No PDF files uploaded" });
      return;
    }

    const created = await Promise.all(
      mainFiles.map((f, idx) =>
        prisma.mainFile.create({
          data: {
            memoId: memo.id,
            filePath: toPublicUploadPath(f.path),
            fileName: decodeFilename(f.originalname),
            size: f.size,
            orderNo: idx,
          },
        }),
      ),
    );

    let tokens: string[] = [];
    try {
      tokens = JSON.parse(fileOrderTokens || "[]");
    } catch {
      tokens = [];
    }

    let finalOrder: number[];
    if (tokens.length) {
      finalOrder = [];
      for (const tk of tokens) {
        if (!tk.startsWith("new:")) continue;
        const idx = Number(tk.slice(4));
        if (!Number.isNaN(idx) && created[idx])
          finalOrder.push(created[idx].id);
      }
      const allIds = new Set(created.map((c) => c.id));
      finalOrder.forEach((id) => allIds.delete(id));
      finalOrder.push(...allIds);
    } else {
      finalOrder = created.map((c) => c.id);
    }

    await prisma.$transaction(
      finalOrder.map((fileId, orderNo) =>
        prisma.mainFile.update({ where: { id: fileId }, data: { orderNo } }),
      ),
    );

    const fileIdMap: Record<number, number> = {};
    finalOrder.forEach((mfId, displayIdx) => (fileIdMap[displayIdx] = mfId));

    await Promise.all(
      attachedFiles.map((f) =>
        prisma.attachedFile.create({
          data: {
            memoId: memo.id,
            fileName: decodeFilename(f.originalname),
            filePath: toPublicUploadPath(f.path),
            fileType: f.mimetype,
            size: f.size,
            isUrl: false,
          },
        }),
      ),
    );

    // Handle URL link attachments
    let urlLinks: Array<{ url: string; title: string }> = [];
    try {
      urlLinks = JSON.parse(String(req.body.urlLinks ?? "[]"));
    } catch (e) {
      console.error("Failed to parse urlLinks:", e);
      urlLinks = [];
    }

    if (urlLinks.length > 0) {
      try {
        await Promise.all(
          urlLinks.map((link) =>
            prisma.attachedFile.create({
              data: {
                memoId: memo.id,
                fileName: link.title || link.url,
                url: link.url,
                isUrl: true,
                fileType: "url/link",
                size: 0,
                filePath: null, // Explicitly set to null for URL links
              },
            }),
          ),
        );
      } catch (urlError) {
        console.error("Failed to create URL link attachments:", urlError);
        throw urlError;
      }
    }

    /* -------------------------------------------------------------
       4) ตำแหน่งลายเซ็น/วันที่/เลขเอกสาร
    --------------------------------------------------------------*/
    type SigPos = {
      userId: number;
      fileIdx: number;
      page: number;
      x: number;
      y: number;
      sizePct?: number;
      level?: number; // Approval level this signature belongs to
    };
    type DatePos = SigPos & { date: string };
    type NotePos = {
      id?: number | string;
      fileIdx: number;
      page: number;
      x: number;
      y: number;
      text: string;
      sizePct?: number;
    };
    type MemoNumPos = {
      id?: number | string;
      fileIdx: number;
      page: number;
      x: number;
      y: number;
      sizePct?: number;
    };

    const sigs: SigPos[] = JSON.parse(sigPositions || "[]");
    const dates: DatePos[] = JSON.parse(datePositions || "[]");
    const notes: NotePos[] = JSON.parse(notePositions || "[]");
    const memoNums: MemoNumPos[] = JSON.parse(memoNumberPositions || "[]");

    await prisma.$transaction([
      ...sigs.map((p) =>
        prisma.signaturePosition.create({
          data: {
            memoId: memo.id,
            fileId: fileIdMap[p.fileIdx],
            userId: p.userId,
            page: p.page,
            x: +p.x.toFixed(6),
            y: +p.y.toFixed(6),
            sizePct: p.sizePct ?? 100,
            level: p.level ?? null,
          },
        }),
      ),
      ...dates.map((p) => {
        const cleanDate = new Date(
          new Date(p.date).toLocaleDateString("sv-SE"),
        );
        return prisma.datePosition.create({
          data: {
            memoId: memo.id,
            fileId: fileIdMap[p.fileIdx],
            userId: p.userId,
            page: p.page,
            x: +p.x.toFixed(6),
            y: +p.y.toFixed(6),
            sizePct: p.sizePct ?? 100,
            date: cleanDate,
            level: p.level ?? null,
          },
        });
      }),
      ...notes.map((p) =>
        prisma.notePosition.create({
          data: {
            memoId: memo.id,
            fileId: fileIdMap[p.fileIdx],
            page: p.page,
            x: +p.x.toFixed(6),
            y: +p.y.toFixed(6),
            text: p.text,
            sizePct: p.sizePct ?? 100,
          },
        }),
      ),
      ...memoNums.map((p) =>
        prisma.memoNumberPosition.create({
          data: {
            memoId: memo.id,
            fileId: fileIdMap[p.fileIdx],
            page: p.page,
            x: +p.x.toFixed(6),
            y: +p.y.toFixed(6),
            sizePct: p.sizePct ?? 100,
          },
        }),
      ),
    ]);

    /* -------------------------------------------------------------
       5) เตรียมรายชื่อผู้อนุมัติ "ล่วงหน้า" + ForUse slots with delegation resolution
    --------------------------------------------------------------*/
    type SlotT =
      | "FIXED_USER"
      | "MEMO_REQUESTER"
      | "DEPARTMENT_HEAD"
      | "FLEXIBLE_SLOT"
      | null;

    const resolveFlexibleSlot = async (
      slotType: Exclude<SlotT, "FIXED_USER" | "FLEXIBLE_SLOT" | null> | string,
      memoCreatorId: number,
      memoCreatorDeptId: number | null,
    ): Promise<number | null> => {
      switch (slotType) {
        case "MEMO_REQUESTER":
          return memoCreatorId;
        case "DEPARTMENT_HEAD":
          if (!memoCreatorDeptId) return null;
          {
            const deptHead = await prisma.user.findFirst({
              where: {
                departmentId: memoCreatorDeptId,
                OR: [
                  { role: { contains: "head", mode: "insensitive" } },
                  { role: { contains: "manager", mode: "insensitive" } },
                  { role: { contains: "supervisor", mode: "insensitive" } },
                ],
              },
              select: { id: true },
            });
            return deptHead?.id ?? null;
          }
        default:
          return null;
      }
    };

    // Helper function to resolve delegation for a user
    const resolveDelegation = async (userId: number): Promise<number> => {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          delegatedToUserId: true,
          delegationStartDate: true,
          delegationEndDate: true,
        },
      });

      if (!user) return userId;

      // Check if user has active delegation
      if (
        user.delegatedToUserId &&
        user.delegationStartDate &&
        user.delegationEndDate
      ) {
        const now = new Date();
        const isActiveDelegation =
          now >= user.delegationStartDate && now <= user.delegationEndDate;

        if (isActiveDelegation) {
          return user.delegatedToUserId; // Return delegated user ID
        }
      }

      return userId; // Return original user ID if no active delegation
    };

    type ForUseSlotInput = {
      memoId: number;
      userId: number | null;
      level: number;
      isSigReq: boolean;
      roleDescription: string | null;
      slotType: SlotT;
      templatePivotId?: number | null;
      approvalRequirement?: "ALL" | "ANY";
    };

    let forUseSlots: ForUseSlotInput[] = [];

    // 5.1 กรณีมี override จากหน้าบ้าน
    if (hasOverride) {
      const sorted = [...approversOverride].sort(
        (a, b) => (a.level ?? 0) - (b.level ?? 0),
      );

      forUseSlots = await Promise.all(
        sorted.map(async (o) => {
          const slot: SlotT = o.slotType ?? null;
          let resolvedUserId = o.userId ?? null;

          // ✅ Validate userId - must be a valid number or null for flexible slots
          if (resolvedUserId !== null) {
            const userIdNum = Number(resolvedUserId);
            if (!Number.isFinite(userIdNum) || userIdNum <= 0) {
              console.warn(
                `⚠️ Invalid userId in override: ${resolvedUserId}, setting to null`,
              );
              resolvedUserId = null;
            } else {
              resolvedUserId = userIdNum;
              // Resolve delegation if userId is valid
              resolvedUserId = await resolveDelegation(resolvedUserId);
            }
          }

          return {
            memoId: memo.id,
            userId: resolvedUserId,
            level: Number.isFinite(o.level as any) ? Number(o.level) : 0,
            isSigReq: !!o.isSigReq,
            roleDescription: o.roleDescription ?? null,
            slotType: slot,
            templatePivotId: null, // ✅ Override approvers are always ad-hoc, not from template
            approvalRequirement:
              (o.approvalRequirement as "ALL" | "ANY") ?? "ALL",
          };
        }),
      );
    }
    // 5.2 กรณีใช้ template line ตรง ๆ
    else if (lineIdNum) {
      const templatePivots = (await prisma.lineOfApprovalUserPivot.findMany({
        where: { lineOfApprovalId: lineIdNum },
        orderBy: { level: "asc" },
        select: {
          id: true,
          userId: true,
          level: true,
          isSigReq: true,
          roleDescription: true,
          slotType: true,
          approvalRequirement: true,
        },
      })) as any[];

      for (const p of templatePivots) {
        const slot = (p.slotType ?? "FIXED_USER") as SlotT;
        let actualUserId: number | null = null;

        if (slot === "FLEXIBLE_SLOT") {
          // ✅ เคสนี้จงใจให้ userId = null แต่ "ต้องมี row" ใน ForUse
          actualUserId = null;
        } else if (slot && slot !== "FIXED_USER") {
          // MEMO_REQUESTER / DEPARTMENT_HEAD
          actualUserId = await resolveFlexibleSlot(
            slot,
            userIdNum,
            deptIdNum ?? null,
          );
          // Resolve delegation for flexible slots too
          if (actualUserId) {
            actualUserId = await resolveDelegation(actualUserId);
          }
        } else {
          // FIXED_USER
          if (p.userId == null) continue;
          // Resolve delegation for fixed users
          actualUserId = await resolveDelegation(p.userId);
        }

        forUseSlots.push({
          memoId: memo.id,
          userId: actualUserId,
          level: p.level,
          isSigReq: p.isSigReq,
          roleDescription: p.roleDescription ?? null,
          slotType: slot,
          templatePivotId: p.id,
          approvalRequirement:
            ((p as any).approvalRequirement as "ALL" | "ANY") ?? "ALL",
        });
      }
    }

    // ใช้ userId จาก ForUse slot เพื่อตัดออกจาก CC
    const approverUserIdSet = new Set(
      forUseSlots
        .map((p) => p.userId)
        .filter(
          (u): u is number => typeof u === "number" && Number.isFinite(u),
        ),
    );

    /* -------------------------------------------------------------
       5.1) บันทึก CC (Users + Groups) โดยกรอง owner/approver ออก
    --------------------------------------------------------------*/
    const parseIds = (v: any): number[] => {
      try {
        if (Array.isArray(v))
          return v.map(Number).filter((n) => Number.isFinite(n) && n > 0);
        if (typeof v === "string" && v.trim().startsWith("[")) {
          const arr = JSON.parse(v);
          return Array.isArray(arr)
            ? arr.map(Number).filter((n) => Number.isFinite(n) && n > 0)
            : [];
        }
        return [];
      } catch {
        return [];
      }
    };

    const rawCcUserIds = parseIds(
      (req.body.ccUsers ?? req.body.ccUserIds ?? req.body.cc)?.map?.(
        (x: any) => x?.id ?? x,
      ) ??
        req.body.ccUsers ??
        req.body.ccUserIds ??
        req.body.cc,
    );

    const rawGroupInput =
      req.body.ccGroupIds ?? req.body.ccGroups ?? req.body.groups;
    const rawCcGroupIds = parseIds(
      rawGroupInput?.map?.((x: any) => x?.id ?? x) ?? rawGroupInput,
    );

    let groupMemberUserIds: number[] = [];
    if (rawCcGroupIds.length) {
      const members = await prisma.ccGroupMember.findMany({
        where: { groupId: { in: rawCcGroupIds } },
        select: { userId: true },
      });
      groupMemberUserIds = members.map((m) => m.userId);
    }

    const ccUserSet = new Set<number>(
      [...rawCcUserIds, ...groupMemberUserIds].filter(
        (u) =>
          Number.isFinite(u) &&
          u > 0 &&
          u !== userIdNum &&
          !approverUserIdSet.has(u),
      ),
    );

    if (ccUserSet.size) {
      await prisma.memoCc.createMany({
        data: Array.from(ccUserSet).map((uid) => ({
          memoId: memo.id,
          userId: uid,
        })),
        skipDuplicates: true,
      });
    }

    /* -------------------------------------------------------------
       6) เขียน approver ForUse slots & actions
    --------------------------------------------------------------*/
    const waitingId = await getWaitingStatusId();

    let createdSlots: { id: number; userId: number | null }[] = [];
    if (forUseSlots.length) {
      // Fix: Reset the auto-increment sequence before creating new records
      await prisma.$executeRaw`
        SELECT setval(
          pg_get_serial_sequence('"LineOfApprovalUserPivotForUse"', 'id'),
          COALESCE((SELECT MAX(id) FROM "LineOfApprovalUserPivotForUse"), 0) + 1,
          false
        )
      `;

      // ✅ Let database handle auto-increment naturally - don't manually set IDs
      createdSlots = await prisma.$transaction(
        forUseSlots.map((slot) =>
          prisma.lineOfApprovalUserPivotForUse.create({
            data: slot,
            select: { id: true, userId: true },
          }),
        ),
      );

      await prisma.$transaction(
        createdSlots.map((slot, idx) =>
          prisma.memoApproverAction.create({
            data: {
              memoId: memo.id,
              loaUserId: slot.id,
              statusId: waitingId,
              version: 1,
              assignedUserId: forUseSlots[idx].userId ?? null,
            },
          }),
        ),
      );
    }

    const view = await prisma.masterMemo.findUnique({
      where: { id: memo.id },
      select: {
        id: true,
        memonumber: true,
        subject: true,
        approvalLineId: true,
        businessUnitId: true,
        departmentId: true,
        userId: true,
        memotypeId: true,
        expiresAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    res.status(201).json(view);
    return;
  } catch (err: any) {
    console.error("❌ createMemo failed", err);
    console.error("❌ Error details:", {
      message: err?.message,
      code: err?.code,
      meta: err?.meta,
      stack: err?.stack?.split("\n").slice(0, 5).join("\n"),
    });

    // ============================================================
    // COMPENSATION LOGIC: ลบ Memo ที่เพิ่งสร้างถ้ามี Error
    // ============================================================
    if (memo && memo.id) {
      try {
        console.warn(`⚠️ Rolling back memo #${memo.id} due to error...`);

        // ลบข้อมูลที่เกี่ยวข้องทั้งหมดใน Transaction
        await prisma.$transaction(async (tx) => {
          // 1. ลบ Main Files
          await tx.mainFile.deleteMany({
            where: { memoId: memo.id },
          });

          // 2. ลบ Attached Files
          await tx.attachedFile.deleteMany({
            where: { memoId: memo.id },
          });

          // 3. ลบ Positions (Signature, Date, MemoNumber)
          await tx.signaturePosition.deleteMany({
            where: { memoId: memo.id },
          });
          await tx.datePosition.deleteMany({
            where: { memoId: memo.id },
          });
          await tx.memoNumberPosition.deleteMany({
            where: { memoId: memo.id },
          });

          // 4. ลบ CC
          await tx.memoCc.deleteMany({
            where: { memoId: memo.id },
          });

          // 5. ลบ Approver Actions & ForUse Pivots
          await tx.memoApproverAction.deleteMany({
            where: { memoId: memo.id },
          });
          await tx.lineOfApprovalUserPivotForUse.deleteMany({
            where: { memoId: memo.id },
          });

          // 6. ลบ Status Pivots
          await tx.memoStatusPivot.deleteMany({
            where: { memoId: memo.id },
          });

          // 7. ลบ MasterMemo สุดท้าย
          await tx.masterMemo.delete({
            where: { id: memo.id },
          });
        });

        console.log(
          `✅ Rollback successful. Memo #${memo.id} and all related data deleted.`,
        );
      } catch (rollbackErr) {
        console.error("🔥 Rollback failed:", rollbackErr);
        // ถึงแม้ rollback ล้มเหลว ยังคงส่ง error กลับไปหา user
      }
    }

    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
};

export const updateMemo: RequestHandler = async (req, res) => {
  /* ---------- 0. debug form-data ---------- */
  console.log("[updateMemo] Called with id:", req.params.id);

  if (req.headers["content-type"]?.includes("multipart/form-data")) {
    const allFiles = req.files as {
      [fieldname: string]: Express.Multer.File[];
    };
    console.log("[updateMemo] Files received:", Object.keys(allFiles || {}));
    Object.entries(allFiles || {}).forEach(([field, files]) => {
      files.forEach((f, i) => {
        console.log("[updateMemo] File:", field, i, f.originalname, f.size);
      });
    });
  }

  try {
    /* ---------- 1. basic fields ---------- */
    const id = +req.params.id;
    console.log("[updateMemo] Parsed id:", id, "isNaN:", isNaN(id));

    // ✅ CHECK STATUS: Allow update only if Draft(1), Rejected(4), Recalled(6)
    const currentStatus = await prisma.memoStatusPivot.findFirst({
      where: { memoId: id },
      orderBy: { createdAt: "desc" },
      select: { statusId: true },
    });
    const currentStatusId = currentStatus?.statusId ?? 0;

    // Allowed: 1 (Draft), 4 (Rejected - for resubmit), 6 (Recalled)
    // Blocked: 3 (Approved), 5 (Processing), 7 (Terminated), 8 (Expired)
    if (![1, 4, 6].includes(currentStatusId)) {
       const statusCodeMap: Record<number, string> = {
        3: "APPROVED",
        5: "PROCESSING", // Processing - cannot edit mid-flight
        7: "TERMINATED",
        8: "EXPIRED",
      };
      
      const statusCodeKey = statusCodeMap[currentStatusId] || "UNKNOWN";
      
      console.warn(
        `[updateMemo] BLOCKED: memoId=${id} is not editable. Current status: ${currentStatusId}`
      );
      
      res.status(409).json({
        code: "MEMO_STATUS_CHANGED",
        statusCode: statusCodeKey,
        currentStatusId,
      });
      return;
    }

    type OverrideItem = {
      userId: number;
      level: number;
      isSigReq?: boolean;
      roleDescription?: string | null;
      slotType?:
        | "FIXED_USER"
        | "MEMO_REQUESTER"
        | "DEPARTMENT_HEAD"
        | "FLEXIBLE_SLOT"
        | null;
      loaUserPivotId?: number | null;
      approvalRequirement?: "ALL" | "ANY"; // ✅ Add this field
    };

    let approversOverride: OverrideItem[] = [];
    try {
      approversOverride = JSON.parse(
        String(req.body.approversOverride ?? "[]"),
      );
    } catch {
      approversOverride = [];
    }
    const hasOverride =
      Array.isArray(approversOverride) && approversOverride.length > 0;

    let removedFileIds: number[] = [];
    try {
      removedFileIds = (JSON.parse(req.body.removedFileIds || "[]") as any[])
        .map(Number)
        .filter(Boolean);
    } catch {
      removedFileIds = [];
    }

    let fileOrderTokens: string[] = [];
    try {
      fileOrderTokens = JSON.parse(req.body.fileOrderTokens || "[]");
    } catch {
      fileOrderTokens = [];
    }

    const {
      subject,
      businessUnitId,
      departmentId,
      userId,
      memotypeId,
      approvalLineId,
      sigPositions,
      datePositions,
      memoNumberPositions,
      notePositions,
    } = req.body;

    const deptIdNum = departmentId ? Number(departmentId) : null;
    const userIdNum = Number(userId);

    /* ---------- 2.0 หา approvalLineId เดิม ก่อนจะ update ---------- */
    const prev = await prisma.masterMemo.findUnique({
      where: { id },
      select: { approvalLineId: true },
    });
    const oldLineId = prev?.approvalLineId ?? null;

    /* ---------- 2.1 เตรียมค่า approvalLineField จาก body ---------- */
    const rawLineId = req.body.approvalLineId as string | undefined;
    let approvalLineField:
      | Prisma.MasterMemoUpdateInput["approvalLine"]
      | undefined;

    if (rawLineId !== undefined) {
      if (rawLineId === "" || rawLineId === "null") {
        approvalLineField = { disconnect: true };
      } else {
        const parsed = Number(rawLineId);
        if (!Number.isNaN(parsed))
          approvalLineField = { connect: { id: parsed } };
      }
    }

    const rawExp = req.body.expiresAt as string | undefined;
    const expUpdate = parseExpiresAt(rawExp);

    /* ---------- 2.2 update memo header ---------- */
    const buIdNum = businessUnitId ? Number(businessUnitId) : null;
    const deptIdNumParsed = departmentId ? Number(departmentId) : null;

    const memo = await prisma.masterMemo.update({
      where: { id },
      data: {
        subject,
        ...(buIdNum && !Number.isNaN(buIdNum)
          ? { businessUnit: { connect: { id: buIdNum } } }
          : {}),
        ...(deptIdNumParsed && !Number.isNaN(deptIdNumParsed)
          ? { department: { connect: { id: deptIdNumParsed } } }
          : {}),
        user: { connect: { id: +userId } },
        ...(memotypeId
          ? { memoType: { connect: { id: +memotypeId } } }
          : { memoType: { disconnect: true } }),
        ...(approvalLineField ? { approvalLine: approvalLineField } : {}),
        ...(expUpdate === undefined ? {} : { expiresAt: expUpdate }),
      },
    });

    /* ---------- 2.3 หา newLineId / lineChanged ---------- */
    const newLineId = memo.approvalLineId ?? null;
    const lineChanged = oldLineId !== newLineId;

    /* ── 2.4 clone action version ใหม่ ถ้า "ไม่มี override" และ "line ไม่เปลี่ยน" ── */
    if (!hasOverride && !lineChanged) {
      const agg = await prisma.memoApproverAction.aggregate({
        where: { memoId: id },
        _max: { version: true },
      });
      const newVersion = (agg._max.version ?? 1) + 1;

      const latestActions = await prisma.memoApproverAction.findMany({
        where: { memoId: id },
        orderBy: [{ loaUserId: "asc" }, { version: "desc" }],
        distinct: ["loaUserId"],
        select: {
          loaUserId: true,
          statusId: true,
          signatureImageId: true,
          signatureText: true,
          actedAt: true,
        },
      });

      await prisma.memoApproverAction.createMany({
        data: latestActions.map((a) => ({
          memoId: id,
          loaUserId: a.loaUserId,
          statusId: a.statusId,
          signatureImageId: a.signatureImageId ?? null,
          signatureText: a.signatureText ?? null,
          actedAt: a.actedAt ?? null,
          version: newVersion,
        })),
      });
    }

    // ---------- 2.5 ถ้ามี approversOverride ให้แทนที่ชุด approver ทั้งหมด ----------
    if (hasOverride) {
      console.log(
        "[updateMemo] Processing approversOverride:",
        JSON.stringify(approversOverride, null, 2),
      );

      type SlotT =
        | "FIXED_USER"
        | "MEMO_REQUESTER"
        | "DEPARTMENT_HEAD"
        | "FLEXIBLE_SLOT"
        | null;

      // 1) ดึง ForUse เดิมของ memo นี้มาก่อน
      const existing = await prisma.lineOfApprovalUserPivotForUse.findMany({
        where: { memoId: id },
        select: { id: true, templatePivotId: true },
      });
      console.log("[updateMemo] Existing ForUse records:", existing);

      const existingById = new Map(existing.map((row) => [row.id, row]));

      const keepIds: number[] = [];
      const upsertOps: Prisma.PrismaPromise<{
        id: number;
        userId: number | null;
      }>[] = [];

      // เรียงตาม level
      const sorted = [...approversOverride].sort(
        (a, b) => (a.level ?? 0) - (b.level ?? 0),
      );

      for (const o of sorted) {
        const slot = (o.slotType as SlotT) ?? null;
        const level = Number.isFinite(o.level as any) ? Number(o.level) : 0;
        const userIdVal = o.userId ? Number(o.userId) : null;
        const rawId = o.loaUserPivotId;

        console.log("[updateMemo] Processing approver:", {
          userId: userIdVal,
          level,
          rawId,
          existsInMap: existingById.has(rawId as number),
        });

        // ✅ เคส "แถวเดิม" → loaUserPivotId = id ของ ForUse เดิม → UPDATE
        if (
          typeof rawId === "number" &&
          Number.isFinite(rawId) &&
          existingById.has(rawId)
        ) {
          const old = existingById.get(rawId)!;
          keepIds.push(old.id);
          console.log("[updateMemo] Updating existing record:", old.id);

          upsertOps.push(
            prisma.lineOfApprovalUserPivotForUse.update({
              where: { id: old.id },
              data: {
                userId: userIdVal,
                level,
                isSigReq: !!o.isSigReq,
                roleDescription: o.roleDescription ?? null,
                slotType: slot,
                approvalRequirement: (o.approvalRequirement as "ALL" | "ANY") ?? "ALL", // ✅ Add approval requirement
                // รักษา templatePivotId เดิมไว้
                templatePivotId: old.templatePivotId,
              },
              select: { id: true, userId: true },
            }),
          );
        } else {
          // ✅ เคส "แถวใหม่" → CREATE (let Prisma auto-generate the ID)
          console.log(
            "[updateMemo] Creating new record for userId:",
            userIdVal,
            "level:",
            level,
          );
          upsertOps.push(
            prisma.lineOfApprovalUserPivotForUse.create({
              data: {
                // Don't set id - let Prisma auto-generate it
                memoId: id,
                userId: userIdVal,
                level,
                isSigReq: !!o.isSigReq,
                roleDescription: o.roleDescription ?? null,
                slotType: slot,
                approvalRequirement: (o.approvalRequirement as "ALL" | "ANY") ?? "ALL", // ✅ Add approval requirement
                templatePivotId: null, // ad-hoc, ไม่ผูกกับ template
              },
              select: { id: true, userId: true },
            }),
          );
        }
      }

      console.log(
        "[updateMemo] Total upsertOps:",
        upsertOps.length,
        "keepIds:",
        keepIds,
      );

      // รัน update/create ทั้งหมด
      let forUseRows: { id: number; userId: number | null }[] = [];
      try {
        // Fix: Reset the auto-increment sequence before creating new records
        // This handles cases where the sequence is out of sync due to previous explicit ID inserts
        await prisma.$executeRaw`
          SELECT setval(
            pg_get_serial_sequence('"LineOfApprovalUserPivotForUse"', 'id'),
            COALESCE((SELECT MAX(id) FROM "LineOfApprovalUserPivotForUse"), 0) + 1,
            false
          )
        `;

        forUseRows = await prisma.$transaction(upsertOps);
        console.log("[updateMemo] Created/Updated ForUse rows:", forUseRows);
      } catch (txErr: any) {
        console.error("[updateMemo] Transaction failed:", txErr?.message);
        throw txErr;
      }

      // Add newly created ForUse IDs to keepIds so they don't get deleted
      const allKeepIds = [...keepIds, ...forUseRows.map((row) => row.id)];
      console.log("[updateMemo] All IDs to keep (existing + new):", allKeepIds);

      // เคลียร์ action เก่า ก่อนลบ ForUse เก่า (เพราะ MemoApproverAction มี FK ไปยัง ForUse)
      const waitingId = await getWaitingStatusId();
      await prisma.memoApproverAction.deleteMany({ where: { memoId: id } });

      // ลบ ForUse ที่ไม่อยู่ใน override แล้วจริง ๆ (หลังจากลบ action แล้ว)
      if (existing.length) {
        console.log(
          "[updateMemo] Deleting old ForUse records not in allKeepIds:",
          allKeepIds,
        );
        await prisma.lineOfApprovalUserPivotForUse.deleteMany({
          where: {
            memoId: id,
            id: { notIn: allKeepIds },
          },
        });
      }

      // สร้าง action ใหม่ตาม ForUse ที่เพิ่งสร้าง (action เก่าถูกลบไปแล้วก่อนหน้านี้)
      const { _max } = await prisma.memoApproverAction.aggregate({
        where: { memoId: id },
        _max: { version: true },
      });
      const ver = (_max.version ?? 0) + 1;

      if (forUseRows.length) {
        await prisma.memoApproverAction.createMany({
          data: forUseRows.map((row) => ({
            memoId: id,
            loaUserId: row.id,
            statusId: waitingId,
            version: ver,
            assignedUserId: row.userId ?? null,
          })),
        });
      }
    }

    /* ---------- 2.6 re-clone approvers ถ้า line เปลี่ยน (ทำเฉพาะเมื่อไม่มี override) ---------- */
    if (!hasOverride && lineChanged && newLineId) {
      await prisma.$transaction([
        prisma.memoApproverAction.deleteMany({ where: { memoId: id } }),
        prisma.lineOfApprovalUserPivotForUse.deleteMany({
          where: { memoId: id },
        }),
      ]);

      const template = await prisma.lineOfApprovalUserPivot.findMany({
        where: { lineOfApprovalId: newLineId },
        orderBy: { level: "asc" },
      });

      type SlotT =
        | "FIXED_USER"
        | "MEMO_REQUESTER"
        | "DEPARTMENT_HEAD"
        | "FLEXIBLE_SLOT"
        | null;

      const resolveFlexibleSlot = async (
        slotType:
          | Exclude<SlotT, "FIXED_USER" | "FLEXIBLE_SLOT" | null>
          | string,
        memoCreatorId: number,
        memoCreatorDeptId: number | null,
      ): Promise<number | null> => {
        switch (slotType) {
          case "MEMO_REQUESTER":
            return memoCreatorId;
          case "DEPARTMENT_HEAD":
            if (!memoCreatorDeptId) return null;
            {
              const deptHead = await prisma.user.findFirst({
                where: {
                  departmentId: memoCreatorDeptId,
                  OR: [
                    { role: { contains: "head", mode: "insensitive" } },
                    { role: { contains: "manager", mode: "insensitive" } },
                    { role: { contains: "supervisor", mode: "insensitive" } },
                  ],
                },
                select: { id: true },
              });
              return deptHead?.id ?? null;
            }
          default:
            return null;
        }
      };

      const forUseSlots: {
        memoId: number;
        userId: number | null;
        level: number;
        isSigReq: boolean;
        roleDescription: string | null;
        slotType: SlotT;
        templatePivotId: number | null;
        approvalRequirement: "ALL" | "ANY";
      }[] = [];

      for (const p of template) {
        const slot = (p.slotType ?? "FIXED_USER") as SlotT;
        let actualUserId: number | null = null;

        if (slot === "FLEXIBLE_SLOT") {
          // สร้าง row ไว้ก่อน userId เป็น null
          actualUserId = null;
        } else if (slot && slot !== "FIXED_USER") {
          // MEMO_REQUESTER / DEPARTMENT_HEAD
          actualUserId = await resolveFlexibleSlot(
            slot,
            userIdNum,
            deptIdNum ?? null,
          );
          if (actualUserId == null) continue;
        } else {
          // FIXED_USER
          if (p.userId == null) continue;
          actualUserId = p.userId;
        }

        forUseSlots.push({
          memoId: id,
          userId: actualUserId,
          level: p.level,
          isSigReq: p.isSigReq,
          roleDescription: p.roleDescription ?? null,
          slotType: slot,
          templatePivotId: p.id,
          approvalRequirement: (p.approvalRequirement as "ALL" | "ANY") ?? "ALL",
        });
      }

      // Fix: Reset the auto-increment sequence before creating new records
      await prisma.$executeRaw`
        SELECT setval(
          pg_get_serial_sequence('"LineOfApprovalUserPivotForUse"', 'id'),
          COALESCE((SELECT MAX(id) FROM "LineOfApprovalUserPivotForUse"), 0) + 1,
          false
        )
      `;

      // Let Prisma auto-generate IDs for new records
      const cloned = await prisma.$transaction(
        forUseSlots.map((slot) => {
          return prisma.lineOfApprovalUserPivotForUse.create({
            data: slot, // Don't set id - let Prisma auto-generate it
            select: { id: true, userId: true },
          });
        }),
      );

      const waitingId = await getWaitingStatusId();
      const { _max } = await prisma.memoApproverAction.aggregate({
        where: { memoId: id },
        _max: { version: true },
      });
      const ver = (_max.version ?? 0) + 1;

      if (cloned.length) {
        await prisma.memoApproverAction.createMany({
          data: cloned.map((c) => ({
            memoId: id,
            loaUserId: c.id,
            statusId: waitingId,
            version: ver,
            assignedUserId: c.userId ?? null,
          })),
        });
      }
    }

    // ใส่ status Draft (id:1) ให้เสมอ
    await prisma.memoStatusPivot.upsert({
      where: {
        memoId_userId_statusId: { memoId: id, userId: +userId, statusId: 1 },
      },
      update: { createdAt: new Date() },
      create: { memoId: id, userId: +userId, statusId: 1 },
    });

    /* ------------------------------------------------------------------ */
    /* 3-A ลบ mainFile / attachedFile ที่เลือกออก                         */
    /* ------------------------------------------------------------------ */

    if (removedFileIds.length) {
      const removed = await prisma.mainFile.findMany({
        where: { id: { in: removedFileIds } },
        select: { id: true, filePath: true },
      });

      await prisma.signaturePosition.deleteMany({
        where: { fileId: { in: removedFileIds } },
      });

      await prisma.datePosition.deleteMany({
        where: { fileId: { in: removedFileIds } },
      });

      await prisma.notePosition.deleteMany({
        where: { fileId: { in: removedFileIds } },
      });

      await prisma.memoNumberPosition.deleteMany({
        where: { fileId: { in: removedFileIds } },
      });

      await prisma.memoHistory.deleteMany({
        where: { fileId: { in: removedFileIds } },
      });

      await prisma.mainFile.deleteMany({
        where: { id: { in: removedFileIds } },
      });

      for (const f of removed) {
        try {
          if (fs.existsSync(f.filePath)) fs.unlinkSync(f.filePath);
        } catch {}
      }
    }

    const removedAttachedFileIds = JSON.parse(
      req.body.removedAttachedFileIds || "[]",
    );

    if (removedAttachedFileIds.length) {
      const removedAttachedFiles = await prisma.attachedFile.findMany({
        where: { id: { in: removedAttachedFileIds } },
        select: { id: true, filePath: true, isUrl: true },
      });

      await prisma.attachedFile.deleteMany({
        where: { id: { in: removedAttachedFileIds } },
      });

      for (const file of removedAttachedFiles) {
        try {
          // Only delete physical files, not URL links
          if (!file.isUrl && file.filePath && fs.existsSync(file.filePath)) {
            fs.unlinkSync(file.filePath);
          }
        } catch (err) {
          console.error(
            `Failed to delete attached file: ${file.filePath}`,
            err,
          );
        }
      }
    }

    /* 3-B  ไฟล์ที่ยังเหลือ */
    let keptFiles = await prisma.mainFile.findMany({
      where: { memoId: id },
      orderBy: { orderNo: "asc" },
    });

    /* 3-C  ไฟล์ใหม่จากการอัปโหลด */
    const allFiles = req.files as {
      [fieldname: string]: Express.Multer.File[];
    };
    const mainFiles = allFiles?.files || [];
    const attachedFiles = allFiles?.attachedFiles || [];

    await Promise.all(
      attachedFiles.map((f) =>
        prisma.attachedFile.create({
          data: {
            memoId: id,
            fileName: decodeFilename(f.originalname),
            filePath: f.path,
            fileType: f.mimetype,
            size: f.size,
            isUrl: false,
          },
        }),
      ),
    );

    // Handle URL link attachments
    let urlLinks: Array<{ url: string; title: string }> = [];
    try {
      urlLinks = JSON.parse(String(req.body.urlLinks ?? "[]"));
    } catch (e) {
      console.error("Failed to parse urlLinks:", e);
      urlLinks = [];
    }

    // ✅ Delete existing URL links before creating new ones to avoid duplicates
    await prisma.attachedFile.deleteMany({
      where: {
        memoId: id,
        isUrl: true,
      },
    });

    if (urlLinks.length > 0) {
      try {
        await Promise.all(
          urlLinks.map((link) =>
            prisma.attachedFile.create({
              data: {
                memoId: id,
                fileName: link.title || link.url,
                url: link.url,
                isUrl: true,
                fileType: "url/link",
                size: 0,
                filePath: null, // Explicitly set to null for URL links
              },
            }),
          ),
        );
      } catch (urlError) {
        console.error("Failed to create URL link attachments:", urlError);
        throw urlError;
      }
    }

    const newFiles = await prisma.$transaction(
      mainFiles.map((f, idx) =>
        prisma.mainFile.create({
          data: {
            memoId: id,
            filePath: f.path,
            fileName: decodeFilename(f.originalname),
            size: f.size,
            orderNo: keptFiles.length + idx,
          },
        }),
      ),
    );
    console.log(
      "[updateMemo] Created new mainFiles:",
      newFiles.map((f) => ({
        id: f.id,
        fileName: f.fileName,
        filePath: f.filePath,
      })),
    );

    keptFiles = [...keptFiles, ...newFiles];

    /* 3-D รี-ออร์เดอร์ mainFile ตาม fileOrderTokens */
    keptFiles = await prisma.mainFile.findMany({
      where: { memoId: id },
      orderBy: { orderNo: "asc" },
    });

    const oldMap = new Map<number, number>();
    keptFiles.forEach((f) => oldMap.set(f.id, f.id));

    const newMap = new Map<number, number>();
    newFiles.forEach((f, i) => newMap.set(i, f.id));

    const finalOrder: number[] = [];
    for (const tk of fileOrderTokens) {
      if (tk.startsWith("old:")) {
        const oldId = Number(tk.slice(4));
        if (oldMap.has(oldId)) finalOrder.push(oldMap.get(oldId)!);
      } else if (tk.startsWith("new:")) {
        const idx = Number(tk.slice(4));
        if (newMap.has(idx)) finalOrder.push(newMap.get(idx)!);
      }
    }

    const allIds = new Set([
      ...keptFiles.map((f) => f.id),
      ...newFiles.map((f) => f.id),
    ]);
    finalOrder.forEach((id) => allIds.delete(id));
    finalOrder.push(...allIds);

    await prisma.$transaction(
      finalOrder.map((fileId, orderNo) =>
        prisma.mainFile.update({
          where: { id: fileId },
          data: { orderNo },
        }),
      ),
    );

    /* 3-E  ดึงไฟล์ใหม่อีกที */
    keptFiles = await prisma.mainFile.findMany({
      where: { memoId: id },
      orderBy: { orderNo: "asc" },
    });

    /* 3-F  map index → fileId */
    const fileIdMap: Record<number, number> = {};
    keptFiles.forEach((f, idx) => (fileIdMap[idx] = f.id));

    /* ------------------------------------------------------------------ */
    /* 4. Positions (upsert)                                              */
    /* ------------------------------------------------------------------ */
    type SigPos = {
      id?: number | string;
      userId: number;
      fileIdx: number;
      page: number;
      x: number;
      y: number;
      sizePct?: number;
      level?: number; // Approval level this signature belongs to
    };
    type DatePos = SigPos & { date: string };
    type NotePos = {
      id?: number | string;
      fileIdx: number;
      page: number;
      x: number;
      y: number;
      text: string;
      sizePct?: number;
    };
    type MemoNumPos = {
      id?: number | string;
      fileIdx: number;
      page: number;
      x: number;
      y: number;
      sizePct?: number;
    };

    const sigs: SigPos[] = JSON.parse(sigPositions || "[]");
    const dates: DatePos[] = JSON.parse(datePositions || "[]");
    const notes: NotePos[] = JSON.parse(notePositions || "[]");
    const memoNums: MemoNumPos[] = JSON.parse(memoNumberPositions || "[]");

    const sigIdsKept: number[] = [];
    const dateIdsKept: number[] = [];
    const noteIdsKept: number[] = [];
    const memoNumIdsKept: number[] = [];

    const tx: Prisma.PrismaPromise<any>[] = [];
    const sigCreates: Prisma.PrismaPromise<any>[] = [];
    const dateCreates: Prisma.PrismaPromise<any>[] = [];
    const noteCreates: Prisma.PrismaPromise<any>[] = [];
    const memoNumCreates: Prisma.PrismaPromise<any>[] = [];

    /* --- Signature --- */
    for (const p of sigs) {
      const data = {
        memoId: id,
        fileId: fileIdMap[p.fileIdx],
        userId: p.userId,
        page: p.page,
        x: +p.x.toFixed(6),
        y: +p.y.toFixed(6),
        sizePct: p.sizePct ?? 100,
        level: p.level ?? null,
      };
      if (typeof p.id === "number") {
        sigIdsKept.push(p.id);
        tx.push(prisma.signaturePosition.update({ where: { id: p.id }, data }));
      } else {
        sigCreates.push(prisma.signaturePosition.create({ data }));
      }
    }
    tx.push(
      prisma.signaturePosition.deleteMany({
        where: { memoId: id, id: { notIn: sigIdsKept } },
      }),
    );
    tx.push(...sigCreates);

    /* --- Date --- */
    for (const p of dates) {
      const cleanDate = new Date(new Date(p.date).toLocaleDateString("sv-SE"));
      const data = {
        memoId: id,
        fileId: fileIdMap[p.fileIdx],
        userId: p.userId,
        page: p.page,
        x: +p.x.toFixed(6),
        y: +p.y.toFixed(6),
        date: cleanDate,
        sizePct: p.sizePct ?? 100,
        level: p.level ?? null,
      };
      if (typeof p.id === "number") {
        dateIdsKept.push(p.id);
        tx.push(prisma.datePosition.update({ where: { id: p.id }, data }));
      } else {
        dateCreates.push(prisma.datePosition.create({ data }));
      }
    }
    tx.push(
      prisma.datePosition.deleteMany({
        where: { memoId: id, id: { notIn: dateIdsKept } },
      }),
    );
    tx.push(...dateCreates);

    /* --- Note --- */
    for (const p of notes) {
      const data = {
        memoId: id,
        fileId: fileIdMap[p.fileIdx],
        page: p.page,
        x: +p.x.toFixed(6),
        y: +p.y.toFixed(6),
        text: p.text,
        sizePct: p.sizePct ?? 100,
      };
      if (typeof p.id === "number") {
        noteIdsKept.push(p.id);
        tx.push(prisma.notePosition.update({ where: { id: p.id }, data }));
      } else {
        noteCreates.push(prisma.notePosition.create({ data }));
      }
    }
    tx.push(
      prisma.notePosition.deleteMany({
        where: { memoId: id, id: { notIn: noteIdsKept } },
      }),
    );
    tx.push(...noteCreates);

    /* --- MemoNumber --- */
    for (const p of memoNums) {
      const data = {
        memoId: id,
        fileId: fileIdMap[p.fileIdx],
        page: p.page,
        x: +p.x.toFixed(6),
        y: +p.y.toFixed(6),
        sizePct: p.sizePct ?? 100,
      };
      if (typeof p.id === "number") {
        memoNumIdsKept.push(p.id);
        tx.push(
          prisma.memoNumberPosition.update({ where: { id: p.id }, data }),
        );
      } else {
        memoNumCreates.push(prisma.memoNumberPosition.create({ data }));
      }
    }
    tx.push(
      prisma.memoNumberPosition.deleteMany({
        where: { memoId: id, id: { notIn: memoNumIdsKept } },
      }),
    );
    tx.push(...memoNumCreates);

    await prisma.$transaction(tx);

    console.log("[updateMemo] ✅ Successfully updated memo:", id);
    res.json(memo);
  } catch (err: any) {
    console.error("❌ updateMemo failed");
    console.error("Error name:", err?.name);
    console.error("Error message:", err?.message);
    console.error("Error code:", err?.code);
    if (err?.meta)
      console.error("Error meta:", JSON.stringify(err.meta, null, 2));
    console.error("Full error:", err);
    res.status(500).json({ error: "Update failed", details: err?.message });
  }
};

// --- DELETE /api/memos/:id ---
// src/controllers/memo.controller.ts
async function hasAnyApprovedInLatestVersion(memoId: number): Promise<boolean> {
  // หา id ของ status "approved"
  const approved = await prisma.approvalActionStatus.findUnique({
    where: { code: "approved" },
    select: { id: true },
  });
  if (!approved) return false;

  // หาเวอร์ชันล่าสุดของ action
  const { _max } = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  const latestVer = _max.version ?? 1;

  // มีใคร statusId = approved.id ไหม ในเวอร์ชันล่าสุด
  const any = await prisma.memoApproverAction.findFirst({
    where: { memoId, version: latestVer, statusId: approved.id },
    select: { id: true },
  });
  return !!any;
}

function absFromDbPath(input: string): string {
  if (!input) return "";

  // 1) ถ้าเป็น absolute path อยู่แล้ว (เช่น C:\...\uploads\attached\file.pdf) → ใช้อันนี้เลย
  if (path.isAbsolute(input)) {
    return input;
  }

  let s = String(input).trim();

  // 2) ถ้าเป็น URL (เช่น /api/secure-uploads/... หรือ http(s)://.../uploads/attached/...)
  //    → คืนค่าเฉพาะ pathname มาก่อน
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {}
  }
  s = s.replace(/^\/+/, ""); // ตัด / นำหน้า
  s = s.replace(/\\/g, "/"); // backslash -> slash
  s = s.replace(/^api\/secure-uploads\//i, ""); // ตัด prefix secure-uploads ถ้ามี

  // 3) normalize ให้เหลือส่วนใต้ "uploads/"
  if (s.toLowerCase().startsWith("uploads/")) {
    s = s.slice("uploads/".length);
  }

  // 4) handle เคสเผื่อ DB เก็บแบบ "attached/..." (ไม่ขึ้นต้น uploads/)
  //    สรุป: join กับโฟลเดอร์อัปโหลดหลักเสมอ
  return path.join(UPLOADS_DIR, s);
}

export const deleteMemo: RequestHandler = async (req, res) => {
  const memoId = +req.params.id;

  try {
    if (await hasAnyApprovedInLatestVersion(memoId)) {
      res.status(400).json({
        message:
          "ลบไม่ได้: เอกสารนี้มีการอนุมัติแล้วอย่างน้อย 1 คน (ให้ Recall แบบ Clear เพื่อเริ่มใหม่ก่อน)",
      });
      return;
    }

    // 1) หา comment IDs ของ memo นี้
    const comments = await prisma.comment.findMany({
      where: { memoId },
      select: { id: true },
    });
    const commentIds = comments.map((c) => c.id);

    // 2) รวบรวม path + id ของไฟล์หลัก/แนบ
    const mainFiles = await prisma.mainFile.findMany({
      where: { memoId },
      select: { id: true, filePath: true },
    });
    const mainFileIds = mainFiles.map((f) => f.id);

    const attachedFiles = await prisma.attachedFile.findMany({
      where: { memoId },
      select: { filePath: true },
    });

    const commentAtts = await prisma.commentAttachment.findMany({
      where: { commentId: { in: commentIds } },
      select: { url: true },
    });

    const allPaths = [
      ...mainFiles.map((f) => absFromDbPath(f.filePath)),
      ...attachedFiles
        .filter((f) => f.filePath)
        .map((f) => absFromDbPath(f.filePath!)),
      ...commentAtts.map((a) =>
        path.join(UPLOADS_DIR, "comments", path.basename(a.url)),
      ),
    ];

    // ❌ ไม่ต้องใช้ cloneIds แล้ว ลบได้เลย
    // const cloneIds = await prisma.memoApproverAction
    //   .findMany({ where: { memoId }, select: { loaUserId: true } })
    //   .then((r) => r.map((x) => x.loaUserId));

    // 4) Perform Soft Delete
    // Find or Create "Deleted" status
    let deletedStatus = await prisma.status.findFirst({
      where: { name: "Deleted" },
    });
    if (!deletedStatus) {
      // ✅ Fix: Handle potential sequence out-of-sync (P2002) by manually assigning ID
      const maxStat = await prisma.status.aggregate({ _max: { id: true } });
      const nextId = (maxStat._max.id ?? 0) + 1;
      
      deletedStatus = await prisma.status.create({
        data: { 
          id: nextId,
          name: "Deleted", 
          description: "Soft deleted" 
        },
      });
    }

    const userId = (req as any).user?.id || 0;

    await prisma.$transaction([
      // Add status pivot
      prisma.memoStatusPivot.create({
        data: {
          memoId,
          statusId: deletedStatus.id,
          userId,
        },
      }),
      // Add history
      prisma.memoHistory.create({
        data: {
          memoId,
          userId,
          action: "Memo deleted (soft delete)",
          statusId: deletedStatus.id,
          actiontype: ActionType.TERMINATE, // Using TERMINATE as proxy for delete if no DELETE enum
        },
      }),
      // Update MasterMemo deletedAt
      prisma.masterMemo.update({
        where: { id: memoId },
        data: { deletedAt: new Date() },
      }),
    ]);

    res.sendStatus(204);
  } catch (err) {
    console.error("❌ deleteMemo failed", err);
    res.status(500).json({ error: "Delete failed" });
  }
};

// ลบแบบ force: ไม่สน hasAnyApprovedInLatestVersion
export const forceDeleteMemo: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);

  if (isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memo ID" });
    return;
  }

  try {
    // 1) comment ids
    const comments = await prisma.comment.findMany({
      where: { memoId },
      select: { id: true },
    });
    const commentIds = comments.map((c) => c.id);

    // 2) รวบรวมพาธไฟล์ทั้งหมดบนดิสก์
    const mainFiles = await prisma.mainFile.findMany({
      where: { memoId },
      select: { filePath: true },
    });
    const attachedFiles = await prisma.attachedFile.findMany({
      where: { memoId },
      select: { filePath: true },
    });
    const commentAtts = await prisma.commentAttachment.findMany({
      where: { commentId: { in: commentIds } },
      select: { url: true },
    });
    const allPaths = [
      ...mainFiles.map((f) => absFromDbPath(f.filePath)),
      ...attachedFiles
        .filter((f) => f.filePath)
        .map((f) => absFromDbPath(f.filePath!)),
      ...commentAtts.map((a) =>
        path.join(UPLOADS_DIR, "comments", path.basename(a.url)),
      ),
    ];

    const cloneIds = await prisma.memoApproverAction
      .findMany({ where: { memoId }, select: { loaUserId: true } })
      .then((r) => r.map((x) => x.loaUserId));

    // 3) ลบข้อมูล DB ทั้งหมดที่เกี่ยวข้อง (transaction)
    await prisma.$transaction([
      prisma.notification.deleteMany({
        where: { OR: [{ memoId }, { commentId: { in: commentIds } }] },
      }),
      prisma.commentAttachment.deleteMany({
        where: { commentId: { in: commentIds } },
      }),
      prisma.comment.deleteMany({ where: { memoId } }),
      prisma.signaturePosition.deleteMany({ where: { memoId } }),
      prisma.datePosition.deleteMany({ where: { memoId } }),
      prisma.memoHistory.deleteMany({ where: { memoId } }),
      prisma.memoStatusPivot.deleteMany({ where: { memoId } }),
      prisma.memoApproverAction.deleteMany({ where: { memoId } }),
      prisma.attachedFile.deleteMany({ where: { memoId } }),
      prisma.mainFile.deleteMany({ where: { memoId } }),
      prisma.masterMemo.delete({ where: { id: memoId } }),
      prisma.lineOfApprovalUserPivot.deleteMany({
        where: { id: { in: cloneIds } },
      }),
    ]);

    // 4) ลบไฟล์บนดิสก์
    for (const p of allPaths) {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch (e) {
          console.warn("Failed to delete file", p, e);
        }
      }
    }

    res.sendStatus(204);
  } catch (err) {
    console.error("❌ forceDeleteMemo failed", err);
    res.status(500).json({ error: "Force delete failed" });
  }
};

// --- POST /api/memos/:id/upload-main ---
export const uploadMainPDF: RequestHandler = async (req, res) => {
  const memoId = +req.params.id;
  const file = req.file!;
  const newFile = await prisma.mainFile.create({
    data: {
      memoId,
      filePath: file.path,
      fileName: decodeFilename(file.originalname), // 👈
      size: file.size,
    },
  });
  res.status(201).json(newFile);
};

// --- POST /api/memos/signature ---
export const saveSignaturePosition: RequestHandler = async (req, res) => {
  const { memoId, fileId, userId, page, x, y } = req.body;
  const s = await prisma.signaturePosition.create({
    data: { memoId, fileId, userId, page, x, y },
  });
  res.status(201).json(s);
};

// --- POST /api/memos/date ---
export const saveDatePosition: RequestHandler = async (req, res) => {
  const { memoId, fileId, userId, page, x, y, date } = req.body;
  const d = await prisma.datePosition.create({
    data: {
      memoId,
      fileId,
      userId,
      page,
      x,
      y,
      date: new Date(date),
    },
  });
  res.status(201).json(d);
};

// --- POST /api/memos/note ---
export const saveNotePosition: RequestHandler = async (req, res) => {
  const { memoId, fileId, page, x, y, text } = req.body;
  const n = await prisma.notePosition.create({
    data: {
      memoId,
      fileId,
      page,
      x,
      y,
      text,
    },
  });
  res.status(201).json(n);
};

// --- POST /api/memos/:id/status ---// --- POST /api/memos/:id/status ---
// export const saveMemoStatus: RequestHandler = async (req, res) => {
//   const { memoId, userId, statusId, fileId } = req.body;
// if (statusId === 7) {
//     // 1) ต้องกำลังอยู่ในสถานะ Processing ก่อน
//     const latest = await prisma.memoStatusPivot.findFirst({
//       where: { memoId },
//       orderBy: { createdAt: "desc" },
//       select: { statusId: true },
//     });
//     if (latest?.statusId !== 5) {
//        res.status(409).json({ error: "Memo is not in Processing." });
//        return;
//     }

//     // 2) ตรวจสิทธิ์ตามเลเวลต่ำสุดที่กำลัง waiting
//     const allowed = await isCurrentMinWaitingApprover(memoId, userId);
//     if (!allowed) {
//        res.status(403).json({
//         error: "Only the current waiting approver at the minimal level can terminate.",
//       });
//     }
//   }
//   const pivot = await prisma.memoStatusPivot.create({
//     data: {
//       memoId,
//       userId,
//       statusId,
//     },
//   });

//   // เลือก ActionType ตาม statusId
//   const statusActionTypeMap: Record<number, ActionType> = {
//     1: ActionType.DRAFT,
//     3: ActionType.APPROVE,
//     4: ActionType.REJECT,
//     5: ActionType.PROCESSING,
//     6: ActionType.RECALL,
//     7: ActionType.TERMINATE,
//   };

//   await prisma.memoHistory.create({
//     data: {
//       memoId,
//       userId,
//       fileId,
//       statusId,
//       action: `User ${userId} set status ${statusId}`,
//       actiontype: statusActionTypeMap[statusId] ?? ActionType.UPDATE, // ✅ เพิ่ม
//       timestamp: new Date(),
//     },
//   });

//   broadcastMemoUpdate(memoId);
//   res.status(201).json(pivot);
// };

export const downloadMergedPdf: RequestHandler = async (req, res) => {
  const memoId = +req.params.id;
  const showDraft = String(req.query.preview ?? "") === "1";
  const forceInline = String(req.query.inline ?? "") === "1";

  // ✅ ตรวจสิทธิ์
  try {
    const userId = getUserId(req);
    const ok = await canViewMemo(userId, memoId);
    if (!ok) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } catch (e: any) {
    res.status(e?.status || 401).json({ error: e?.message });
    return;
  }

  // ✅ เรียกฟังก์ชันกลาง
  let merged: Awaited<ReturnType<typeof createPdfForDownload>>;
  try {
    merged = await createPdfForDownload(memoId, showDraft);
  } catch (err: any) {
    if (err?.status === 404 || err?.message?.includes("No main PDF files found")) {
      res.status(404).json({ error: "ไม่พบไฟล์ PDF สำหรับบันทึกข้อความนี้ (ไฟล์อาจถูกลบออกจากระบบ)" });
      return;
    }
    console.error("❌ downloadMergedPdf failed:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
    return;
  }

  // ส่งกลับ PDF - ต้องประกาศ cd ก่อนใช้
  const memoRow = await prisma.masterMemo.findUnique({
    where: { id: memoId },
  });

  const baseRaw =
    memoRow?.memonumber && memoRow?.subject
      ? `${memoRow.memonumber}-${memoRow.subject}`
      : `memo-${memoId}`;
  const safeBase = baseRaw.replace(/[\r\n]/g, " ").trim();
  
  // Use "inline" for preview mode (PDF viewer modal) or forceInline, "attachment" for download
  const isInline = showDraft || forceInline;
  const cd = contentDisposition(`${safeBase}.pdf`, { type: isInline ? "inline" : "attachment" });

  // ถ้า recall แล้วไม่มี action → ส่งเปล่า
  const lastRecall = await prisma.memoStatusPivot.findFirst({
    where: { memoId, statusId: { in: [6] } },
    orderBy: { createdAt: "desc" },
  });

  if (lastRecall && !showDraft) {
    const actions = await prisma.memoApproverAction.findMany({
      where: {
        memoId,
        status: { code: "approved" },
        actedAt: { gte: lastRecall.createdAt },
      },
    });

    if (actions.length === 0) {
      const out = await merged.save();
      res
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", cd)
        .send(Buffer.from(out));
      return;
    }
  }

  const outBytes = await merged.save();
  res
    .header("Content-Type", "application/pdf")
    .header("Content-Disposition", cd)
    .send(Buffer.from(outBytes));
};

// --- GET /api/memos/:id/raw ---
// คืน PDF รวม แต่ไม่มีลายเซ็นฝัง
export const downloadRawPdf: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);

  if (Number.isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memoId" });
    return;
  }

  try {
    const userId = getUserId(req);
    const ok = await canViewMemo(userId, memoId);
    if (!ok) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } catch (e: any) {
    res.status(e?.status || 401).json({ error: e?.message });
    return;
  }

  try {
    // ดึงข้อมูลไว้ตั้งชื่อไฟล์
    const meta = await prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { memonumber: true, subject: true },
    });

    const files = await prisma.mainFile.findMany({
      where: { memoId },
      orderBy: { orderNo: "asc" },
    });

    if (!files.length) {
      res.status(404).json({ error: "No files found for this memo" });
      return;
    }

    const merged = await PDFDocument.create();
    for (const f of files) {
      const srcBytes = fs.readFileSync(path.resolve(f.filePath));
      const srcDoc = await PDFDocument.load(srcBytes, { ignoreEncryption: true });
      const pages = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }

    const bytes = await merged.save();

    // ---- ตั้งชื่อไฟล์: memonumber-subject.pdf ----
    const baseName = meta
      ? `${meta.memonumber}-${meta.subject}`
      : `Memo_${memoId}`;

    // กันอักขระต้องห้าม/ตัดความยาว/กัน header injection
    const safeBase = baseName
      .replace(/[\r\n]/g, " ") // กัน CRLF
      .replace(/[\/\\?%*:|"<>]/g, " ") // กันอักขระต้องห้ามบนไฟล์ระบบทั่วไป
      .replace(/\s+/g, " ") // เว้นวรรคซ้ำ ๆ ให้เหลือช่องเดียว
      .trim()
      .slice(0, 180);

    const fileName = `${safeBase}.pdf`;

    res
      .set({
        "Content-Type": "application/pdf",
        // พรีวิว แต่กำหนดชื่อไฟล์เวลาบันทึก
        // ถ้าจะบังคับโหลด: เปลี่ยน inline -> attachment
        "Content-Disposition": `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(
          fileName,
        )}`,
        "Content-Length": bytes.length.toString(),
      })
      .send(Buffer.from(bytes));
  } catch (err) {
    console.error("❌ downloadRawPdf failed", err);
    res.status(500).json({ error: "Failed to generate raw PDF" });
  }
};

// --- GET /api/memos/:id/pdf?fileId=… ---
export const getMainFilePdf: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);

  const raw = req.query.fileId as string | undefined;
  const fileId = raw ? Number(raw) : undefined;

  // Validate
  if (isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memoId" });
    return;
  }
  if (raw && isNaN(fileId!)) {
    res.status(400).json({ error: "Invalid fileId" });
    return;
  }

  try {
    const userId = getUserId(req);
    const ok = await canViewMemo(userId, memoId);
    if (!ok) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } catch (e: any) {
    res.status(e?.status || 401).json({ error: e?.message });
    return;
  }

  try {
    let target;
    if (fileId !== undefined) {
      target = await prisma.mainFile.findFirst({
        where: { memoId, id: fileId },
        select: { id: true, filePath: true, fileName: true }, // << เอา fileName มาด้วย
      });
    } else {
      target = await prisma.mainFile.findFirst({
        where: { memoId },
        orderBy: { orderNo: "asc" },
        select: { id: true, filePath: true, fileName: true }, // << เอา fileName มาด้วย
      });
    }
    if (!target) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const absolutePath = path.join(UPLOADS_DIR, path.basename(target.filePath));
    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "File missing on disk" });
      return;
    }

    const rawBytes = fs.readFileSync(absolutePath);
    const pdfDoc = await PDFDocument.load(rawBytes, { ignoreEncryption: true });
    const cd = contentDisposition(target.fileName || `memo-${memoId}.pdf`, {
      type: "inline",
      fallback: false, // ให้ใช้ filename* อย่างเดียว (UTF-8)
    });

    res
      .header("Content-Type", "application/pdf")
      .header("Access-Control-Expose-Headers", "Content-Disposition")
      .header("Content-Disposition", cd)
      .sendFile(absolutePath);
  } catch (err) {
    console.error("❌ getMainFilePdf failed:", err);
    res.status(500).json({ error: "Failed to fetch PDF" });
  }
};

// --- POST /api/memos/:id/recall ---
export const recallMemo: RequestHandler = async (req, res) => {
  const memoId = +req.params.id;
  const { userId, fileId } = req.body;

  if (isNaN(memoId) || isNaN(userId)) {
    res.status(400).json({ error: "Invalid memoId or userId" });
    return;
  }

  try {
    // 1) บันทึกสถานะ Recall
    await prisma.memoStatusPivot.create({
      data: { memoId, userId, statusId: 6 },
    });

    // 2) ลบ Processing เดิม (ถ้ามี)
    await prisma.memoStatusPivot.deleteMany({ where: { memoId, statusId: 5 } });

    // 3) ลบ history ที่เป็น Processing (ถ้าต้องการ)
    await prisma.memoHistory.deleteMany({ where: { memoId, statusId: 5 } });

    // 4) รีเซ็ต approver actions เวอร์ชันล่าสุดกลับเป็น waiting
    const { _max } = await prisma.memoApproverAction.aggregate({
      where: { memoId },
      _max: { version: true },
    });
    const latestVersion = _max.version ?? 1;
    const waitingId = await getWaitingStatusId();
    await prisma.memoApproverAction.updateMany({
      where: { memoId, version: latestVersion },
      data: {
        statusId: waitingId,
        signatureImageId: null,
        signatureText: null,
        actedAt: null,
      },
    });

    // 4.5) ⬅️ รีเซ็ต Extra (เฉพาะ active lines)
    const activeExtraLines = await prisma.extraApprovalLine.findMany({
      where: {
        memoId,
        status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] },
      },
      select: { id: true },
    });
    if (activeExtraLines.length) {
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

    res.status(201).json({
      message:
        "Memo recalled; previous approvals cleared (including Extra waiting reset).",
    });
  } catch (err) {
    console.error("❌ recallMemo failed:", err);
    res.status(500).json({ error: "Recall failed" });
  }
};

// --- POST /api/memos/:id/recall-preserve ---
export const recallMemoPreserve: RequestHandler = async (req, res) => {
  const memoId = +req.params.id;
  const { userId, fileId } = req.body;
  // … validation …

  try {
    // upsert Recall (6) เท่านั้น
    await prisma.memoStatusPivot.upsert({
      where: { memoId_userId_statusId: { memoId, userId, statusId: 6 } },
      update: {},
      create: { memoId, userId, statusId: 6 },
    });

    // history
    await prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        statusId: 6,
        action: `${userId} recalled memo (preserve)`,
        actiontype: ActionType.RECALL, // ✅ เพิ่มให้ตรง enum
        timestamp: new Date(),
        fileId: fileId || undefined,
      },
    });

    res.status(201).json({ message: "Recalled (preserve)." });
  } catch (err) {
    console.error("❌ recallMemoPreserve failed:", err);
    res.status(500).json({ error: "Recall preserve failed" });
  }
};

// src/controllers/memo.controller.ts

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
export const renewExpiry: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const actorId = req.user!.id;
  const actorRole = (req.user as any)?.role ?? "";

  if (isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memo id" });
    return;
  }

  // Parse & validate new expiresAt
  const parsed = parseExpiresAt(req.body.expiresAt);
  if (!parsed) {
    res.status(400).json({ error: "expiresAt is required and must be a valid date" });
    return;
  }
  if (parsed.getTime() <= Date.now()) {
    res.status(400).json({ error: "expiresAt must be in the future" });
    return;
  }

  try {
    const memo = await prisma.masterMemo.findFirst({
      where: { id: memoId, deletedAt: null },
      select: { id: true, userId: true },
    });
    if (!memo) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }

    // Only memo owner or admin can renew
    const isAdmin = actorRole.toUpperCase() === "ADMIN";
    if (memo.userId !== actorId && !isAdmin) {
      res.status(403).json({ error: "Only memo owner or admin can renew expiry" });
      return;
    }

    // Check latest status is Processing or Expired
    const latestPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      include: { status: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    const latestStatusName = (latestPivot?.status?.name ?? "").toLowerCase();
    if (latestStatusName !== "processing" && latestStatusName !== "expired" && latestStatusName !== "draft") {
      res.status(400).json({
        error: `Cannot renew: current status is "${latestPivot?.status?.name ?? "unknown"}". Only Draft, Processing or Expired memos can be renewed.`,
      });
      return;
    }

    // Determine target status: "Draft" or "Processing" (default: "Processing")
    const targetStatus = req.body.targetStatus === "Draft" ? "Draft" : "Processing";

    // Perform update inside a transaction
    const updated = await prisma.$transaction(async (tx) => {
      // Update expiresAt
      const updatedMemo = await tx.masterMemo.update({
        where: { id: memoId },
        data: { expiresAt: parsed },
        select: { id: true, expiresAt: true, subject: true },
      });

      // If currently Expired, remove Expired record and set target status
      if (latestStatusName === "expired") {
        const expiredStatusId = await getStatusIdByName("Expired");
        const newStatusId = await getStatusIdByName(targetStatus);

        // Delete ALL Expired (statusId=8) records for this memo
        // to prevent unique constraint error when cron tries to create Expired again
        await tx.memoStatusPivot.deleteMany({
          where: { memoId, statusId: expiredStatusId },
        });

        // Add the target status (Draft or Processing)
        await tx.memoStatusPivot.upsert({
          where: {
            memoId_userId_statusId: {
              memoId,
              userId: actorId,
              statusId: newStatusId,
            },
          },
          update: { createdAt: new Date() },
          create: {
            memoId,
            userId: actorId,
            statusId: newStatusId,
          },
        });

        // If target is Draft, reset all approver actions to waiting
        // so every level must re-approve (same behavior as recall)
        if (targetStatus === "Draft") {
          const { _max } = await tx.memoApproverAction.aggregate({
            where: { memoId },
            _max: { version: true },
          });
          const latestVersion = _max.version ?? 1;
          const waitingId = await getWaitingStatusId();

          await tx.memoApproverAction.updateMany({
            where: { memoId, version: latestVersion },
            data: {
              statusId: waitingId,
              signatureImageId: null,
              signatureText: null,
              actedAt: null,
            },
          });

          // Reset active Extra Approval Lines
          const activeExtraLines = await tx.extraApprovalLine.findMany({
            where: {
              memoId,
              status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] },
            },
            select: { id: true },
          });
          if (activeExtraLines.length) {
            const lineIds = activeExtraLines.map((l) => l.id);
            await tx.extraApprovalLine.updateMany({
              where: { id: { in: lineIds } },
              data: { status: ExtraStatus.PENDING, closedAt: null },
            });
            await tx.extraApprover.updateMany({
              where: { extraId: { in: lineIds } },
              data: { statusId: null, actedAt: null },
            });
          }
        }
      }

      // Create history record
      await tx.memoHistory.create({
        data: {
          memoId,
          userId: actorId,
          action: "Renewed expiry date",
          actiontype: ActionType.UPDATE,
          timestamp: new Date(),
        },
      });

      return updatedMemo;
    });

    res.json({
      message: "Expiry date renewed successfully",
      memo: updated,
    });
  } catch (err) {
    console.error("[renewExpiry] failed:", err);
    res.status(500).json({ error: "Failed to renew expiry date" });
  }
};
