/**
 * memoLifecycle.service.ts  (Wave 9)
 *
 * Memo create / update / delete lifecycle handlers extracted from memo.controller.ts.
 * Exports: createMemo, updateMemo, deleteMemo, forceDeleteMemo, renewExpiry
 * Private helpers: parseExpiresAt, getStatusIdByName, hasAnyApprovedInLatestVersion, absFromDbPath
 */

import { RequestHandler } from "express";
import path from "path";
import fs from "fs";
import { ActionType, ExtraStatus, Prisma } from "@prisma/client";
import { prisma } from "../../prisma/client";
import { OverrideItem } from "../types/memoOverride";
import { reserveMemoNumber } from "../lib/memoNumber";
import { toPublicUploadPath, UPLOADS_DIR } from "../middlewares/upload";
import { decodeFilename } from "../lib/filename";
import { getWaitingStatusId } from "./memoQuery.service";

// ─── Private helpers ──────────────────────────────────────────────────────────

export function parseExpiresAt(raw?: unknown): Date | null | undefined {
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

export async function getStatusIdByName(name: string): Promise<number> {
  const rec = await prisma.status.findFirst({
    where: { name },
    select: { id: true },
  });
  if (!rec) throw new Error(`ต้องมี Status.name = "${name}" ในตาราง Status`);
  return rec.id;
}

async function hasAnyApprovedInLatestVersion(memoId: number): Promise<boolean> {
  const approved = await prisma.approvalActionStatus.findUnique({
    where: { code: "approved" },
    select: { id: true },
  });
  if (!approved) return false;

  const { _max } = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  const latestVer = _max.version ?? 1;

  const any = await prisma.memoApproverAction.findFirst({
    where: { memoId, version: latestVer, statusId: approved.id },
    select: { id: true },
  });
  return !!any;
}

export function absFromDbPath(input: string): string {
  if (!input) return "";

  // 1) ถ้าเป็น absolute path อยู่แล้ว
  if (path.isAbsolute(input)) {
    return input;
  }

  let s = String(input).trim();

  // 2) ถ้าเป็น URL
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {}
  }

  s = s.replace(/^\/+/, ""); // ตัด / นำหน้า
  s = s.replace(/\\/g, "/"); // backslash -> slash
  s = s.replace(/^api\/secure-uploads\//i, ""); // ตัด prefix

  // 3) normalize ให้เหลือส่วนใต้ "uploads/"
  if (s.toLowerCase().startsWith("uploads/")) {
    s = s.slice("uploads/".length);
  }

  return path.join(UPLOADS_DIR, s);
}

// ─── createMemo ───────────────────────────────────────────────────────────────

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

    /* ─────── 2) จอง MemoNumber ─────── */
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

    const memoTypeBuId = typeRec.businessUnitId;
    const memoTypeDeptId = typeRec.departmentId;

    if (!memoTypeBuId) {
      res.status(400).json({ error: "MemoType must have a Business Unit" });
      return;
    }

    const buAbbr = typeRec.businessUnit?.abbreviation ?? "";
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

    /* ─────── 3) ไฟล์หลัก/แนบ + order ─────── */
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
                filePath: null,
              },
            }),
          ),
        );
      } catch (urlError) {
        console.error("Failed to create URL link attachments:", urlError);
        throw urlError;
      }
    }

    /* ─────── 4) ตำแหน่งลายเซ็น/วันที่/เลขเอกสาร ─────── */
    type SigPos = {
      userId: number;
      fileIdx: number;
      page: number;
      x: number;
      y: number;
      sizePct?: number;
      level?: number;
    };
    type DatePos = SigPos & { date: string };
    type NotePos = {
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

    /* ─────── 5) เตรียมรายชื่อผู้อนุมัติ "ล่วงหน้า" + ForUse slots ─────── */
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

      if (
        user.delegatedToUserId &&
        user.delegationStartDate &&
        user.delegationEndDate
      ) {
        const now = new Date();
        const isActiveDelegation =
          now >= user.delegationStartDate && now <= user.delegationEndDate;

        if (isActiveDelegation) {
          return user.delegatedToUserId;
        }
      }

      return userId;
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

          if (resolvedUserId !== null) {
            const userIdNum = Number(resolvedUserId);
            if (!Number.isFinite(userIdNum) || userIdNum <= 0) {
              console.warn(
                `⚠️ Invalid userId in override: ${resolvedUserId}, setting to null`,
              );
              resolvedUserId = null;
            } else {
              resolvedUserId = userIdNum;
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
            templatePivotId: null,
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
          actualUserId = null;
        } else if (slot && slot !== "FIXED_USER") {
          // MEMO_REQUESTER / DEPARTMENT_HEAD
          actualUserId = await resolveFlexibleSlot(
            slot,
            userIdNum,
            deptIdNum ?? null,
          );
          if (actualUserId) {
            actualUserId = await resolveDelegation(actualUserId);
          }
        } else {
          // FIXED_USER
          if (p.userId == null) continue;
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

    /* ─────── 5.1) บันทึก CC (Users + Groups) ─────── */
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

    /* ─────── 6) เขียน approver ForUse slots & actions ─────── */
    const waitingId = await getWaitingStatusId();

    let createdSlots: { id: number; userId: number | null }[] = [];
    if (forUseSlots.length) {
      // Reset the auto-increment sequence before creating new records
      await prisma.$executeRaw`
        SELECT setval(
          pg_get_serial_sequence('"LineOfApprovalUserPivotForUse"', 'id'),
          COALESCE((SELECT MAX(id) FROM "LineOfApprovalUserPivotForUse"), 0) + 1,
          false
        )
      `;

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

    // COMPENSATION LOGIC: ลบ Memo ที่เพิ่งสร้างถ้ามี Error
    if (memo && memo.id) {
      try {
        console.warn(`⚠️ Rolling back memo #${memo.id} due to error...`);

        await prisma.$transaction(async (tx) => {
          await tx.mainFile.deleteMany({ where: { memoId: memo.id } });
          await tx.attachedFile.deleteMany({ where: { memoId: memo.id } });
          await tx.signaturePosition.deleteMany({ where: { memoId: memo.id } });
          await tx.datePosition.deleteMany({ where: { memoId: memo.id } });
          await tx.memoNumberPosition.deleteMany({ where: { memoId: memo.id } });
          await tx.memoCc.deleteMany({ where: { memoId: memo.id } });
          await tx.memoApproverAction.deleteMany({ where: { memoId: memo.id } });
          await tx.lineOfApprovalUserPivotForUse.deleteMany({
            where: { memoId: memo.id },
          });
          await tx.memoStatusPivot.deleteMany({ where: { memoId: memo.id } });
          await tx.masterMemo.delete({ where: { id: memo.id } });
        });

        console.log(
          `✅ Rollback successful. Memo #${memo.id} and all related data deleted.`,
        );
      } catch (rollbackErr) {
        console.error("🔥 Rollback failed:", rollbackErr);
      }
    }

    res.status(500).json({ error: "Internal Server Error" });
    return;
  }
};

// ─── updateMemo ───────────────────────────────────────────────────────────────

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

    // CHECK STATUS: Allow update only if Draft(1), Rejected(4), Recalled(6)
    const currentStatus = await prisma.memoStatusPivot.findFirst({
      where: { memoId: id },
      orderBy: { createdAt: "desc" },
      select: { statusId: true },
    });
    const currentStatusId = currentStatus?.statusId ?? 0;

    if (![1, 4, 6].includes(currentStatusId)) {
      const statusCodeMap: Record<number, string> = {
        3: "APPROVED",
        5: "PROCESSING",
        7: "TERMINATED",
        8: "EXPIRED",
      };

      const statusCodeKey = statusCodeMap[currentStatusId] || "UNKNOWN";

      console.warn(
        `[updateMemo] BLOCKED: memoId=${id} is not editable. Current status: ${currentStatusId}`,
      );

      res.status(409).json({
        code: "MEMO_STATUS_CHANGED",
        statusCode: statusCodeKey,
        currentStatusId,
      });
      return;
    }

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

    /* ---------- 2.0 หา approvalLineId เดิม ---------- */
    const prev = await prisma.masterMemo.findUnique({
      where: { id },
      select: { approvalLineId: true },
    });
    const oldLineId = prev?.approvalLineId ?? null;

    /* ---------- 2.1 เตรียมค่า approvalLineField ---------- */
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

        // เคส "แถวเดิม" → loaUserPivotId = id ของ ForUse เดิม → UPDATE
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
                approvalRequirement:
                  (o.approvalRequirement as "ALL" | "ANY") ?? "ALL",
                templatePivotId: old.templatePivotId,
              },
              select: { id: true, userId: true },
            }),
          );
        } else {
          // เคส "แถวใหม่" → CREATE
          console.log(
            "[updateMemo] Creating new record for userId:",
            userIdVal,
            "level:",
            level,
          );
          upsertOps.push(
            prisma.lineOfApprovalUserPivotForUse.create({
              data: {
                memoId: id,
                userId: userIdVal,
                level,
                isSigReq: !!o.isSigReq,
                roleDescription: o.roleDescription ?? null,
                slotType: slot,
                approvalRequirement:
                  (o.approvalRequirement as "ALL" | "ANY") ?? "ALL",
                templatePivotId: null,
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

      // Add newly created ForUse IDs to keepIds
      const allKeepIds = [...keepIds, ...forUseRows.map((row) => row.id)];
      console.log(
        "[updateMemo] All IDs to keep (existing + new):",
        allKeepIds,
      );

      // เคลียร์ action เก่า ก่อนลบ ForUse เก่า
      const waitingId = await getWaitingStatusId();
      await prisma.memoApproverAction.deleteMany({ where: { memoId: id } });

      // ลบ ForUse ที่ไม่อยู่ใน override แล้ว
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

      // สร้าง action ใหม่ตาม ForUse ที่เพิ่งสร้าง
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

      // Reset the auto-increment sequence before creating new records
      await prisma.$executeRaw`
        SELECT setval(
          pg_get_serial_sequence('"LineOfApprovalUserPivotForUse"', 'id'),
          COALESCE((SELECT MAX(id) FROM "LineOfApprovalUserPivotForUse"), 0) + 1,
          false
        )
      `;

      const cloned = await prisma.$transaction(
        forUseSlots.map((slot) => {
          return prisma.lineOfApprovalUserPivotForUse.create({
            data: slot,
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

    /* ── 3-A ลบ mainFile / attachedFile ที่เลือกออก ── */
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

    // Delete existing URL links before creating new ones to avoid duplicates
    await prisma.attachedFile.deleteMany({
      where: { memoId: id, isUrl: true },
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
                filePath: null,
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

    /* ── 4. Positions (upsert) ── */
    type SigPos = {
      id?: number | string;
      userId: number;
      fileIdx: number;
      page: number;
      x: number;
      y: number;
      sizePct?: number;
      level?: number;
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

// ─── deleteMemo ───────────────────────────────────────────────────────────────

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

    // 4) Perform Soft Delete
    let deletedStatus = await prisma.status.findFirst({
      where: { name: "Deleted" },
    });
    if (!deletedStatus) {
      const maxStat = await prisma.status.aggregate({ _max: { id: true } });
      const nextId = (maxStat._max.id ?? 0) + 1;

      deletedStatus = await prisma.status.create({
        data: {
          id: nextId,
          name: "Deleted",
          description: "Soft deleted",
        },
      });
    }

    const userId = (req as any).user?.id || 0;

    await prisma.$transaction([
      prisma.memoStatusPivot.create({
        data: { memoId, statusId: deletedStatus.id, userId },
      }),
      prisma.memoHistory.create({
        data: {
          memoId,
          userId,
          action: "Memo deleted (soft delete)",
          statusId: deletedStatus.id,
          actiontype: ActionType.TERMINATE,
        },
      }),
      prisma.masterMemo.update({
        where: { id: memoId },
        data: { deletedAt: new Date() },
      }),
    ]);

    // suppress unused variable warning — allPaths collected for future hard-delete use
    void allPaths;

    res.sendStatus(204);
  } catch (err) {
    console.error("❌ deleteMemo failed", err);
    res.status(500).json({ error: "Delete failed" });
  }
};

// ─── forceDeleteMemo ──────────────────────────────────────────────────────────

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

// ─── renewExpiry ──────────────────────────────────────────────────────────────

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
    res
      .status(400)
      .json({ error: "expiresAt is required and must be a valid date" });
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
      res
        .status(403)
        .json({ error: "Only memo owner or admin can renew expiry" });
      return;
    }

    // Check latest status is Processing or Expired
    const latestPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      include: { status: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    });
    const latestStatusName = (latestPivot?.status?.name ?? "").toLowerCase();
    if (
      latestStatusName !== "processing" &&
      latestStatusName !== "expired" &&
      latestStatusName !== "draft"
    ) {
      res.status(400).json({
        error: `Cannot renew: current status is "${latestPivot?.status?.name ?? "unknown"}". Only Draft, Processing or Expired memos can be renewed.`,
      });
      return;
    }

    // Determine target status: "Draft" or "Processing" (default: "Processing")
    const targetStatus =
      req.body.targetStatus === "Draft" ? "Draft" : "Processing";

    const updated = await prisma.$transaction(async (tx) => {
      const updatedMemo = await tx.masterMemo.update({
        where: { id: memoId },
        data: { expiresAt: parsed },
        select: { id: true, expiresAt: true, subject: true },
      });

      if (latestStatusName === "expired") {
        const expiredStatusId = await getStatusIdByName("Expired");
        const newStatusId = await getStatusIdByName(targetStatus);

        await tx.memoStatusPivot.deleteMany({
          where: { memoId, statusId: expiredStatusId },
        });

        await tx.memoStatusPivot.upsert({
          where: {
            memoId_userId_statusId: {
              memoId,
              userId: actorId,
              statusId: newStatusId,
            },
          },
          update: { createdAt: new Date() },
          create: { memoId, userId: actorId, statusId: newStatusId },
        });

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
