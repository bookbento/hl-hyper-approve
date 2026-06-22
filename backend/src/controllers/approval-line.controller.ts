import { RequestHandler, Response } from "express";
import { prisma } from "../../prisma/client";
import { AuthenticatedRequest } from "../types/request";
import { getRecallType } from "./memoStatus.controller";
import { createAdminLog } from "./adminLog.controller";
// สร้าง approval line

// --- add this at top, ก่อน export ฟังก์ชันใด ๆ ---
type ApprovalUserRow = {
  level: number;
  isSigReq: boolean;
  user: { id: number; name: string };
};

// GET /api/teams - Returns all departments (teams) with businessUnit for admin dropdown
export const getAllTeams: RequestHandler = async (_req, res) => {
  try {
    const departments = await prisma.department.findMany({
      where: { deletedAt: null }, // <- Exclude archived departments
      select: {
        id: true,
        name: true,
        abbreviation: true,
        businessUnitId: true,
        businessUnit: {
          select: {
            id: true,
            name: true,
          },
        },
      },
      orderBy: { name: "asc" },
    });
    res.json(departments);
  } catch (error) {
    console.error("Failed to fetch teams:", error);
    res.status(500).json({ error: "Failed to fetch teams" });
  }
};

// Helper function to filter out null users (flexible slots that couldn't be resolved)
function filterValidUsers(
  rows: Array<{
    level: number;
    isSigReq: boolean;
    user: { id: number; name: string } | null;
  }>
): ApprovalUserRow[] {
  return rows.filter((row): row is ApprovalUserRow => row.user !== null);
}

function formatLevels(rows: ApprovalUserRow[]) {
  const grouped: Record<
    number,
    { role: string; users: { id: number; name: string; isSigReq: boolean }[] }
  > = {};
  rows.forEach((p) => {
    if (!grouped[p.level]) {
      grouped[p.level] = { role: `Level ${p.level + 1}`, users: [] };
    }
    grouped[p.level].users.push({
      id: p.user.id,
      name: p.user.name,
      isSigReq: p.isSigReq,
    });
  });
  return Object.keys(grouped)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((lvl) => grouped[lvl]);
}
function hasRole(user: any, target: string) {
  const primary = (user?.role ?? "").toUpperCase();
  if (primary === target) return true;
  const roles = (user?.roles ?? []).map((r: string) => (r ?? "").toUpperCase());
  return roles.includes(target);
}
function isAdminOrDcc(user: any) {
  return hasRole(user, "ADMIN") || hasRole(user, "DCC");
}
// ⬅️ ปิด formatLevels

export const createApprovalLine: RequestHandler = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const { name, levels } = req.body;
  const userId = req.user?.id;

  if (!name || !levels || !userId) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  try {
    const newLine = await prisma.lineOfApproval.create({
      data: {
        name,
        userId,
        businessUnitId: req.user?.businessUnitId || null,
        approvalUsers: {
          create: levels.flatMap((lv: any, idx: number) =>
            lv.users.map((u: any) => ({
              userId: typeof u === "number" ? u : u.id,
              level: idx,
              isSigReq: typeof u === "number" ? false : !!u.isSigReq,
              slotType: u.slotType || "FIXED_USER",
              roleDescription: u.roleDescription || null,
              approvalRequirement: u.approvalRequirement || "ALL",
            }))
          ),
        },
      },
      select: {
        id: true,
        name: true,
        approvalUsers: {
          orderBy: { level: "asc" },
          select: {
            level: true,
            isSigReq: true,
            slotType: true,
            roleDescription: true,
            approvalRequirement: true,
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
          },
        },
      },
    });

    // Log the action
    await createAdminLog(
      userId,
      "LOA_CREATE",
      "APPROVAL_LINE",
      newLine.id,
      newLine.name,
      { levelsCount: levels.length }
    );

    res.json({
      id: newLine.id,
      name: newLine.name,
      levels: formatLevels(filterValidUsers(newLine.approvalUsers)),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create approval line" });
  }
};

// controllers/approvalLine.controller.ts
//--------------------------------------------------
// controllers/approvalLine.controller.ts
export const updateApprovalLine: RequestHandler = async (req, res) => {
  const lineId = Number(req.params.id);
  if (Number.isNaN(lineId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const { name, levels } = req.body as {
    name?: string;
    levels?: any[];
  };

  if (!Array.isArray(levels)) {
    res.status(400).json({ error: "levels must be an array" });
    return;
  }

  type Wanted = { 
    userId: number; 
    level: number; 
    isSigReq: boolean; 
    slotType?: string;
    roleDescription?: string;
    approvalRequirement?: string;
  };

  // ✅ validate levels + กัน user ซ้ำ
  const wantedRaw: Wanted[] = levels.flatMap((lv: any, idx: number) => {
    if (!Array.isArray(lv?.users)) throw new Error("INVALID_LEVELS");
    return lv.users.map((u: any) => ({
      userId: typeof u === "number" ? u : Number(u?.id),
      level: idx,
      isSigReq: typeof u === "number" ? false : !!u?.isSigReq,
      slotType: u?.slotType || "FIXED_USER",
      roleDescription: u?.roleDescription || null,
      approvalRequirement: u?.approvalRequirement || "ALL",
    }));
  });
  if (wantedRaw.some((w) => !Number.isFinite(w.userId))) {
    res.status(400).json({ error: "Invalid userId in levels" });
    return;
  }
  // Allow same user at different levels - only check for exact duplicates (same user + same level)
  const seen = new Set<string>();
  for (const w of wantedRaw) {
    const key = `${w.userId}-${w.level}`;
    if (seen.has(key)) {
      res.status(400).json({ error: "Duplicate user at the same level" });
      return;
    }
    seen.add(key);
  }
  const wanted = wantedRaw;

  try {
    await prisma.$transaction(async (tx) => {
      const existing = await tx.lineOfApproval.findUnique({
        where: { id: lineId },
        select: { id: true },
      });
      if (!existing) throw new Error("NOT_FOUND");

      const dataUpdate: any = {};
      if (typeof name === "string" && name.trim())
        dataUpdate.name = name.trim();

      if (Object.keys(dataUpdate).length) {
        await tx.lineOfApproval.update({
          where: { id: lineId },
          data: dataUpdate,
        });
      }

      // Since same user can now appear at multiple levels, use delete-and-recreate approach
      // This is simpler and more reliable than trying to diff with composite keys
      await tx.lineOfApprovalUserPivot.deleteMany({
        where: { lineOfApprovalId: lineId },
      });

      if (wanted.length) {
        await tx.lineOfApprovalUserPivot.createMany({
          data: wanted.map((w) => ({
            lineOfApprovalId: lineId,
            userId: w.userId,
            level: w.level,
            isSigReq: w.isSigReq,
            slotType: w.slotType as any,
            roleDescription: w.roleDescription,
            approvalRequirement: w.approvalRequirement as any,
          })),
        });
      }
    });

    const updated = await prisma.lineOfApproval.findUnique({
      where: { id: lineId },
      select: {
        id: true,
        name: true,
        approvalUsers: {
          orderBy: { level: "asc" },
          select: {
            level: true,
            isSigReq: true,
            slotType: true,
            roleDescription: true,
            approvalRequirement: true,
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
          },
        },
      },
    });
    if (!updated) {
      res.status(404).json({ error: "Approval line not found" });
      return;
    }

    // Log the action
    await createAdminLog(
      req.user!.id,
      "LOA_UPDATE",
      "APPROVAL_LINE",
      updated.id,
      updated.name,
      {
        nameChanged: !!(name && name.trim()),
        levelsCount: updated.approvalUsers.filter(u => u.user).length
      }
    );

    res.json({
      id: updated.id,
      name: updated.name,
      levels: formatLevels(filterValidUsers(updated.approvalUsers)),
    });
  } catch (err: any) {
    if (err?.message === "FORBIDDEN_MOVE_TEAM") {
      res
        .status(403)
        .json({ error: "Only admin can move approval line to another team" });
      return;
    }
    if (err?.message === "INVALID_TEAM") {
      res.status(400).json({ error: "Invalid teamId" });
      return;
    }
    if (err?.message === "NOT_FOUND") {
      res.status(404).json({ error: "Approval line not found" });
      return;
    }
    if (err?.message === "INVALID_LEVELS") {
      res.status(400).json({ error: "Invalid levels structure" });
      return;
    }
    console.error(err);
    res.status(500).json({ error: "Update failed" });
  }
};

export const deleteApprovalLine: RequestHandler = async (req, res) => {
  const lineId = +req.params.id;

  try {
    // ตัดการอ้างอิงจาก memo ก่อน
    await prisma.masterMemo.updateMany({
      where: { approvalLineId: lineId },
      data: { approvalLineId: null },
    });

    // ลบ pivots ของ line นี้ก่อน กัน FK
    await prisma.lineOfApprovalUserPivot.deleteMany({
      where: { lineOfApprovalId: lineId },
    });

    // แล้วค่อยลบ line
    const deletedLine = await prisma.lineOfApproval.delete({ where: { id: lineId } });

    // Log the action
    await createAdminLog(
      req.user!.id,
      "LOA_DELETE",
      "APPROVAL_LINE",
      lineId,
      deletedLine.name,
      {}
    );

    res.sendStatus(204);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Delete failed" });
  }
};

// GET /api/memos/:id/approvers
export const getApprovers: RequestHandler = async (req, res, next) => {
  try {
    const memoId = Number(req.params.id);
    if (Number.isNaN(memoId)) {
      res.status(400).json({ error: "Invalid memo ID" });
      return;
    }

    const memo = await prisma.masterMemo.findUnique({
      where: { id: memoId },
    });
    if (!memo) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }

    const line = await prisma.lineOfApproval.findFirst({
      orderBy: { id: "desc" },
      include: {
        approvalUsers: {
          select: {
            level: true,
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
          },
          orderBy: { level: "asc" },
        },
      },
    });

    if (!line) {
      res.json([]);
      return;
    }

    const approvers = line.approvalUsers
      .filter((p) => p.user !== null)
      .map((p) => ({
        id: p.user!.id,
        name: p.user!.name,
        level: p.level,
      }));

    res.json(approvers);
    return;
  } catch (err) {
    next(err);
  }
};

// controllers/approval-line.controller.ts
// ---------- 2) ใส่ name กลับด้วย ----------
export const getApprovalLineByMemo: RequestHandler = async (req, res, next) => {
  try {
    const memoId = Number(req.params.id);
    console.log(`[getApprovalLineByMemo] ========== START ========== memoId=${memoId}`);
    
    if (isNaN(memoId)) {
      res.status(400).json({ error: "Invalid memo ID" });
      return;
    }

    const latestStatus = await prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: "desc" },
      select: { statusId: true },
    });
    const recallType = await getRecallType(memoId);

    if (latestStatus?.statusId === 1 && recallType === "clear") {
      console.log(`[getApprovalLineByMemo] Memo recalled with clear, returning empty levels`);
      res.json({ memoId, name: "Current", levels: [] });
      return;
    }

    const rows = await prisma.memoApproverAction.findMany({
      where: { memoId },
      orderBy: [{ loaUserId: "asc" }, { version: "desc" }],
      distinct: ["loaUserId"],
      select: {
        loaUserId: true,
        memoId: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        actedAt: true,
        approveWithCondition: true,
        rejectReason: true,
        terminationReason: true,
        status: { select: { code: true } },
        loaUser: {
          select: {
            id: true,
            level: true,
            isSigReq: true,
            slotType: true,
            roleDescription: true,
            approvalRequirement: true,
            templatePivotId: true,
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
          },
        },
      },
    });

    console.log(`[getApprovalLineByMemo] Found ${rows.length} approval actions`);

    // First pass: Group by level and check if ANY requirement is met
    const levelApprovalStatus = new Map<number, { 
      hasApproval: boolean; 
      requirement: string;
      approvedBy?: string;
    }>();
    
    rows.forEach((r) => {
      const lvl = r.loaUser.level;
      const requirement = r.loaUser.approvalRequirement || "ALL";
      
      if (!levelApprovalStatus.has(lvl)) {
        levelApprovalStatus.set(lvl, { 
          hasApproval: false, 
          requirement 
        });
      }
      
      if (r.status.code === "approved") {
        const levelStatus = levelApprovalStatus.get(lvl)!;
        levelStatus.hasApproval = true;
        const u = r.loaUser.user;
        if (u) {
          const fullName = [u.name, u.lastname].filter(Boolean).join(" ");
          const displayName = u.nickname ? `${fullName} (${u.nickname})` : fullName;
          levelStatus.approvedBy = displayName;
        }
      }
    });

    console.log(`[getApprovalLineByMemo] Level approval status:`, 
      JSON.stringify(Array.from(levelApprovalStatus.entries()).map(([level, status]) => ({
        level,
        requirement: status.requirement,
        hasApproval: status.hasApproval,
        approvedBy: status.approvedBy
      })), null, 2)
    );

    // Second pass: Build grouped data with not_required status
    const grouped: Record<number, any[]> = {};
    rows.forEach((r) => {
      const lvl = r.loaUser.level;
      const s = r.status.code; // 'waiting' | 'approved' | 'rejected' | 'terminated'
      const u = r.loaUser.user;

      // Skip if user is null (unresolved flexible slot)
      if (!u) return;

      // Check if this is a waiting approver in a satisfied ANY level
      const levelStatus = levelApprovalStatus.get(lvl);
      const isLevelSatisfied = levelStatus?.requirement === "ANY" && levelStatus?.hasApproval;
      const finalStatus = (s === "waiting" && isLevelSatisfied) ? "not_required" : s;

      console.log(`[getApprovalLineByMemo] User ${u.id} (${u.name}) at level ${lvl}: originalStatus=${s}, finalStatus=${finalStatus}, requirement=${levelStatus?.requirement}, hasApproval=${levelStatus?.hasApproval}`);

      (grouped[lvl] ??= []).push({
        loaUserPivotId: r.loaUser.id ?? r.loaUserId,
        level: lvl,
        status: finalStatus,
        isSigReq: r.loaUser.isSigReq,
        slotType: r.loaUser.slotType ?? null,
        roleDescription: r.loaUser.roleDescription ?? null,
        approvalRequirement: r.loaUser.approvalRequirement ?? "ALL",
        isLevelSatisfied: isLevelSatisfied || false,
        approvedBy: levelStatus?.approvedBy,
        approveWithCondition: r.approveWithCondition ?? null,
        rejectReason: r.rejectReason ?? null,
        terminateReason: r.terminationReason ?? null, // ⬅️ map terminationReason -> terminateReason

        // 👇👇 สำคัญ: ใส่เวลาให้ FE ใช้
        since: s === "waiting" ? r.createdAt.toISOString() : null,
        actedAt:
          s === "approved" || s === "rejected" || s === "terminated"
            ? (r.actedAt ?? r.updatedAt).toISOString()
            : null,

        // user (ทั้ง nested และ flat)
        user: {
          id: u.id,
          name: u.name,
          lastname: u.lastname ?? null,
          nickname: u.nickname ?? null,
        },
        id: u.id,
        name: u.name,
        lastname: u.lastname ?? null,
        nickname: u.nickname ?? null,
      });
    });

    const levels = Object.entries(grouped)
      .map(([lvl, users]) => ({ level: Number(lvl), users }))
      .sort((a, b) => a.level - b.level);

    console.log(`[getApprovalLineByMemo] Returning ${levels.length} levels with ${levels.reduce((sum, l) => sum + l.users.length, 0)} total users`);
    console.log(`[getApprovalLineByMemo] ========== END ==========`);

    res.json({ memoId, name: "Current", levels });
  } catch (err) {
    console.error("[getApprovalLineByMemo] ERROR:", err);
    next(err);
  }
};

// === NEW: รายการงานอนุมัติที่ "ฉัน" ต้องกด (รวม Main + Extra) ===
export const listMyApprovalRequests: RequestHandler = async (
  req,
  res,
  next
) => {
  try {
    const meId = req.user?.id;
    if (!meId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }

    // ครอบคลุมชื่อสถานะปลายทาง/ซ่อน (ไม่สนตัวพิมพ์)
    const HIDE = new Set(
      [
        "DRAFT",
        "RECALL",
        "RECALLED",
        "CANCEL",
        "CANCELLED",
        "APPROVED",
        "REJECTED",
        "TERMINATED",
        "TERMINATE",
      ].map((s) => s.toUpperCase())
    );
    const up = (s?: string | null) => (s ?? "").toUpperCase();

    /* =========================================
     * 1) MAIN — งานที่ "ฉัน" ต้องกด (ถึงคิวเท่านั้น)
     *    - รองรับทั้ง fixed slot (loaUser.userId=me)
     *      และ flexible slot (assignedUserId=me)
     * ========================================= */
    const mainRows = await prisma.memoApproverAction.findMany({
      where: {
        status: { code: { in: ["waiting", "WAITING"] } },
        OR: [
          { loaUser: { userId: meId } }, // fixed slot
          { assignedUserId: meId }, // flexible slot
        ],
      },
      orderBy: [{ memoId: "asc" }, { version: "desc" }],
      distinct: ["memoId"], // เอาเวอร์ชันล่าสุดของแต่ละ memo สำหรับ "แถวของฉัน"
      include: {
        memo: {
          select: {
            id: true,
            memonumber: true,
            subject: true,
            createdAt: true,
            expiresAt: true,
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
            statuses: {
              take: 1,
              orderBy: { createdAt: "desc" },
              select: { status: { select: { name: true } } },
            },
          },
        },
        loaUser: { select: { level: true } },
      },
    });

    // ซ่อนตามสถานะล่าสุดของ memo
    const mainVisibleStatus = mainRows.filter((r) => {
      const latestName = r.memo.statuses?.[0]?.status?.name ?? "DRAFT";
      return !HIDE.has(up(latestName));
    });

    // ====== คำนวณ "คิวถึง" ด้วย min(level) ที่ยัง waiting ในเวอร์ชันล่าสุดของแต่ละ memo ======
    const memoIds = Array.from(
      new Set(mainVisibleStatus.map((r) => r.memo.id))
    );

    // หา max version ต่อ memo (กันกรณีมีแถว waiting จากเวอร์ชันเก่า)
    const mainMaxVerArr = await prisma.memoApproverAction.groupBy({
      by: ["memoId"],
      where: { memoId: { in: memoIds } },
      _max: { version: true },
    });
    const maxVerByMemo = new Map<number, number>(
      mainMaxVerArr.map((x) => [x.memoId, x._max.version ?? 0])
    );

    // ดึงทุกแถว waiting ของเมโมเหล่านี้ (ทุกคนทุกเลเวล ทุกผู้ใช้)
    const waitingAll = await prisma.memoApproverAction.findMany({
      where: {
        memoId: { in: memoIds },
        status: { code: { in: ["waiting", "WAITING"] } },
      },
      select: {
        memoId: true,
        version: true,
        loaUser: { select: { level: true } },
      },
    });

    // ตัดให้เหลือเฉพาะเวอร์ชันล่าสุดต่อ memo
    const waitingLatest = waitingAll.filter(
      (w) => w.version === (maxVerByMemo.get(w.memoId) ?? w.version)
    );

    // memoId -> min(level) ที่ยัง waiting
    const minWaitingByMemo = new Map<number, number>();
    for (const w of waitingLatest) {
      const cur = minWaitingByMemo.get(w.memoId);
      const lvl = w.loaUser.level;
      if (cur == null || lvl < cur) minWaitingByMemo.set(w.memoId, lvl);
    }

    // เก็บเฉพาะ "แถวของฉัน" ที่อยู่ในคิวต่ำสุดของ memo นั้น ๆ
    const mainFiltered = mainVisibleStatus.filter((r) => {
      const minLvl = minWaitingByMemo.get(r.memo.id);
      if (minLvl == null) return true; // ถ้าคำนวณไม่ได้ ปล่อยผ่านเพื่อไม่พลาดงาน
      return r.loaUser.level === minLvl;
    });

    const mainItems = mainFiltered.map((r) => ({
      memoId: r.memo.id,
      memonumber: r.memo.memonumber ?? "", // เผื่อกรณียังใช้ field เดิมชั่วคราว
      subject: r.memo.subject,
      owner: {
        id: r.memo.user.id,
        name: r.memo.user.name,
        lastname: r.memo.user.lastname ?? null,
        nickname: r.memo.user.nickname ?? null,
      },
      requestedAt: r.createdAt.toISOString(),
      requestType: "main" as const,
      level: r.loaUser.level,
      expiresAt: r.memo.expiresAt ?? null,
    }));

    /* =========================================
     * 2) EXTRA — ของฉันที่ยังไม่กด และไลน์ยังเปิดอยู่
     *    - สคีมา ExtraApprover ไม่มี level → แสดงแบบขนาน
     *      (ซ่อนตามสถานะเมโมเหมือนเดิม)
     * ========================================= */
    const extraRows = await prisma.extraApprover.findMany({
      where: {
        userId: meId,
        actedAt: null,
        extra: { status: { in: ["PENDING", "IN_PROGRESS"] } },
      },
      orderBy: [{ extraId: "asc" }, { version: "desc" }],
      distinct: ["extraId"],
      include: {
        extra: {
          select: {
            id: true,
            createdAt: true,
            memo: {
              select: {
                id: true,
                memonumber: true,
                subject: true,
                createdAt: true,
                expiresAt: true,
                user: {
                  select: {
                    id: true,
                    name: true,
                    lastname: true,
                    nickname: true,
                  },
                },
                statuses: {
                  take: 1,
                  orderBy: { createdAt: "desc" },
                  select: { status: { select: { name: true } } },
                },
              },
            },
          },
        },
      },
    });

    const extraFiltered = extraRows.filter((r) => {
      const latestName = r.extra.memo.statuses?.[0]?.status?.name ?? "DRAFT";
      return !HIDE.has(up(latestName));
    });

    const extraItems = extraFiltered.map((r) => ({
      memoId: r.extra.memo.id,
      memonumber: r.extra.memo.memonumber ?? "",
      subject: r.extra.memo.subject,
      owner: {
        id: r.extra.memo.user.id,
        name: r.extra.memo.user.name,
        lastname: r.extra.memo.user.lastname ?? null,
        nickname: r.extra.memo.user.nickname ?? null,
      },
      requestedAt: r.extra.createdAt.toISOString(),
      requestType: "extra" as const,
      extraId: r.extra.id,
      expiresAt: r.extra.memo.expiresAt ?? null,
    }));

    /* =========================================
     * รวม + เรียงใหม่ล่าสุดก่อน
     * ========================================= */
    const items = [...mainItems, ...extraItems].sort(
      (a, b) =>
        new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime()
    );

    res.json({ items });
  } catch (err) {
    next(err);
  }
};
