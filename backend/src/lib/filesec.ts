// src/lib/filesec.ts
import type { Request } from "express";
import { ExtraStatus, type PrismaClient } from "@prisma/client";

export function getUserId(req: Request): number {
  const u = (req as any)?.user;
  if (!u || typeof u.id !== "number") {
    const err = new Error("Unauthenticated");
    (err as any).status = 401;
    throw err;
  }
  return u.id;
}

// ปรับให้ตรงกับฐานของคุณ ถ้า statusId ที่แทน Draft ไม่ใช่ 1 ให้แก้ตรงนี้
const DRAFT_STATUS_IDS = [1];

async function isMemoDraft(
  prisma: PrismaClient,
  memoId: number
): Promise<boolean> {
  const last = await prisma.memoStatusPivot.findFirst({
    where: { memoId },
    orderBy: { createdAt: "desc" },
    select: { statusId: true },
  });
  // ถ้ายังไม่เคยบันทึกสถานะ ให้ถือว่า Draft
  return !last || DRAFT_STATUS_IDS.includes(last.statusId);
}

export async function canAccessMemo(
  prisma: PrismaClient,
  userId: number,
  memoId: number
): Promise<boolean> {
  // role
  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  const isAdmin = !!me && ["admin", "superadmin", "system"].includes(me.role);

  // ข้อมูล memo ขั้นต่ำ
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { userId: true, approvalLineId: true },
  });
  if (!memo) return false;

  // ⛔ Draft → อนุญาตเฉพาะเจ้าของ (และ admin)
  if (await isMemoDraft(prisma, memoId)) {
    return memo.userId === userId || isAdmin;
  }

  // ✅ non-draft: เงื่อนไขปกติ
  if (isAdmin) return true;
  if (memo.userId === userId) return true;

  // CC
  const isCc = await prisma.memoCc.findFirst({
    where: { memoId, userId },
    select: { id: true },
  });
  if (isCc) return true;

  // อยู่ใน LOA
  if (memo.approvalLineId) {
    const isInLoa = await prisma.lineOfApprovalUserPivot.findFirst({
      where: { lineOfApprovalId: memo.approvalLineId, userId },
      select: { id: true },
    });
    if (isInLoa) return true;
  }

  // เคยมี ApproverAction
  const hasAction = await prisma.memoApproverAction.findFirst({
    where: { memoId, loaUser: { userId } },
    select: { id: true },
  });
  if (hasAction) return true;

  // Extra line (เฉพาะ non-draft เท่านั้น)
  const isExtra = await prisma.extraApprover.findFirst({
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

  const isMentioned = await prisma.commentTag.findFirst({
    where: { memoId, userId },
    select: { id: true },
  });
  if (isMentioned) return true;

  return false;
}
