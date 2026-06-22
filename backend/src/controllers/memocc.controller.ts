// src/controllers/memocc.controller.ts
import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { AuthenticatedRequest } from "../types/request";
import type { Prisma } from "@prisma/client";
/* ───────────────── helpers ───────────────── */
const isAdmin = (req: AuthenticatedRequest) => {
  const r = (req.user?.role ?? "").toString().toUpperCase();
  const roles = (req.user as any)?.roles ?? [];
  return (
    r === "ADMIN" ||
    roles.map((x: string) => x?.toUpperCase?.()).includes("ADMIN")
  );
};

async function ensureMemoExists(memoId: number) {
  const memo = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { id: true, userId: true },
  });
  if (!memo) {
    const e = new Error("Memo not found");
    (e as any).name = "NotFoundError";
    (e as any).status = 404;
    throw e;
  }
  return memo;
}

function canManageCc(req: AuthenticatedRequest, memoOwnerId: number) {
  // เจ้าของเอกสารหรือแอดมินเท่านั้นที่แก้ CC ได้
  return isAdmin(req) || req.user!.id === memoOwnerId;
}

/* ───────────────── controllers ───────────────── */

// GET /api/memos/:id/cc  → รายชื่อ CC (users เท่านั้น)
export const listCc: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  if (!Number.isFinite(memoId) || memoId <= 0) {
    res.status(400).json({ error: "Invalid memo ID" });
    return;
  }

  try {
    await ensureMemoExists(memoId);

    const ccUsers = await prisma.memoCc.findMany({
      where: { memoId },
      orderBy: { createdAt: "asc" },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            lastname: true,
            nickname: true,
            email: true,
            profileImagePath: true,
          },
        },
      },
    });

    const users = ccUsers.map((r) => ({
      id: r.user.id,
      name: r.user.name,
      lastname: r.user.lastname ?? null,
      nickname: r.user.nickname ?? null,
      email: r.user.email,
      profileImagePath: r.user.profileImagePath ?? null,
      addedAt: r.createdAt,
    }));

    // ให้ frontend เดิมไม่พัง: groups/groupIds เป็น array ว่าง
    res.json({ users, groups: [], groupIds: [] });
  } catch (e: any) {
    if (e?.name === "NotFoundError" || e?.status === 404) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
};


// PUT /api/memos/:id/cc  { userIds:number[], groupIds:number[] }
// PUT /api/memos/:id/cc  { userIds:number[], groupIds:number[] }
export const replaceCc: RequestHandler = async (req: AuthenticatedRequest, res) => {
  const memoId = Number(req.params.id);
  if (!Number.isFinite(memoId) || memoId <= 0) {
    res.status(400).json({ error: "Invalid memo ID" });
    return;
  }

  const rawUserIds: number[] = Array.isArray(req.body.userIds) ? req.body.userIds.map(Number) : [];
  const rawGroupIds: number[] = Array.isArray(req.body.groupIds) ? req.body.groupIds.map(Number) : [];

  const memo = await ensureMemoExists(memoId);
  if (!canManageCc(req, memo.userId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  // ── 0) ดึงรายชื่อผู้อนุมัติทั้งหมดของเมโมนี้ เพื่อนำไป "ตัดออกจาก CC"
  const actions = await prisma.memoApproverAction.findMany({
    where: { memoId },
    select: { assignedUserId: true, loaUserId: true },
  });

  // บางแอ็กชันอาจไม่มี assignedUserId → fallback ไปดู pivot.userId
  const missingLoaIds = actions.filter(a => a.assignedUserId == null).map(a => a.loaUserId);
  let fallbackPivotUsers: number[] = [];
  if (missingLoaIds.length) {
    const pivots = await prisma.lineOfApprovalUserPivot.findMany({
      where: { id: { in: missingLoaIds } },
      select: { userId: true },
    });
    fallbackPivotUsers = pivots.map(p => p.userId).filter((n): n is number => Number.isFinite(n));
  }

  const approverSet = new Set<number>([
    ...actions
      .map(a => a.assignedUserId)
      .filter((n): n is number => Number.isFinite(n as number)),
    ...fallbackPivotUsers,
  ]);

  // ── 1) ขยาย groupIds → userIds (จำกัดสิทธิ์: กลุ่มของเรา หรือกลุ่มแชร์)
  let groupMemberIds: number[] = [];
  if (rawGroupIds.length) {
const members = await prisma.ccGroupMember.findMany({
  where: { groupId: { in: rawGroupIds } },
  select: { userId: true },
});
    groupMemberIds = members.map(m => m.userId);
  }

  // ── 2) รวม + กันซ้ำ + ตัด owner และ approvers ออกเสมอ
  const newUserSet = new Set<number>(
    [...rawUserIds, ...groupMemberIds].filter(
      (u) => Number.isFinite(u) && u > 0 && u !== memo.userId && !approverSet.has(u)
    )
  );

  // ── 3) diff กับของเดิม
  const existingUsers = await prisma.memoCc.findMany({ where: { memoId }, select: { userId: true } });
  const oldUserSet = new Set(existingUsers.map(e => e.userId));

  const usersToAdd = [...newUserSet].filter(u => !oldUserSet.has(u));
  const usersToDel = [...oldUserSet].filter(u => !newUserSet.has(u));

  // ── 4) apply changes
  await prisma.$transaction(async (tx) => {
    if (usersToDel.length) {
      await tx.memoCc.deleteMany({ where: { memoId, userId: { in: usersToDel } } });
    }
    if (usersToAdd.length) {
      await tx.memoCc.createMany({
        data: usersToAdd.map(u => ({ memoId, userId: u })),
        skipDuplicates: true,
      });
    }
  });

  res.json({
    memoId,
    added: { users: usersToAdd },
    removed: { users: usersToDel },
    final: { userIds: [...newUserSet] },
  });
};




// POST /api/memos/:id/cc/:userId  → เพิ่ม CC 1 คน
export const addCcOne: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  const memoId = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (Number.isNaN(memoId) || Number.isNaN(userId)) {
    res.status(400).json({ error: "Invalid memoId or userId" });
    return;
  }

  const memo = await ensureMemoExists(memoId);
  if (!canManageCc(req, memo.userId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  if (userId === memo.userId) {
  res.status(400).json({ error: "Owner cannot be CC" });
  return;
}

const isApprover = await prisma.memoApproverAction.findFirst({
  where: { memoId, assignedUserId: userId },
  select: { id: true },
});
if (isApprover) {
  res.status(400).json({ error: "Approver cannot be CC" });
  return;
}
  if (userId === memo.userId) {
    res.status(400).json({ error: "Owner cannot be CC" });
    return;
  }

  try {
    await prisma.memoCc.create({ data: { memoId, userId } });
    res.status(201).json({ ok: true });
  } catch (e:any) {
  if (String(e?.code) === "P2002") {
    res.status(409).json({ error: "Already CC" });
  } else {
    console.error(e);
    res.status(500).json({ error: "Failed to add CC" });
  }
  return; // ✅
}
};

// DELETE /api/memos/:id/cc/:userId  → ลบ CC 1 คน
export const removeCcOne: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  const memoId = Number(req.params.id);
  const userId = Number(req.params.userId);
  if (Number.isNaN(memoId) || Number.isNaN(userId)) {
    res.status(400).json({ error: "Invalid memoId or userId" });
    return;
  }

  const memo = await ensureMemoExists(memoId);
  if (!canManageCc(req, memo.userId)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  await prisma.memoCc.delete({ where: { memoId_userId: { memoId, userId } } });
  res.json({ ok: true });
};

// GET /api/memos/cc/me  → รายการเมโมที่ฉันถูก CC
export const listMemosCcToMe: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  const me = req.user!.id;

  const memos = await prisma.masterMemo.findMany({
    where: { ccRecipients: { some: { userId: me } } },
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { id: true, name: true, lastname: true, nickname: true } }, // owner
      memoType: { select: { id: true, name: true } },
      statuses: {
        include: { status: true },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  // (option) ซ่อน Draft ที่เราไม่ใช่เจ้าของ
  const result = memos
    .filter((m) => (m.statuses[0]?.status?.name ?? "") !== "Draft")
    .map((m) => ({
      id: m.id,
      subject: m.subject,
      memonumber: m.memonumber,
      owner: m.user,
      type: m.memoType?.name,
      latestStatus: m.statuses[0]?.status?.name ?? "Processing",
      latestStatusAt: m.statuses[0]?.createdAt ?? null,
    }));

  res.json(result);
};
