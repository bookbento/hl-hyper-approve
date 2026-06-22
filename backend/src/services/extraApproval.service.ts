/**
 * ExtraApprovalService
 *
 * Extracted from memo.controller.ts — all Extra Approval Line operations.
 * Behavior is 100% identical to the original controller code; no logic changes.
 *
 * This file is self-contained: email helpers (sendExtraApprovalEmailsAsync,
 * sendDeleteExtraApprovalEmailsAsync) are duplicated here rather than imported
 * from memo.controller to avoid a circular dependency.
 *
 * Public surface:
 *   recomputeExtraLineStatus        — re-derive line status from its approvers
 *   hasActiveExtraLine              — check if memo has an active line
 *   createExtraApprovalLine         — RequestHandler
 *   appendExtraApprovers            — RequestHandler
 *   actOnExtraApprovalLine          — RequestHandler
 *   getActiveExtraApprovalLine      — RequestHandler
 *   getActiveExtraApprovalLinesBulk — RequestHandler
 *   listExtraApprovalLines          — RequestHandler
 *   removeExtraApprovalLine         — RequestHandler
 */

import path from "path";
import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { ActionType, ExtraStatus } from "@prisma/client";
import {
  getUserDisplayName,
  notifyStatusUpdate,
} from "../controllers/memoStatus.controller";
import { filterUsersForEmail } from "../lib/notificationPreferences";
import { sendEmail } from "../lib/mailer";
import { makeEmailToken } from "../lib/token";

/* ───── FRONTEND_URL: must be set in .env ───── */
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

// ─── Private helper: look up a Status row id by its name ───────────────────
async function getStatusIdByName(name: string): Promise<number> {
  const rec = await prisma.status.findFirst({
    where: { name },
    select: { id: true },
  });
  if (!rec) throw new Error(`ต้องมี Status.name = "${name}" ในตาราง Status`);
  return rec.id;
}

// ─── Helper: คำนวณสถานะ Extra line ตามสถานะของ approvers ──────────────────
export async function recomputeExtraLineStatus(
  lineId: number,
): Promise<ExtraStatus> {
  const approvedId = await getStatusIdByName("Approved");
  const rejectedId = await getStatusIdByName("Rejected");

  const rows = await prisma.extraApprover.findMany({
    where: { extraId: lineId },
    select: { statusId: true },
  });

  const hasAny = rows.length > 0;
  const anyRejected = rows.some((r) => r.statusId === rejectedId);
  const allApproved = hasAny && rows.every((r) => r.statusId === approvedId);
  const anyApproved = hasAny && rows.some((r) => r.statusId === approvedId);

  let final: ExtraStatus;
  if (anyRejected) final = ExtraStatus.REJECTED;
  else if (allApproved) final = ExtraStatus.COMPLETED;
  else if (anyApproved) final = ExtraStatus.IN_PROGRESS;
  else final = ExtraStatus.PENDING;

  await prisma.extraApprovalLine.update({
    where: { id: lineId },
    data: {
      status: final,
      createdAt: new Date(),
      closedAt:
        final === ExtraStatus.COMPLETED || final === ExtraStatus.REJECTED
          ? new Date()
          : null,
    },
  });

  // Update ExtraStatus in Comments to match the overall line status
  const formattedStatus = final
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
  await prisma.comment.updateMany({
    where: { extraApprovalLineId: lineId },
    data: { ExtraStatus: formattedStatus },
  });

  return final;
}

// ─── Private helper: check if memo has an active extra line ────────────────
export async function hasActiveExtraLine(memoId: number): Promise<boolean> {
  const row = await prisma.extraApprovalLine.findFirst({
    where: {
      memoId,
      status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] },
    },
    select: { id: true },
  });
  return !!row;
}

// ─── Email helpers (self-contained — no import from memo.controller) ────────

async function sendExtraApprovalEmailsAsync({
  receiverIds,
  memoSubject,
  memoNumber,
  memoId,
  actorName,
  mode,
  addedNames,
  ownerId,
}: {
  receiverIds: number[];
  memoSubject: string;
  memoNumber: string | number;
  memoId: number;
  actorName: string;
  mode: "requested" | "added";
  addedNames?: string[];
  ownerId?: number;
}): Promise<{ attempted: number; okCount: number; failCount: number }> {
  try {
    const latestPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: "desc" },
      include: { status: { select: { id: true, name: true } } },
    });
    const SILENT_STATUS_IDS = new Set([1, 6]);
    const SILENT_STATUS_NAMES = new Set(["draft", "recalled"]);
    const stId = latestPivot?.status?.id ?? null;
    const stName = (latestPivot?.status?.name ?? "").toLowerCase();
    if (
      stId === null ||
      SILENT_STATUS_IDS.has(stId) ||
      SILENT_STATUS_NAMES.has(stName)
    ) {
      return { attempted: 0, okCount: 0, failCount: 0 };
    }

    if (!receiverIds?.length) return { attempted: 0, okCount: 0, failCount: 0 };

    const filteredReceiverIds = await filterUsersForEmail(
      receiverIds,
      "add-extra-approval",
    );
    if (!filteredReceiverIds.length)
      return { attempted: 0, okCount: 0, failCount: 0 };

    const users = await prisma.user.findMany({
      where: { id: { in: filteredReceiverIds } },
      select: { id: true, name: true, email: true },
    });

    const sendTo = users.filter((u) => !!u.email);
    if (!sendTo.length) return { attempted: 0, okCount: 0, failCount: 0 };

    const logoPath = path.resolve(
      process.cwd(),
      "..",
      "frontend",
      "public",
      "img",
      "New-ememo-icon-4.png",
    );

    const results = await Promise.allSettled(
      sendTo.map(async (u) => {
        const token = await makeEmailToken(u.id, memoId);
        const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
        const isOwner = u.id === ownerId;

        const subjectLine = isOwner
          ? mode === "added"
            ? `Extra approver(s) added to your memo ${memoNumber}: ${memoSubject}`
            : `Extra approval line requested for your memo ${memoNumber}: ${memoSubject}`
          : mode === "added"
            ? `You were added as an extra approver on memo ${memoNumber}: ${memoSubject}`
            : `Extra approval requested on memo ${memoNumber}: ${memoSubject}`;

        return sendEmail(
          [u.email!],
          subjectLine,
          buildExtraPlain(
            u.name,
            actorName,
            memoSubject,
            memoNumber,
            viewLink,
            mode,
            addedNames,
            isOwner,
          ),
          buildExtraHtml(
            u.name,
            actorName,
            memoSubject,
            memoNumber,
            viewLink,
            mode,
            addedNames,
            isOwner,
          ),
          [],
        );
      }),
    );

    const okCount = results.filter((r) => r.status === "fulfilled").length;
    return {
      attempted: sendTo.length,
      okCount,
      failCount: results.length - okCount,
    };
  } catch (err) {
    console.error("extra-approval mail error:", err);
    return { attempted: 0, okCount: 0, failCount: 0 };
  }
}

async function sendDeleteExtraApprovalEmailsAsync({
  receiverIds,
  memoSubject,
  memoNumber,
  memoId,
  actorName,
  deletedNames,
  isOwner,
}: {
  receiverIds: number[];
  memoSubject: string;
  memoNumber: string | number;
  memoId: number;
  actorName: string;
  deletedNames: string[];
  isOwner: boolean;
}): Promise<void> {
  try {
    const latestPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: "desc" },
      include: { status: { select: { id: true, name: true } } },
    });
    const SILENT_STATUS_IDS = new Set([1, 6]);
    const SILENT_STATUS_NAMES = new Set(["draft", "recalled"]);
    const stId = latestPivot?.status?.id ?? null;
    const stName = (latestPivot?.status?.name ?? "").toLowerCase();
    if (
      stId === null ||
      SILENT_STATUS_IDS.has(stId) ||
      SILENT_STATUS_NAMES.has(stName)
    ) {
      return;
    }

    if (!receiverIds?.length) return;

    const filteredReceiverIds = await filterUsersForEmail(
      receiverIds,
      "remove-extra-approval",
    );
    if (!filteredReceiverIds.length) return;

    const users = await prisma.user.findMany({
      where: { id: { in: filteredReceiverIds } },
      select: { id: true, name: true, email: true },
    });

    const sendTo = users.filter((u) => !!u.email);
    if (!sendTo.length) return;

    const subjectLine = isOwner
      ? `Extra approval line deleted on your memo ${memoNumber}: ${memoSubject}`
      : `Your extra approval line was deleted on memo ${memoNumber}: ${memoSubject}`;

    await Promise.allSettled(
      sendTo.map(async (u) => {
        const viewLink = `${FRONTEND_URL}/memo/${memoId}`;
        return sendEmail(
          [u.email!],
          subjectLine,
          buildDeleteExtraPlain(
            u.name,
            actorName,
            memoSubject,
            memoNumber,
            viewLink,
            deletedNames,
            isOwner,
          ),
          buildDeleteExtraHtml(
            u.name,
            actorName,
            memoSubject,
            memoNumber,
            viewLink,
            deletedNames,
            isOwner,
          ),
          [],
        );
      }),
    );
  } catch (err) {
    console.error("delete-extra-approval-mail error:", err);
  }
}

function buildExtraPlain(
  receiver: string,
  actorName: string,
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  mode: "requested" | "added",
  addedNames?: string[],
  isOwner?: boolean,
): string {
  const addedUsersStr = addedNames?.length ? ` (${addedNames.join(", ")})` : "";
  const lead = isOwner
    ? mode === "added"
      ? `${actorName} added extra approver(s)${addedUsersStr} to your memo "${memoSubject}".`
      : `${actorName} requested an extra-approval line${addedUsersStr} for your memo "${memoSubject}".`
    : mode === "added"
      ? `${actorName} added you as an extra approver on "${memoSubject}".`
      : `${actorName} created an extra-approval line${addedUsersStr} for "${memoSubject}" and you are listed as an approver.`;
  return `Hello ${receiver},\n\n${lead}\n\nView memo: ${viewLink}\nMemo No.: ${ref}`;
}

function buildExtraHtml(
  receiver: string,
  actorName: string,
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  mode: "requested" | "added",
  addedNames?: string[],
  isOwner?: boolean,
): string {
  const addedUsersStr = addedNames?.length
    ? ` (<b>${addedNames.join(", ")}</b>)`
    : "";
  const leadHtml = isOwner
    ? mode === "added"
      ? `<strong>${actorName}</strong> added <b>extra approver(s)</b>${addedUsersStr} to your memo <em>"${memoSubject}"</em>.`
      : `<strong>${actorName}</strong> requested an <b>extra-approval line</b>${addedUsersStr} for your memo <em>"${memoSubject}"</em>.`
    : mode === "added"
      ? `<strong>${actorName}</strong> added you as an <b>extra approver</b> on <em>"${memoSubject}"</em>.`
      : `<strong>${actorName}</strong> created an <b>extra-approval line</b>${addedUsersStr} for <em>"${memoSubject}"</em> and you are listed as an approver.`;

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
        <div style="background:#edecec; padding:25px;text-align:center">
          <h2 style="margin:0;color:#183e33">HyLife e-Approval</h2>
        </div>
        <div style="padding:30px">
          <p>Hello <strong>${receiver}</strong>,</p>
          <p>${leadHtml}</p>
          <p style="text-align:center;margin:30px 0">
            <a href="${viewLink}"
               style="background:#183e33;color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none">
              Open Memo
            </a>
          </p>
          <p style="font-size:12px;color:#888">Memo No.: ${ref}</p>
        </div>
        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}

function buildDeleteExtraPlain(
  receiver: string,
  actorName: string,
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  deletedNames: string[],
  isOwner: boolean,
): string {
  const deletedUsersStr = deletedNames.length
    ? ` (${deletedNames.join(", ")})`
    : "";
  const lead = isOwner
    ? `${actorName} removed an extra approval line${deletedUsersStr} from your memo "${memoSubject}".`
    : `${actorName} removed your extra approval line from "${memoSubject}".`;
  return `Hello ${receiver},\n\n${lead}\n\nView memo: ${viewLink}\nMemo No.: ${ref}`;
}

function buildDeleteExtraHtml(
  receiver: string,
  actorName: string,
  memoSubject: string,
  ref: string | number,
  viewLink: string,
  deletedNames: string[],
  isOwner: boolean,
): string {
  const deletedUsersStr = deletedNames.length
    ? ` (<b>${deletedNames.join(", ")}</b>)`
    : "";
  const leadHtml = isOwner
    ? `<strong>${actorName}</strong> removed an <b>extra approval line</b>${deletedUsersStr} from your memo <em>"${memoSubject}"</em>.`
    : `<strong>${actorName}</strong> removed your <b>extra approval line</b> from <em>"${memoSubject}"</em>.`;

  return `
  <html>
    <body style="font-family:'Segoe UI',Arial,sans-serif;background:#f7f9fc;margin:0;padding:0">
      <div style="max-width:640px;margin:20px auto;background:#fff;border-radius:8px;overflow:hidden">
        <div style="background:#edecec; padding:25px;text-align:center">
          <h2 style="margin:0;color:#183e33">HyLife e-Approval</h2>
        </div>
        <div style="padding:30px">
          <p>Hello <strong>${receiver}</strong>,</p>
          <p>${leadHtml}</p>
          <p style="text-align:center;margin:30px 0">
            <a href="${viewLink}"
               style="background:#183e33;color:#fff;padding:12px 28px;border-radius:5px;text-decoration:none">
              View Memo
            </a>
          </p>
          <p style="font-size:12px;color:#888">Memo No.: ${ref}</p>
        </div>
        <div style="background:#fafafa;text-align:center;font-size:12px;color:#777;padding:15px">
          © ${new Date().getFullYear()} HYLIFE GROUP
        </div>
      </div>
    </body>
  </html>`;
}

// ─── POST /api/memos/:id/extra-approval-lines ──────────────────────────────
export const createExtraApprovalLine: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const actorId = req.user!.id;

  // dedupe ตั้งแต่ต้น
  const userIds: number[] = Array.isArray(req.body.userIds)
    ? Array.from(new Set(req.body.userIds.map(Number).filter(Boolean)))
    : [];

  if (!memoId || !userIds.length) {
    res.status(400).json({ error: "memoId / userIds ไม่ถูกต้อง" });
    return;
  }

  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true, subject: true, memonumber: true },
  });
  if (!memo) {
    res.status(404).json({ error: "Memo not found" });
    return;
  }

  // Check current status - can only add extra approval when Processing (5)
  const currentStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    select: { statusId: true },
  });

  const currentStatusId = currentStatus?.statusId ?? 0;

  if (currentStatusId !== 5) {
    const statusCodeMap: Record<number, string> = {
      1: "DRAFT_APPROVE",
      3: "APPROVED",
      4: "REJECTED",
      6: "RECALLED",
      7: "TERMINATED",
      8: "EXPIRED",
    };

    const statusCodeKey = statusCodeMap[currentStatusId] || "UNKNOWN";

    console.warn(
      `[createExtraApprovalLine] BLOCKED: memoId=${memoId} is not in Processing. Current status: ${currentStatusId}. User: ${actorId}`,
    );
    res.status(409).json({
      code: "MEMO_STATUS_CHANGED",
      statusCode: statusCodeKey,
      currentStatusId,
    });
    return;
  }

  const isOwner = memo.userId === actorId;

  // เช็คว่าเป็น Approver ใน approval line (ทุก level ไม่ใช่แค่ current)
  const isApprover = !!(await prisma.lineOfApprovalUserPivotForUse.findFirst({
    where: { memoId, userId: actorId },
    select: { id: true },
  }));

  // เช็คว่าเป็น CC ของ memo นี้หรือไม่
  const isCc = !!(await prisma.memoCc.findFirst({
    where: { memoId, userId: actorId },
    select: { id: true },
  }));

  // เช็คว่าถูก Mention ใน comments หรือไม่
  const isMentioned = !!(await prisma.commentTag.findFirst({
    where: { memoId, userId: actorId },
    select: { id: true },
  }));

  // เช็คว่าเป็น Extra Approver (เคยอยู่ใน extra line ของ memo นี้) หรือไม่
  const isExtraApprover = !!(await prisma.extraApprover.findFirst({
    where: { userId: actorId, extra: { memoId } },
    select: { id: true },
  }));

  if (!isOwner && !isApprover && !isCc && !isMentioned && !isExtraApprover) {
    res
      .status(403)
      .json({ error: "ไม่มีสิทธิ์สร้างไลน์อนุมัติพิเศษในขั้นตอนนี้" });
    return;
  }

  // ALLOW MULTIPLE ACTIVE LINES (Request Step 602)
  // Check removed: we want separate cards for new additions.

  // รับ preApprovedUsers - คนที่ approved แล้วจาก line ก่อนหน้า พร้อมเวลาเดิม
  const preApprovedUsers: { userId: number; actedAt: string | null }[] =
    Array.isArray(req.body.preApprovedUsers) ? req.body.preApprovedUsers : [];

  // รับ comment text (optional)
  const commentText: string | undefined = req.body.comment?.trim() || undefined;

  // สร้าง Lookup Map: userId -> actedAt
  const preApprovedMap = new Map<number, Date>();
  preApprovedUsers.forEach((u) => {
    const d = u.actedAt ? new Date(u.actedAt) : new Date();
    preApprovedMap.set(Number(u.userId), d);
  });

  // หา status ID ของ "Approved"
  const approvedStatusId = await getStatusIdByName("Approved");

  // สร้าง approvers data พร้อม status ที่เหมาะสม
  const approversData = userIds.map((uid) => {
    const isPreApproved = preApprovedMap.has(uid);
    const originalActedAt = preApprovedMap.get(uid);
    return {
      userId: uid,
      statusId: isPreApproved ? approvedStatusId : null,
      actedAt: isPreApproved ? (originalActedAt ?? new Date()) : null,
    };
  });

  const line = await prisma.extraApprovalLine.create({
    data: {
      memoId,
      createdById: actorId,
      status: ExtraStatus.PENDING,
      approvers: { create: approversData },
    },
    include: {
      approvers: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              lastname: true,
              nickname: true,
              profileImagePath: true,
            },
          },
          status: { select: { id: true, name: true } },
        },
      },
      comment: true,
    },
  });

  // สร้าง comments ให้กับทุกคนที่ถูกเลือกใน userIds เสมอ
  const commentsData = userIds.map((uid) => ({
    memoId,
    userId: actorId,
    comment: commentText || "",
    ExtraUserid: uid,
    ExtraStatus: preApprovedMap.has(uid) ? "Approved" : "Pending",
    extraApprovalLineId: line.id,
  }));

  await prisma.comment.createMany({ data: commentsData });

  // โหลด comments กลับมาแปะใน line
  line.comment = await prisma.comment.findMany({
    where: { extraApprovalLineId: line.id },
  });

  // email + notification + history
  try {
    const fmtName = (u: {
      name?: string | null;
      lastname?: string | null;
      nickname?: string | null;
    }) => {
      const base = [u.name, u.lastname].filter(Boolean).join(" ").trim();
      return u.nickname ? `${base} (${u.nickname})` : base || (u.name ?? "");
    };

    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { name: true, lastname: true, nickname: true },
    });
    const actorLabel = fmtName(actor ?? {});

    const recipients = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, lastname: true, nickname: true, email: true },
    });

    const addedNames = recipients.map((u) => fmtName(u));
    const ownerId = memo.userId;
    const receiverIds = ownerId
      ? Array.from(new Set([ownerId, ...userIds]))
      : userIds;

    const { attempted, okCount, failCount } =
      await sendExtraApprovalEmailsAsync({
        receiverIds,
        memoSubject: memo.subject || `#${memoId}`,
        memoNumber: memo.memonumber ?? memoId,
        memoId,
        actorName: actorLabel,
        mode: "requested",
        addedNames,
        ownerId,
      });

    const notificationSlug = "add-extra-approval";
    const allIds = [ownerId ? ownerId : -1, ...recipients.map((u) => u.id)].filter(
      (id) => id > 0,
    );
    const filteredNotificationIds = await filterUsersForEmail(
      allIds,
      notificationSlug,
    );
    const notifySet = new Set(filteredNotificationIds);

    if (ownerId && recipients.length > 0 && notifySet.has(ownerId)) {
      await prisma.notification.createMany({
        data: [
          {
            memoId,
            userId: ownerId,
            actorId,
            notificationTypeId: 2,
            message: `${actorLabel} requested an extra approval line from ${addedNames.join(", ")} for "${
              memo.subject || `#${memoId}`
            }".`,
          },
        ],
      });
    }

    if (recipients.length > 0) {
      const notifyRecipients = recipients.filter(
        (u) => u.id !== ownerId && notifySet.has(u.id),
      );
      if (notifyRecipients.length) {
        await prisma.notification.createMany({
          data: notifyRecipients.map((u) => ({
            memoId,
            userId: u.id,
            actorId,
            notificationTypeId: 2,
            message: `You were assigned as an extra approver to "${
              memo.subject || `#${memoId}`
            }".`,
          })),
        });
      }
    }

    const preApprovedSet = new Set(preApprovedUsers.map((u) => Number(u.userId)));
    const newRecipients = recipients.filter((u) => !preApprovedSet.has(u.id));
    const recipientNames = newRecipients.map((u) => fmtName(u));
    const namesList = recipientNames.join(", ");

    await prisma.memoHistory.create({
      data: {
        memoId,
        userId: actorId,
        action: `Extra Approver added: ${namesList} by ${actorLabel}`,
        actiontype: ActionType.UPDATE,
        timestamp: new Date(),
      },
    });
  } catch (e) {
    console.warn("[createExtraApprovalLine] post-actions failed:", e);
    await prisma.memoHistory.create({
      data: {
        memoId,
        userId: actorId,
        action: `Extra approval line created; notification step failed.`,
        actiontype: ActionType.UPDATE,
        timestamp: new Date(),
      },
    });
  }

  res.status(201).json(line);
};

// ─── POST /api/memos/:memoId/extra-approval-lines/:lineId/append ───────────
export const appendExtraApprovers: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.memoId);
  const lineId = Number(req.params.lineId);
  const actorId = req.user!.id;

  const raw = Array.isArray(req.body.userIds)
    ? (req.body.userIds as Array<string | number>)
    : [];
  const userIds: number[] = Array.from(
    new Set<number>(
      raw
        .map((v) => Number(v))
        .filter((n): n is number => Number.isFinite(n) && n > 0),
    ),
  );

  if (!memoId || !lineId || userIds.length === 0) {
    res.status(400).json({ error: "memoId/lineId หรือ userIds ไม่ถูกต้อง" });
    return;
  }

  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true, subject: true, memonumber: true },
  });
  if (!memo) {
    res.status(404).json({ error: "Memo not found" });
    return;
  }

  // Check current status - can only append to extra line when Processing (5)
  const currentStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    select: { statusId: true },
  });

  const currentStatusId = currentStatus?.statusId ?? 0;

  if (currentStatusId !== 5) {
    const statusCodeMap: Record<number, string> = {
      1: "DRAFT_APPROVE",
      3: "APPROVED",
      4: "REJECTED",
      6: "RECALLED",
      7: "TERMINATED",
      8: "EXPIRED",
    };
    const statusCodeKey = statusCodeMap[currentStatusId] || "UNKNOWN";
    console.warn(
      `[appendExtraApprovers] BLOCKED: memoId=${memoId} is not in Processing. Current status: ${currentStatusId}. User: ${actorId}`,
    );
    res.status(409).json({
      code: "MEMO_STATUS_CHANGED",
      statusCode: statusCodeKey,
      currentStatusId,
    });
    return;
  }

  // อนุญาต "ผู้มีส่วนร่วมทุกคน"
  const { _max } = await prisma.memoApproverAction.aggregate({
    where: { memoId },
    _max: { version: true },
  });
  const latestVersion = _max.version ?? 1;

  const [loaRows, ccRows, extraRows, extraCreators, mentionedRows] =
    await Promise.all([
      prisma.memoApproverAction.findMany({
        where: { memoId, version: latestVersion },
        select: { loaUser: { select: { userId: true } } },
      }),
      prisma.memoCc.findMany({ where: { memoId }, select: { userId: true } }),
      prisma.extraApprover.findMany({
        where: { extra: { memoId } },
        select: { userId: true },
      }),
      prisma.extraApprovalLine.findMany({
        where: { memoId },
        select: { createdById: true },
      }),
      prisma.commentTag.findMany({
        where: { memoId },
        select: { userId: true },
      }),
    ]);

  const approverUserIds = new Set<number>(
    loaRows
      .map((r) => r.loaUser.userId)
      .filter((id): id is number => id !== null),
  );
  const ccUserIds = new Set<number>(ccRows.map((r) => r.userId));
  const extraUserIds = new Set<number>(extraRows.map((r) => r.userId));
  const extraCreatorIds = new Set<number>(
    extraCreators.map((x) => x.createdById),
  );
  const mentionedUserIds = new Set<number>(mentionedRows.map((r) => r.userId));

  const participants = new Set<number>([
    memo.userId,
    ...approverUserIds,
    ...ccUserIds,
    ...extraUserIds,
    ...extraCreatorIds,
    ...mentionedUserIds,
  ]);

  if (!participants.has(actorId)) {
    res.status(403).json({
      error:
        "ไม่มีสิทธิ์เพิ่มผู้อนุมัติพิเศษ (เฉพาะผู้มีส่วนร่วมของเมโมเท่านั้น)",
    });
    return;
  }

  const line = await prisma.extraApprovalLine.findUnique({
    where: { id: lineId },
    include: { approvers: true },
  });
  if (!line || line.memoId !== memoId) {
    res.status(404).json({ error: "ไม่พบ Extra line ของเมโมนี้" });
    return;
  }
  if (line.status === ExtraStatus.REJECTED) {
    res
      .status(409)
      .json({ error: "ไลน์นี้ถูก Reject แล้ว ไม่สามารถเพิ่มได้" });
    return;
  }

  // ตรวจสอบว่ามีผู้อนุมัติที่ยังไม่ได้ทำการอนุมัติ/ปฏิเสธหรือไม่
  const hasPendingApprovals = line.approvers.some((a) => !a.statusId);
  if (hasPendingApprovals) {
    res.status(409).json({
      error:
        "ไม่สามารถเพิ่มผู้อนุมัติได้ในขณะนี้ กรุณารอให้ผู้อนุมัติปัจจุบันทำการอนุมัติหรือปฏิเสธก่อน",
    });
    return;
  }

  // กันซ้ำ
  const existed = new Set<number>(line.approvers.map((a) => a.userId));
  const candidates = userIds.filter((uid) => !existed.has(uid));

  // ไม่กัน CC แล้ว ให้คนที่เป็น CC ถูกดันขึ้น Extra approver ได้
  const toAdd = candidates.filter((uid) => !approverUserIds.has(uid));
  const skippedCount = userIds.length - toAdd.length;

  if (toAdd.length === 0) {
    const unchanged = await prisma.extraApprovalLine.findUnique({
      where: { id: lineId },
      include: {
        approvers: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
                profileImagePath: true,
              },
            },
            status: { select: { id: true, name: true } },
          },
          orderBy: { id: "asc" },
        },
      },
    });
    res.json(unchanged);
    return;
  }

  await prisma.extraApprover.createMany({
    data: toAdd.map((uid) => ({ extraId: lineId, userId: uid })),
  });

  const newStatus = await recomputeExtraLineStatus(lineId);

  // Email + Notification + History
  try {
    const actorName = await getUserDisplayName(actorId);

    const fmtName = (u: {
      name?: string | null;
      lastname?: string | null;
      nickname?: string | null;
    }) => {
      const base = [u.name, u.lastname].filter(Boolean).join(" ").trim();
      return u.nickname ? `${base} (${u.nickname})` : base || (u.name ?? "");
    };

    const addedUsers = await prisma.user.findMany({
      where: { id: { in: toAdd } },
      select: { id: true, name: true, lastname: true, nickname: true },
    });
    const addedNames = addedUsers.map((u) => fmtName(u));

    const ownerId = memo.userId;
    const receiverIds = ownerId
      ? Array.from(new Set([ownerId, ...toAdd]))
      : toAdd;

    const { attempted, okCount, failCount } =
      await sendExtraApprovalEmailsAsync({
        receiverIds,
        memoSubject: memo.subject || `#${memoId}`,
        memoNumber: memo.memonumber ?? memoId,
        memoId,
        actorName,
        mode: "added",
        addedNames,
        ownerId,
      });

    const notificationSlug = "add-extra-approval";
    const allIds = [ownerId ? ownerId : -1, ...toAdd].filter((id) => id > 0);
    const filteredNotificationIds = await filterUsersForEmail(
      allIds,
      notificationSlug,
    );
    const notifySet = new Set(filteredNotificationIds);

    if (ownerId && notifySet.has(ownerId)) {
      await prisma.notification.createMany({
        data: [
          {
            memoId,
            userId: ownerId,
            actorId,
            notificationTypeId: 2,
            message: `${actorName} added ${addedNames.join(", ")} as extra approver(s) to "${
              memo.subject || `#${memoId}`
            }".`,
          },
        ],
      });
    }

    if (addedUsers.length) {
      const notifyAdded = addedUsers.filter(
        (u) => u.id !== ownerId && notifySet.has(u.id),
      );
      if (notifyAdded.length) {
        await prisma.notification.createMany({
          data: notifyAdded.map((u) => ({
            memoId,
            userId: u.id,
            actorId,
            notificationTypeId: 2,
            message: `You were added as an extra approver to "${
              memo.subject || `#${memoId}`
            }".`,
          })),
        });
      }
    }

    const base =
      `${actorName} added ${toAdd.length} ${addedNames.join(", ")}` +
      (skippedCount
        ? `; skipped ${skippedCount} (duplicate in Extra/LoA)`
        : "") +
      `; line → ${newStatus}`;

    await prisma.memoHistory.create({
      data: {
        memoId,
        userId: actorId,
        action: attempted
          ? `${base}; emailed ${okCount}/${attempted}${
              failCount ? ` (failed ${failCount})` : ""
            }`
          : `${base}; no emails sent`,
        actiontype: ActionType.UPDATE,
        timestamp: new Date(),
      },
    });
  } catch (e) {
    await prisma.memoHistory.create({
      data: {
        memoId,
        userId: actorId,
        action: `Added ${toAdd.length} extra approver(s); post-actions failed; line → ${newStatus}`,
        actiontype: ActionType.UPDATE,
        timestamp: new Date(),
      },
    });
  }

  const updated = await prisma.extraApprovalLine.findUnique({
    where: { id: lineId },
    include: {
      approvers: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              lastname: true,
              nickname: true,
              profileImagePath: true,
            },
          },
          status: { select: { id: true, name: true } },
        },
        orderBy: { id: "asc" },
      },
    },
  });

  res.json(updated);
};

// ─── POST /api/memos/:memoId/extra-approval-lines/:lineId/action ───────────
export const actOnExtraApprovalLine: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.memoId);
  const lineId = Number(req.params.lineId);
  const actorId = req.user!.id;
  const statusCode = String((req.body as any).statusCode || "").toLowerCase();

  if (!["approved", "rejected"].includes(statusCode)) {
    res.status(400).json({ error: "statusCode ต้องเป็น approved/rejected" });
    return;
  }

  // Check current memo status - can only act on extra line when Processing (5)
  const currentStatus = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    select: { statusId: true },
  });

  const currentStatusId = currentStatus?.statusId ?? 0;

  if (currentStatusId !== 5) {
    const statusCodeMap: Record<number, string> = {
      1: "DRAFT_APPROVE",
      3: "APPROVED",
      4: "REJECTED",
      6: "RECALLED",
      7: "TERMINATED",
      8: "EXPIRED",
    };
    const statusCodeKey = statusCodeMap[currentStatusId] || "UNKNOWN";
    console.warn(
      `[actOnExtraApprovalLine] BLOCKED: memoId=${memoId} is not in Processing. Current status: ${currentStatusId}. User: ${actorId}`,
    );
    res.status(409).json({
      code: "MEMO_STATUS_CHANGED",
      statusCode: statusCodeKey,
      currentStatusId,
    });
    return;
  }

  // ต้องเป็นหนึ่งใน approvers ของไลน์นี้
  const target = await prisma.extraApprover.findFirst({
    where: { extraId: lineId, userId: actorId },
    include: { extra: true },
  });
  if (!target) {
    res.status(404).json({ error: "ไม่พบสิทธิ์ในการอนุมัติพิเศษ" });
    return;
  }
  if (target.extra.memoId !== memoId) {
    res.status(400).json({ error: "memoId ไม่ตรง" });
    return;
  }

  // line ต้องยัง active (PENDING/IN_PROGRESS)
  const ACTIVE = new Set<ExtraStatus>([
    ExtraStatus.PENDING,
    ExtraStatus.IN_PROGRESS,
  ]);
  const line = await prisma.extraApprovalLine.findUnique({
    where: { id: lineId },
  });
  if (!line || !ACTIVE.has(line.status)) {
    res.status(409).json({ error: "ไลน์นี้ไม่อยู่ในสถานะรอแล้ว" });
    return;
  }

  // ยังไม่ได้กดมาก่อน (รอ = statusId เป็น null)
  if (target.statusId) {
    res.status(409).json({ error: "คุณดำเนินการไปแล้ว" });
    return;
  }

  // อัปเดตสถานะของคนกด
  const newStatusId = await getStatusIdByName(
    statusCode === "approved" ? "Approved" : "Rejected",
  );
  await prisma.extraApprover.update({
    where: { id: target.id },
    data: { statusId: newStatusId, actedAt: new Date() },
  });

  // หากมีใคร rejected → ปิดไลน์ทันที + อัปเดตสถานะ memo เป็น Rejected
  if (statusCode === "rejected") {
    await prisma.extraApprovalLine.update({
      where: { id: lineId },
      data: { status: ExtraStatus.REJECTED, closedAt: new Date() },
    });
    await prisma.comment.updateMany({
      where: { extraApprovalLineId: lineId },
      data: { ExtraStatus: "Rejected" },
    });

    const memo = await prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true },
    });
    const ownerId = memo!.userId;

    const memoRejectedId = await getStatusIdByName("Rejected");

    await prisma.memoStatusPivot.deleteMany({
      where: { memoId, userId: ownerId, statusId: memoRejectedId },
    });

    const ownerPivot = await prisma.memoStatusPivot.findFirst({
      where: { memoId, userId: ownerId },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (ownerPivot) {
      await prisma.memoStatusPivot.update({
        where: { id: ownerPivot.id },
        data: { statusId: memoRejectedId, createdAt: new Date() },
      });
    } else {
      await prisma.memoStatusPivot.create({
        data: { memoId, userId: ownerId, statusId: memoRejectedId },
      });
    }

    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { name: true, lastname: true, nickname: true },
    });
    const fmtName = (u: {
      name?: string | null;
      lastname?: string | null;
      nickname?: string | null;
    }) => {
      const base = [u.name, u.lastname].filter(Boolean).join(" ").trim();
      return u.nickname ? `${base} (${u.nickname})` : base || (u.name ?? "");
    };
    const actorName = fmtName(actor ?? {});

    await prisma.memoHistory.create({
      data: {
        memoId,
        userId: actorId,
        statusId: memoRejectedId,
        action: `Extra Approval: ${actorName} rejected extra-approval`,
        actiontype: ActionType.REJECT,
        timestamp: new Date(),
      },
    });

    res.json({ ok: true, closed: "rejected" });
    setImmediate(() => {
      notifyStatusUpdate(memoId, actorId, actorName, 4, null).catch((err) =>
        console.error("notifyStatusUpdate extra reject error", err),
      );
    });
    return;
  }

  // กรณี approved → ถ้า line ยัง PENDING ให้เปลี่ยนเป็น IN_PROGRESS
  if (line.status === ExtraStatus.PENDING) {
    await prisma.extraApprovalLine.update({
      where: { id: lineId },
      data: { status: ExtraStatus.IN_PROGRESS },
    });
    await prisma.comment.updateMany({
      where: { extraApprovalLineId: lineId },
      data: { ExtraStatus: "In Progress" },
    });
  }

  // ตรวจว่าทุกคนอนุมัติครบหรือยัง
  const approvedId = await getStatusIdByName("Approved");
  const all = await prisma.extraApprover.findMany({
    where: { extraId: lineId },
    select: { statusId: true },
  });
  const allApproved =
    all.length > 0 && all.every((a) => a.statusId === approvedId);

  if (allApproved) {
    await prisma.extraApprovalLine.update({
      where: { id: lineId },
      data: { status: ExtraStatus.COMPLETED, closedAt: new Date() },
    });
    await prisma.comment.updateMany({
      where: { extraApprovalLineId: lineId },
      data: { ExtraStatus: "Completed" },
    });

    const actor = await prisma.user.findUnique({
      where: { id: actorId },
      select: { name: true, lastname: true, nickname: true },
    });
    const fmtName = (u: {
      name?: string | null;
      lastname?: string | null;
      nickname?: string | null;
    }) => {
      const base = [u.name, u.lastname].filter(Boolean).join(" ").trim();
      return u.nickname ? `${base} (${u.nickname})` : base || (u.name ?? "");
    };
    const actorName = fmtName(actor ?? {});

    await prisma.memoHistory.create({
      data: {
        memoId,
        userId: actorId,
        statusId: approvedId,
        action: `Extra Approval: Approved by ${actorName}`,
        actiontype: ActionType.APPROVE,
        timestamp: new Date(),
      },
    });

    setImmediate(() => {
      notifyStatusUpdate(memoId, actorId, actorName, 5, null).catch((err) =>
        console.error("notifyStatusUpdate extra approve error", err),
      );
    });
  }

  res.json({ ok: true, closed: allApproved ? "approved" : null });
};

// ─── GET /api/memos/:id/extra-approval-lines/active ───────────────────────
export const getActiveExtraApprovalLine: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);

  let line = await prisma.extraApprovalLine.findFirst({
    where: {
      memoId,
      status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] },
    },
    orderBy: { id: "desc" },
    include: {
      comment: {
        select: {
          id: true,
          comment: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              name: true,
              lastname: true,
              nickname: true,
            },
          },
        },
      },
    },
  });

  // ถ้าไม่เจอ active ให้คืนล่าสุด (COMPLETED/REJECTED)
  if (!line) {
    line = await prisma.extraApprovalLine.findFirst({
      where: { memoId },
      orderBy: { id: "desc" },
      include: {
        comment: {
          select: {
            id: true,
            comment: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
              },
            },
          },
        },
      },
    });
    if (!line) {
      res.json(null);
      return;
    }
  }

  const approvers = await prisma.extraApprover.findMany({
    where: { extraId: line.id },
    orderBy: [{ actedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      actedAt: true,
      statusId: true,
      status: { select: { id: true, name: true } },
      user: {
        select: {
          id: true,
          name: true,
          lastname: true,
          nickname: true,
          profileImagePath: true,
        },
      },
    },
  });

  res.json({
    id: line.id,
    status: line.status,
    createdAt: line.createdAt,
    comments: line.comment,
    approvers,
  });
};

// ─── POST /api/memos/extra-approval-lines/active/bulk ──────────────────────
export const getActiveExtraApprovalLinesBulk: RequestHandler = async (
  req,
  res,
) => {
  const currentUserId = (req as any).user?.id;
  if (!currentUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const raw = (req.body?.memoIds ?? []) as unknown[];
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: "memoIds must be an array" });
    return;
  }

  const memoIds = Array.from(
    new Set(
      raw
        .map((v) => Number(v))
        .filter((v): v is number => Number.isInteger(v) && v > 0),
    ),
  );

  if (memoIds.length === 0) {
    res.json({});
    return;
  }
  if (memoIds.length > 5000) {
    res.status(400).json({ error: "Too many memoIds (max 5000)" });
    return;
  }

  try {
    // Visibility filter — mirrors getAllMemos
    const visibleMemos = await prisma.masterMemo.findMany({
      where: {
        id: { in: memoIds },
        OR: [
          { userId: currentUserId },
          { approverActions: { some: { loaUser: { userId: currentUserId } } } },
          { ccRecipients: { some: { userId: currentUserId } } },
          {
            extraApprovalLines: {
              some: { approvers: { some: { userId: currentUserId } } },
            },
          },
          { commentTags: { some: { userId: currentUserId } } },
        ],
      },
      select: {
        id: true,
        userId: true,
        statuses: {
          include: { status: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const allowedIds = visibleMemos
      .filter((m) => {
        const latest = m.statuses?.[0]?.status?.name ?? "";
        if (latest === "Deleted") return false;
        if (latest === "Draft" && m.userId !== currentUserId) return false;
        return true;
      })
      .map((m) => m.id);

    if (allowedIds.length === 0) {
      res.json({});
      return;
    }

    const lines = await prisma.extraApprovalLine.findMany({
      where: { memoId: { in: allowedIds } },
      orderBy: { id: "desc" },
      select: { id: true, memoId: true, status: true, createdAt: true },
    });

    type Line = (typeof lines)[number];
    const latestActiveByMemo = new Map<number, Line>();
    const latestAnyByMemo = new Map<number, Line>();

    for (const ln of lines) {
      if (!latestAnyByMemo.has(ln.memoId)) {
        latestAnyByMemo.set(ln.memoId, ln);
      }
      if (
        !latestActiveByMemo.has(ln.memoId) &&
        (ln.status === ExtraStatus.PENDING ||
          ln.status === ExtraStatus.IN_PROGRESS)
      ) {
        latestActiveByMemo.set(ln.memoId, ln);
      }
    }

    const chosenByMemo = new Map<number, Line>();
    for (const id of allowedIds) {
      const active = latestActiveByMemo.get(id);
      const any = latestAnyByMemo.get(id);
      const picked = active ?? any;
      if (picked) chosenByMemo.set(id, picked);
    }

    const chosenLineIds = Array.from(chosenByMemo.values()).map((ln) => ln.id);

    const approvers = chosenLineIds.length
      ? await prisma.extraApprover.findMany({
          where: { extraId: { in: chosenLineIds } },
          orderBy: [{ extraId: "asc" }, { actedAt: "desc" }, { id: "asc" }],
          select: {
            id: true,
            extraId: true,
            actedAt: true,
            statusId: true,
            status: { select: { id: true, name: true } },
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
                profileImagePath: true,
              },
            },
          },
        })
      : [];

    type ApproverRow = (typeof approvers)[number];
    const approversByLine = new Map<number, ApproverRow[]>();
    for (const a of approvers) {
      const arr = approversByLine.get(a.extraId);
      if (arr) arr.push(a);
      else approversByLine.set(a.extraId, [a]);
    }

    const result: Record<number, any> = {};
    for (const id of allowedIds) {
      const chosen = chosenByMemo.get(id);
      if (!chosen) {
        result[id] = null;
        continue;
      }
      const rows = (approversByLine.get(chosen.id) ?? []).map((a) => ({
        id: a.id,
        actedAt: a.actedAt,
        statusId: a.statusId,
        status: a.status,
        user: a.user,
      }));
      result[id] = {
        id: chosen.id,
        status: chosen.status,
        createdAt: chosen.createdAt,
        approvers: rows,
      };
    }

    res.json(result);
  } catch (err) {
    console.error("[getActiveExtraApprovalLinesBulk] failed:", err);
    res
      .status(500)
      .json({ error: "Failed to fetch extra-approval-lines (bulk)" });
  }
};

// ─── GET /api/memos/:id/extra-approval-lines ──────────────────────────────
export const listExtraApprovalLines: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const lines = await prisma.extraApprovalLine.findMany({
    where: { memoId },
    orderBy: { id: "desc" },
    select: {
      id: true,
      memoId: true,
      createdById: true,
      createdAt: true,
      closedAt: true,
      status: true,
      commentId: true,
      approvers: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          actedAt: true,
          statusId: true,
          status: { select: { id: true, name: true } },
          user: {
            select: {
              id: true,
              name: true,
              lastname: true,
              nickname: true,
              profileImagePath: true,
            },
          },
        },
      },
      comment: {
        select: {
          id: true,
          comment: true,
          createdAt: true,
          user: {
            select: {
              id: true,
              name: true,
              lastname: true,
              nickname: true,
            },
          },
        },
      },
    },
  });
  res.json(lines);
};

// ─── DELETE /api/memos/:memoId/extra-approval-lines/:lineId ───────────────
export const removeExtraApprovalLine: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.memoId);
  const lineId = Number(req.params.lineId);
  const actorId = req.user!.id;

  if (isNaN(memoId) || isNaN(lineId)) {
    res.status(400).json({ error: "Invalid memoId or lineId" });
    return;
  }

  const line = await prisma.extraApprovalLine.findFirst({
    where: { id: lineId, memoId },
    select: {
      id: true,
      status: true,
      createdById: true,
      commentId: true,
      memo: { select: { subject: true, memonumber: true, userId: true } },
      approvers: { select: { userId: true } },
    },
  });

  if (!line) {
    res.status(404).json({ error: "Extra approval line not found" });
    return;
  }

  if (line.createdById !== actorId) {
    res
      .status(403)
      .json({ error: "Only the creator can remove this approval line" });
    return;
  }

  if (line.status !== "PENDING") {
    res
      .status(409)
      .json({ error: "Only PENDING approval lines can be removed" });
    return;
  }

  const actor = await prisma.user.findUnique({
    where: { id: actorId },
    select: { name: true, lastname: true, nickname: true },
  });

  const fmtNameLocal = (u: any) => {
    const base = [u?.name, u?.lastname].filter(Boolean).join(" ").trim();
    return u?.nickname ? `${base} (${u.nickname})` : base || `User #${actorId}`;
  };
  const actorLabel = fmtNameLocal(actor);

  const extraApproverIds = line.approvers
    .map((a) => a.userId)
    .filter((id): id is number => id !== null);
  const extraApproverSet = new Set(extraApproverIds);
  extraApproverSet.delete(actorId);

  const ownerId = line.memo.userId;
  const ownerSet = new Set<number>();
  if (ownerId && ownerId !== actorId && !extraApproverSet.has(ownerId)) {
    ownerSet.add(ownerId);
  }

  const extraApproverUsers = await prisma.user.findMany({
    where: { id: { in: Array.from(extraApproverSet) } },
    select: { name: true, lastname: true, nickname: true },
  });
  const extraNames = extraApproverUsers.map(fmtNameLocal);
  const subj = line.memo.subject ?? String(memoId);

  const buildNoti = (uid: number, message: string) => ({
    memoId,
    userId: uid,
    actorId,
    notificationTypeId: 2,
    message,
  });

  const notis: any[] = [];
  const notificationSlug = "remove-extra-approval";
  const extraArr = Array.from(extraApproverSet);
  const ownerArr = Array.from(ownerSet);

  const filteredExtraIds = await filterUsersForEmail(
    extraArr,
    notificationSlug,
  );
  const notifyExtraSet = new Set(filteredExtraIds);

  const filteredOwnerIds = await filterUsersForEmail(
    ownerArr,
    notificationSlug,
  );
  const notifyOwnerSet = new Set(filteredOwnerIds);

  for (const uid of extraApproverSet) {
    if (notifyExtraSet.has(uid)) {
      notis.push(
        buildNoti(
          uid,
          `${actorLabel} removed your extra approval line from "${subj}".`,
        ),
      );
    }
  }
  for (const uid of ownerSet) {
    if (notifyOwnerSet.has(uid)) {
      notis.push(
        buildNoti(
          uid,
          `${actorLabel} removed an extra approval line (${extraNames.join(", ")}) from "${subj}".`,
        ),
      );
    }
  }
  if (notis.length) await prisma.notification.createMany({ data: notis });

  const memoNumber = line.memo.memonumber ?? memoId;
  const extraList = Array.from(extraApproverSet);
  if (extraList.length) {
    await sendDeleteExtraApprovalEmailsAsync({
      receiverIds: extraList,
      memoSubject: subj,
      memoNumber,
      memoId,
      actorName: actorLabel,
      deletedNames: extraNames,
      isOwner: false,
    });
  }
  if (ownerSet.size) {
    await sendDeleteExtraApprovalEmailsAsync({
      receiverIds: Array.from(ownerSet),
      memoSubject: subj,
      memoNumber,
      memoId,
      actorName: actorLabel,
      deletedNames: extraNames,
      isOwner: true,
    });
  }

  if (line.commentId) {
    await prisma.comment
      .delete({ where: { id: line.commentId } })
      .catch(() => {});
  }

  await prisma.extraApprovalLine.delete({ where: { id: lineId } });

  try {
    await prisma.memoHistory.create({
      data: {
        memoId,
        userId: actorId,
        action: `Extra approval line #${lineId} removed by ${actorLabel}`,
        actiontype: ActionType.UPDATE,
        timestamp: new Date(),
      },
    });
  } catch {
    // Non-critical — do not fail the request
  }

  res.sendStatus(204);
};
