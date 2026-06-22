import { prisma } from "../../prisma/client";
export async function recordApproverAction(
  memoId: number,
  loaUserId: number,
  statusCode: "approved" | "rejected"
) {
  const newStatus = await prisma.approvalActionStatus.findUnique({
    where: { code: statusCode },
    select: { id: true },
  });
  if (!newStatus) throw new Error("Unknown statusCode");

  // หาสถานะ waiting
  const waitingStatus = await prisma.approvalActionStatus.findUnique({
    where: { code: "waiting" },
    select: { id: true },
  });
  if (!waitingStatus) throw new Error("ไม่มีสถานะ waiting");

  // ดึงบรรทัด waiting ของ user นี้ เวอร์ชันล่าสุด
  const action = await prisma.memoApproverAction.findFirst({
    where: {
      memoId,
      loaUserId,
      statusId: waitingStatus.id,
    },
    orderBy: { version: "desc" },
  });
  if (!action) throw new Error("ไม่มีแถว waiting ของ user นี้");

  // อัปเดตเป็น approved/rejected
  await prisma.memoApproverAction.update({
    where: { id: action.id },
    data: {
      statusId: newStatus.id,
      actedAt: new Date(),
    },
  });
}

export type PendingAction = {
  actionId: number; // PK ของ memoApproverAction
  userId: number;
  email: string;
  name: string;
  level: number; // <--- Added level
};

export async function getPendingActions(
  memoId: number,
  ver?: number
): Promise<PendingAction[]> {
  // 1) หาเวอร์ชันล่าสุด (ถ้าไม่ได้ระบุ ver)
  let targetVer = ver;
  if (targetVer === undefined) {
    const agg = await prisma.memoApproverAction.aggregate({
      where: { memoId },
      _max: { version: true },
    });
    targetVer = agg._max.version ?? 1;
  }

  // 2) หา waiting statusId
  const waiting = await prisma.approvalActionStatus.findUnique({
    where: { code: "waiting" },
    select: { id: true },
  });
  if (!waiting) throw new Error("ไม่มี waiting status");

  // 3) ดึงแถว memoApproverAction รอบนี้ พร้อม user.email & name
  const rows = await prisma.memoApproverAction.findMany({
    where: {
      memoId,
      version: targetVer,
      statusId: waiting.id,
    },
    include: {
      loaUser: {
        select: {
          userId: true,
          level: true, // <--- Select level
          user: { select: { email: true, name: true } },
        },
      },
    },
  });

  return rows
    .filter((r) => r.loaUser.userId !== null && r.loaUser.user !== null)
    .map((r) => ({
      actionId: r.id,
      userId: r.loaUser.userId!,
      email: r.loaUser.user!.email!,
      name: r.loaUser.user!.name,
      level: r.loaUser.level, // <--- Map level
    }));
}
