// src/controllers/approverAdmin.controller.ts
import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { AuthenticatedRequest } from "../types/request";
import { ApprovalSlotType, ApprovalRequirement } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { createAdminLog } from "./adminLog.controller";

/* ───────────────── helpers ───────────────── */

const hasRole = (user: any, target: string) => {
  const primary = (user?.role ?? "").toString().toUpperCase();
  if (primary === target) return true;
  return (user?.roles ?? []).some(
    (r: string) => (r ?? "").toUpperCase() === target
  );
};

const isAdmin = (req: AuthenticatedRequest) =>
  hasRole(req.user, "ADMIN");

const isDcc = (req: AuthenticatedRequest) =>
  hasRole(req.user, "DCC");

const isAdminOrDcc = (req: AuthenticatedRequest) =>
  isAdmin(req) || isDcc(req);

const VALID_SLOT_TYPES: ApprovalSlotType[] = [
  "FIXED_USER",
  "DEPARTMENT_HEAD",
  "MEMO_REQUESTER",
  "FLEXIBLE_SLOT",
];

const isApprovalSlotType = (v: any): v is ApprovalSlotType =>
  VALID_SLOT_TYPES.includes(v);

/* ───────────────── getApproverLines: คืน line ที่ user นี้อยู่ ───────────────── */

export const getApproverLines: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  if (!isAdminOrDcc(req)) {
    res.status(403).json({ error: "Only ADMIN/DCC can view approver lines" });
    return;
  }

  const userId = Number(req.params.userId || req.params.id);
  if (!Number.isFinite(userId)) {
    res.status(400).json({ error: "Invalid userId" });
    return;
  }

  try {
    // 1) pivot ที่ user นี้อยู่ (ใช้หา line ที่เกี่ยวข้อง + base ข้อมูล line)
    const pivots = await prisma.lineOfApprovalUserPivot.findMany({
      where: {
        slotType: "FIXED_USER",
        userId,
      },
      include: {
        lineOfApproval: {
          select: {
            id: true,
            name: true,
            businessUnit: { select: { name: true } }, // (ของ line)
            memoTypes: {
              select: {
                id: true,
                name: true,
                abbreviation: true,
                businessUnit: { select: { name: true } }, // ✅ ของ MemoType
                department: { select: { name: true } }, // ✅ ของ MemoType
              },
            },
          },
        },
      },
      orderBy: [{ lineOfApprovalId: "asc" }, { level: "asc" }],
    });

    if (pivots.length === 0) {
      res.json([]);
      return;
    }

    // 2) ดึงทุก slot ของทุก lineId (ทุกคนทุก level) — กรอง null ออกด้วย type guard
    const lineIds = Array.from(
      new Set(
        pivots
          .map((p) => p.lineOfApprovalId)
          .filter((id): id is number => id != null)
      )
    );

    const allSlots = await prisma.lineOfApprovalUserPivot.findMany({
      where: { lineOfApprovalId: { in: lineIds } },
      include: {
        user: {
          select: { id: true, name: true, lastname: true, nickname: true },
        },
      },
    });

    // 3) group slot ตาม lineId
    type SlotDto = {
      level: number;
      userId: number | null;
      userName: string | null;
      isTarget: boolean;
      slotType: ApprovalSlotType | null;
      isSigReq: boolean;
      roleDescription: string | null;
      approvalRequirement: ApprovalRequirement;
    };

    const slotMap = new Map<number, SlotDto[]>();

    for (const s of allSlots) {
      if (s.lineOfApprovalId == null) continue;

      const fullName = [s.user?.name, s.user?.lastname].filter(Boolean).join(" ");
      const displayName =
        s.user?.nickname && fullName
          ? `${fullName} (${s.user.nickname})`
          : fullName || s.user?.nickname || null;

      const dto: SlotDto = {
        level: s.level,
        userId: s.userId,
        userName: displayName,
        isTarget: s.userId === userId && s.slotType === "FIXED_USER",
        slotType: s.slotType ?? null,
        isSigReq: s.isSigReq ?? false,
        roleDescription: s.roleDescription ?? null,
        approvalRequirement: s.approvalRequirement ?? "ALL",
      };

      const lineId = s.lineOfApprovalId;
      const arr = slotMap.get(lineId) ?? [];
      arr.push(dto);
      if (!slotMap.has(lineId)) slotMap.set(lineId, arr);
    }

    // 4) map เป็น response (แต่ละ pivot = 1 row, เดี๋ยวหน้าบ้าน group เอง)
    const lines = pivots.map((p) => {
      const lo = p.lineOfApproval;
      const firstType = lo?.memoTypes?.[0];

      const slotsForLine: SlotDto[] =
        p.lineOfApprovalId != null ? slotMap.get(p.lineOfApprovalId) ?? [] : [];

      return {
        pivotId: p.id,
        lineOfApprovalId: p.lineOfApprovalId,
        lineName: lo?.name ?? null,
        level: p.level,

        // ✅ เอา BU/Dept จาก MemoType ก่อน แล้วค่อย fallback ไปที่ Line
        businessUnitName:
          firstType?.businessUnit?.name ?? lo?.businessUnit?.name ?? null,
        departmentName: firstType?.department?.name ?? null,

        memoTypeName: firstType?.name ?? null,
        memoTypeAbbr: firstType?.abbreviation ?? null,
        slots: slotsForLine,
      };
    });

    res.json(lines);
  } catch (err) {
    console.error("getApproverLines error:", err);
    res.status(500).json({ error: "Failed to load approver lines" });
  }
};

/* ───────────────── getAllApproverLines ───────────────── */

export const getAllApproverLines: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  if (!isAdminOrDcc(req)) {
    res.status(403).json({ error: "Only ADMIN/DCC can view approver lines" });
    return;
  }

  try {
    // Build filter for DCC users based on their BU/dept and DCC management access
    let lineWhereFilter: Prisma.LineOfApprovalWhereInput = {};
    let memoTypeWhereFilter: Prisma.MemoTypeWhereInput = {};

    // Check if businessUnitId filter is provided in query
    const selectedBuId = req.query.businessUnitId 
      ? Number(req.query.businessUnitId) 
      : null;

    if (isDcc(req) && !isAdmin(req)) {
      const dccUser = await prisma.user.findUnique({
        where: { id: req.user!.id },
        select: { 
          businessUnitId: true, 
          departmentId: true,
          // Include DCC management access for additional BUs
          dccManagementAccess: {
            select: { businessUnitId: true }
          }
        },
      });

      const dccBuId = dccUser?.businessUnitId ?? null;
      const dccDeptId = dccUser?.departmentId ?? null;
      
      // Combine primary BU + additional DCC management BUs
      const additionalBuIds = (dccUser?.dccManagementAccess || []).map(a => a.businessUnitId);
      const manageableBuIds = dccBuId 
        ? [dccBuId, ...additionalBuIds.filter(id => id !== dccBuId)]
        : additionalBuIds;

      // Build OR conditions for filtering
      const lineOrConditions: Prisma.LineOfApprovalWhereInput[] = [];
      const memoTypeOrConditions: Prisma.MemoTypeWhereInput[] = [];

      // If a specific BU is selected, validate it's in manageable list and filter to only that BU
      if (selectedBuId && manageableBuIds.includes(selectedBuId)) {
        lineOrConditions.push({ businessUnitId: selectedBuId });
        memoTypeOrConditions.push({ businessUnitId: selectedBuId });
      } else {
        // Filter by all manageable BUs
        if (manageableBuIds.length > 0) {
          lineOrConditions.push({ businessUnitId: { in: manageableBuIds } });
          memoTypeOrConditions.push({ businessUnitId: { in: manageableBuIds } });
        }
      }

      // Filter by department (for forEveryDepartmentAcrossBU mode)
      if (dccDeptId != null) {
        memoTypeOrConditions.push({ departmentId: dccDeptId });
      }

      // Include forEveryone memo types
      memoTypeOrConditions.push({ forEveryone: true });

      // Apply filters
      if (lineOrConditions.length > 0) {
        lineWhereFilter = { OR: lineOrConditions };
      }
      if (memoTypeOrConditions.length > 0) {
        memoTypeWhereFilter = { OR: memoTypeOrConditions };
      }
    }

    // ✅ First, get all lines of approval (filtered for DCC)
    const allLines = await prisma.lineOfApproval.findMany({
      where: lineWhereFilter,
      select: {
        id: true,
        name: true,
        businessUnitId: true,
        businessUnit: { select: { id: true, name: true } },
        memoTypes: {
          where: memoTypeWhereFilter,
          select: {
            id: true,
            name: true,
            abbreviation: true,
            businessUnitId: true,
            departmentId: true,
            forEveryone: true,
            businessUnit: { select: { id: true, name: true } },
            department: { select: { id: true, name: true } },
          },
        },
      },
    });

    // For DCC users, also include lines that have memo types matching their criteria
    // (even if the line itself doesn't have a matching BU)
    let additionalLineIds: number[] = [];
    if (isDcc(req) && !isAdmin(req)) {
      // Find lines that have memo types matching DCC's criteria
      const linesWithMatchingMemoTypes = await prisma.lineOfApproval.findMany({
        where: {
          memoTypes: {
            some: memoTypeWhereFilter,
          },
        },
        select: { id: true },
      });

      additionalLineIds = linesWithMatchingMemoTypes.map(l => l.id);
    }

    // Merge additional lines
    const existingLineIds = new Set(allLines.map(l => l.id));
    if (additionalLineIds.length > 0) {
      const additionalLines = await prisma.lineOfApproval.findMany({
        where: {
          id: { in: additionalLineIds.filter(id => !existingLineIds.has(id)) },
        },
        select: {
          id: true,
          name: true,
          businessUnitId: true,
          businessUnit: { select: { id: true, name: true } },
          memoTypes: {
            where: memoTypeWhereFilter,
            select: {
              id: true,
              name: true,
              abbreviation: true,
              businessUnitId: true,
              departmentId: true,
              forEveryone: true,
              businessUnit: { select: { id: true, name: true } },
              department: { select: { id: true, name: true } },
            },
          },
        },
      });
      allLines.push(...additionalLines);
    }

    // Get all line IDs for pivot query
    const allLineIds = allLines.map(l => l.id);

    // ดึง pivot ทุกตัวของ lines ที่ผ่าน filter
    const pivots = await prisma.lineOfApprovalUserPivot.findMany({
      where: {
        lineOfApprovalId: { in: allLineIds },
      },
      include: {
        lineOfApproval: {
          select: {
            id: true,
            name: true,
            businessUnit: { select: { name: true } }, // (ของ line)
            memoTypes: {
              where: memoTypeWhereFilter,
              select: {
                id: true,
                name: true,
                abbreviation: true,
                businessUnit: { select: { name: true } }, // ✅ ของ MemoType
                department: { select: { name: true } }, // ✅ ของ MemoType
              },
            },
          },
        },
        user: { select: { id: true, name: true, lastname: true, nickname: true } },
      },
      orderBy: [{ lineOfApprovalId: "asc" }, { level: "asc" }],
    });

    type SlotDto = {
      level: number;
      userId: number | null;
      userName: string | null;
      isTarget: boolean;
      slotType: ApprovalSlotType | null;
      isSigReq: boolean;
      roleDescription: string | null;
      approvalRequirement: ApprovalRequirement;
    };

    const slotMap = new Map<number, SlotDto[]>();

    for (const p of pivots) {
      if (p.lineOfApprovalId == null) continue;

      const fullName = [p.user?.name, p.user?.lastname].filter(Boolean).join(" ");
      const displayName =
        p.user?.nickname && fullName
          ? `${fullName} (${p.user.nickname})`
          : fullName || p.user?.nickname || null;

      const dto: SlotDto = {
        level: p.level,
        userId: p.userId,
        userName: displayName,
        isTarget: false,
        slotType: p.slotType ?? null,
        isSigReq: p.isSigReq ?? false,
        roleDescription: p.roleDescription ?? null,
        approvalRequirement: p.approvalRequirement ?? "ALL",
      };

      const arr = slotMap.get(p.lineOfApprovalId) ?? [];
      arr.push(dto);
      if (!slotMap.has(p.lineOfApprovalId)) slotMap.set(p.lineOfApprovalId, arr);
    }

    // ✅ Build lines from slotMap (lines with pivots)
    const linesWithPivots = Array.from(slotMap.entries()).map(([lineId, slots]) => {
      const anyPivot = pivots.find((p) => p.lineOfApprovalId === lineId);
      const lo = anyPivot?.lineOfApproval;
      const firstType = lo?.memoTypes?.[0];

      return {
        pivotId: anyPivot?.id ?? 0,
        lineOfApprovalId: lineId,
        lineName: lo?.name ?? null,
        level: anyPivot?.level ?? 0,

        // ✅ เอา BU/Dept จาก MemoType ก่อน แล้วค่อย fallback ไปที่ Line
        businessUnitName:
          firstType?.businessUnit?.name ?? lo?.businessUnit?.name ?? null,
        departmentName: firstType?.department?.name ?? null,

        memoTypeName: firstType?.name ?? null,
        memoTypeAbbr: firstType?.abbreviation ?? null,
        slots,
      };
    });

    // ✅ Add lines without any pivots (empty approval chains)
    const lineIdsWithPivots = new Set(slotMap.keys());
    const linesWithoutPivots = allLines
      .filter((line) => !lineIdsWithPivots.has(line.id))
      .map((line) => {
        const firstType = line.memoTypes?.[0];
        return {
          pivotId: 0,
          lineOfApprovalId: line.id,
          lineName: line.name ?? null,
          level: 0,
          businessUnitName:
            firstType?.businessUnit?.name ?? line.businessUnit?.name ?? null,
          departmentName: firstType?.department?.name ?? null,
          memoTypeName: firstType?.name ?? null,
          memoTypeAbbr: firstType?.abbreviation ?? null,
          slots: [], // ✅ Empty slots array for lines without approvers
        };
      });

    // ✅ Combine both lists
    const lines = [...linesWithPivots, ...linesWithoutPivots];

    res.json(lines);
  } catch (err) {
    console.error("getAllApproverLines error:", err);
    res.status(500).json({ error: "Failed to load approver lines" });
  }
};

/* ───────────────── bulkUpdateApprover (enhanced with multiple actions) ───────────────── */

export const bulkUpdateApprover: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  if (!isAdminOrDcc(req)) {
    res.status(403).json({ error: "Only ADMIN/DCC can update approvers" });
    return;
  }

  const {
    fromUserId,
    toUserId, // Only required for "replace" action
    action = "replace", // "replace" | "flexible" | "remove"
    businessUnitId,
    departmentId,
    memoTypeId,
    affectTemplates = true,
    affectRunningMemos = true,
    affectCcGroups = false,
    dryRun = false,
    lineOfApprovalIds,
  } = req.body || {};

  const fromId = Number(fromUserId);

  if (!Number.isFinite(fromId)) {
    res.status(400).json({ error: "Invalid fromUserId" });
    return;
  }

  // Validate action
  if (!["replace", "flexible", "remove"].includes(action)) {
    res.status(400).json({ error: "Invalid action. Must be 'replace', 'flexible', or 'remove'" });
    return;
  }

  // For replace action, validate toUserId
  if (action === "replace") {
    const toId = Number(toUserId);
    if (!Number.isFinite(toId) || fromId === toId) {
      res.status(400).json({ error: "Invalid toUserId for replace action" });
      return;
    }
  }

  try {
    const fromUser = await prisma.user.findUnique({
      where: { id: fromId },
      select: { id: true, name: true },
    });

    if (!fromUser) {
      res.status(400).json({ error: "From user not found" });
      return;
    }

    let toUser = null;
    if (action === "replace") {
      toUser = await prisma.user.findUnique({
        where: { id: Number(toUserId) },
        select: { id: true, name: true },
      });

      if (!toUser) {
        res.status(400).json({ error: "To user not found" });
        return;
      }
    }

    // ---------- Scope for LineOfApproval ----------
    const lineScope: any = {};
    if (businessUnitId != null) lineScope.businessUnitId = Number(businessUnitId);

    const memoTypeScope =
      memoTypeId != null
        ? { memoTypes: { some: { id: Number(memoTypeId) } } }
        : {};

    // Filter by lineOfApprovalIds if provided
    const lineIdsFilter =
      Array.isArray(lineOfApprovalIds) && lineOfApprovalIds.length > 0
        ? {
          lineOfApprovalId: {
            in: (lineOfApprovalIds as any[]).map((id) => Number(id)),
          },
        }
        : {};

    // ---------- Conflict check for replace action ----------
    if (affectTemplates && action === "replace") {
      const targetPivots = await prisma.lineOfApprovalUserPivot.findMany({
        where: {
          slotType: "FIXED_USER",
          userId: fromId,
          ...lineIdsFilter,
          lineOfApproval: { ...lineScope, ...memoTypeScope },
        },
        select: { lineOfApprovalId: true, level: true },
      });

      const targetLineIds = Array.from(
        new Set(
          targetPivots
            .map((p) => p.lineOfApprovalId)
            .filter((id): id is number => id != null)
        )
      );

      if (targetLineIds.length === 0) {
        res.status(400).json({
          error: "No approval lines to update for the selected approver under the current filters.",
        });
        return;
      }

      // Build a set of lineId-level combinations that will be replaced
      const targetLineLevels = new Set(
        targetPivots.map((p) => `${p.lineOfApprovalId}-${p.level}`)
      );

      // Check if new user already exists at the SAME LEVEL in these lines
      // (Allow same user at different levels)
      const conflictPivots = await prisma.lineOfApprovalUserPivot.findMany({
        where: {
          slotType: "FIXED_USER",
          userId: Number(toUserId),
          lineOfApprovalId: { in: targetLineIds },
        },
        include: {
          lineOfApproval: { select: { id: true, name: true } },
        },
      });

      // Filter to only conflicts at the same level
      const actualConflicts = conflictPivots.filter((c) => 
        targetLineLevels.has(`${c.lineOfApprovalId}-${c.level}`)
      );

      if (actualConflicts.length > 0) {
        const conflictDetails = actualConflicts
          .map((c) => {
            const lineName = c.lineOfApproval?.name || `Line ID ${c.lineOfApprovalId}`;
            const levelLabel = `L${(c.level ?? 0) + 1}`;
            return `${lineName} (${levelLabel})`;
          })
          .join(", ");

        res.status(400).json({
          error:
            `Cannot replace approver because the new approver is already assigned at the same level in these lines: ${conflictDetails}. ` +
            "If you want to move positions, please edit them directly in the Line management page.",
          conflictLines: actualConflicts.map((c) => ({
            lineOfApprovalId: c.lineOfApprovalId,
            lineName: c.lineOfApproval?.name ?? null,
            level: c.level,
          })),
        });
        return;
      }
    }

    const result = {
      templatePivotsChanged: 0,
      templatePivotsDeletedAsDup: 0,
      memoApproversChanged: 0,
      ccMembersChanged: 0,
    };

    // ---------- DRY RUN ----------
    if (dryRun) {
      if (affectTemplates) {
        result.templatePivotsChanged = await prisma.lineOfApprovalUserPivot.count({
          where: {
            slotType: "FIXED_USER",
            userId: fromId,
            ...lineIdsFilter,
            lineOfApproval: { ...lineScope, ...memoTypeScope },
          },
        });
      }
      if (affectRunningMemos) result.memoApproversChanged = 0;
      if (affectCcGroups && action === "replace") {
        result.ccMembersChanged = await prisma.ccGroupMember.count({
          where: { userId: fromId },
        });
      }

      res.json({ dryRun: true, ...result, fromUser, toUser, action });
      return;
    }

    // ---------- EXECUTE (transaction) ----------
    let affectedLineIds: number[] = [];

    await prisma.$transaction(async (tx) => {
      if (affectTemplates) {
        const pivots = await tx.lineOfApprovalUserPivot.findMany({
          where: {
            slotType: "FIXED_USER",
            userId: fromId,
            ...lineIdsFilter,
            lineOfApproval: { ...lineScope, ...memoTypeScope },
          },
          select: {
            id: true,
            lineOfApprovalId: true,
            level: true,
            isSigReq: true,
            roleDescription: true
          },
        });

        // Capture affected line IDs
        affectedLineIds = Array.from(new Set(pivots.map(p => p.lineOfApprovalId).filter((id): id is number => id != null)));

        for (const p of pivots) {
          if (action === "replace") {
            // Replace with new user
            const dup = await tx.lineOfApprovalUserPivot.findFirst({
              where: {
                lineOfApprovalId: p.lineOfApprovalId,
                level: p.level,
                slotType: "FIXED_USER",
                userId: Number(toUserId),
              },
              select: { id: true },
            });

            if (dup) {
              await tx.lineOfApprovalUserPivot.delete({ where: { id: p.id } });
              result.templatePivotsDeletedAsDup++;
            } else {
              await tx.lineOfApprovalUserPivot.update({
                where: { id: p.id },
                data: { userId: Number(toUserId) },
              });
              result.templatePivotsChanged++;
            }
          } else if (action === "flexible") {
            // Change to flexible slot
            await tx.lineOfApprovalUserPivot.update({
              where: { id: p.id },
              data: {
                userId: null,
                slotType: "FLEXIBLE_SLOT"
              },
            });
            result.templatePivotsChanged++;
          } else if (action === "remove") {
            // Remove the approver entirely
            await tx.lineOfApprovalUserPivot.delete({ where: { id: p.id } });
            result.templatePivotsChanged++;
          }
        }
      }

      if (affectRunningMemos) result.memoApproversChanged = 0;

      if (affectCcGroups && action === "replace") {
        const { count } = await tx.ccGroupMember.updateMany({
          where: { userId: fromId },
          data: { userId: Number(toUserId) },
        });
        result.ccMembersChanged += count;
      }
    });

    // Fetch affected line names
    const affectedLines = await prisma.lineOfApproval.findMany({
      where: { id: { in: affectedLineIds } },
      select: { name: true },
        orderBy: { id: "asc" }
    });
    const lineNames = affectedLines.map(l => l.name);

    // Determine log action name
    let logAction = "LOA_BULK_UPDATE";
    if (action === "replace") logAction = "LOA_REPLACE_APPROVER";
    else if (action === "remove") logAction = "LOA_REMOVE_APPROVER";
    else if (action === "flexible") logAction = "LOA_CHANGE_APPROVER_TO_FLEXIBLE";

    // Log the action
    await createAdminLog(
      req.user!.id,
      logAction,
      "LOA",
      fromId, // Target is the user being modified
      action === "replace" ? fromUser?.name + " -> " + toUser?.name : fromUser?.name,
      {
        action,
        fromUserId: fromId,
        toUserId: action === "replace" ? Number(toUserId) : undefined,
        affectedLines: lineNames
      }
    );
    

    res.json({ ok: true, ...result, fromUser, toUser, action });
  } catch (err) {
    console.error("bulkUpdateApprover error:", err);
    res.status(500).json({ error: "Failed to update approver" });
  }
};

/* ───────────────── replaceApprover (bulk) ───────────────── */

export const replaceApprover: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  if (!isAdminOrDcc(req)) {
    res.status(403).json({ error: "Only ADMIN/DCC can replace approvers" });
    return;
  }

  const {
    fromUserId,
    toUserId,
    businessUnitId,
    departmentId, // ยังไม่ได้ใช้จริง แต่เผื่ออนาคต
    memoTypeId,
    affectTemplates = true,
    affectRunningMemos = true, // ตอนนี้จะเป็น no-op (ไม่มี table memoApprover)
    affectCcGroups = false,
    dryRun = false,
    lineOfApprovalIds, // ⬅️ รับมาจาก body
  } = req.body || {};

  const fromId = Number(fromUserId);
  const toId = Number(toUserId);

  if (!Number.isFinite(fromId) || !Number.isFinite(toId) || fromId === toId) {
    res.status(400).json({ error: "Invalid fromUserId / toUserId" });
    return;
  }

  try {
    const [fromUser, toUser] = await Promise.all([
      prisma.user.findUnique({
        where: { id: fromId },
        select: { id: true, name: true },
      }),
      prisma.user.findUnique({
        where: { id: toId },
        select: { id: true, name: true },
      }),
    ]);

    if (!fromUser || !toUser) {
      res.status(400).json({ error: "User not found" });
      return;
    }

    // ---------- Scope สำหรับ LineOfApproval ----------
    const lineScope: any = {};
    if (businessUnitId != null) lineScope.businessUnitId = Number(businessUnitId);
    // departmentId ถ้า line มี field นี้ค่อยใช้ในอนาคต
    // if (departmentId != null) lineScope.departmentId = Number(departmentId);

    const memoTypeScope =
      memoTypeId != null
        ? { memoTypes: { some: { id: Number(memoTypeId) } } }
        : {};

    // ✅ filter ตาม lineOfApprovalIds ที่เลือกจากหน้าบ้าน (ถ้ามี)
    const lineIdsFilter =
      Array.isArray(lineOfApprovalIds) && lineOfApprovalIds.length > 0
        ? {
          lineOfApprovalId: {
            in: (lineOfApprovalIds as any[]).map((id) => Number(id)),
          },
        }
        : {};

    // ---------- NEW: เช็คก่อนว่า toUser มีอยู่ใน line ใด ๆ ที่จะโดนเปลี่ยนอยู่แล้วไหม ----------
    if (affectTemplates) {
      const targetPivots = await prisma.lineOfApprovalUserPivot.findMany({
        where: {
          slotType: "FIXED_USER",
          userId: fromId,
          ...lineIdsFilter,
          lineOfApproval: { ...lineScope, ...memoTypeScope },
        },
        select: { lineOfApprovalId: true },
      });

      const targetLineIds = Array.from(
        new Set(
          targetPivots
            .map((p) => p.lineOfApprovalId)
            .filter((id): id is number => id != null)
        )
      );

      if (targetLineIds.length === 0) {
        res.status(400).json({
          error:
            "No approval lines to update for the selected approver under the current filters.",
        });
        return;
      }

      // เช็คว่าคนใหม่(toUser) มีอยู่ใน line เหล่านี้อยู่แล้วไหม (ไม่สน level)
      const conflictPivots = await prisma.lineOfApprovalUserPivot.findMany({
        where: {
          slotType: "FIXED_USER",
          userId: toId,
          lineOfApprovalId: { in: targetLineIds },
        },
        include: {
          lineOfApproval: { select: { id: true, name: true } },
        },
      });

      if (conflictPivots.length > 0) {
        const conflictDetails = conflictPivots
          .map((c) => {
            const lineName = c.lineOfApproval?.name || `Line ID ${c.lineOfApprovalId}`;
            const levelLabel = `L${(c.level ?? 0) + 1}`;
            return `${lineName} (${levelLabel})`;
          })
          .join(", ");

        res.status(400).json({
          error:
            `Cannot replace approver because the new approver is already assigned in these lines/levels: ${conflictDetails}. ` +
            "If you want to move positions, please edit them directly in the Line management page.",
          conflictLines: conflictPivots.map((c) => ({
            lineOfApprovalId: c.lineOfApprovalId,
            lineName: c.lineOfApproval?.name ?? null,
            level: c.level,
          })),
        });
        return;
      }
    }
    // ---------- END NEW CHECK ----------

    const result = {
      templatePivotsChanged: 0,
      templatePivotsDeletedAsDup: 0,
      memoApproversChanged: 0,
      ccMembersChanged: 0,
    };

    // ---------- DRY RUN ----------
    if (dryRun) {
      if (affectTemplates) {
        result.templatePivotsChanged = await prisma.lineOfApprovalUserPivot.count({
          where: {
            slotType: "FIXED_USER",
            userId: fromId,
            ...lineIdsFilter,
            lineOfApproval: { ...lineScope, ...memoTypeScope },
          },
        });
      }
      if (affectRunningMemos) result.memoApproversChanged = 0;
      if (affectCcGroups) {
        result.ccMembersChanged = await prisma.ccGroupMember.count({
          where: { userId: fromId },
        });
      }

      res.json({ dryRun: true, ...result, fromUser, toUser });
      return;
    }

    // ---------- DO (transaction) ----------
    let affectedLineIds: number[] = [];

    await prisma.$transaction(async (tx) => {
      if (affectTemplates) {
        const pivots = await tx.lineOfApprovalUserPivot.findMany({
          where: {
            slotType: "FIXED_USER",
            userId: fromId,
            ...lineIdsFilter,
            lineOfApproval: { ...lineScope, ...memoTypeScope },
          },
          select: { id: true, lineOfApprovalId: true, level: true, isSigReq: true },
        });

        // Capture affected line IDs
        affectedLineIds = Array.from(new Set(pivots.map(p => p.lineOfApprovalId).filter((id): id is number => id != null)));

        for (const p of pivots) {
          const dup = await tx.lineOfApprovalUserPivot.findFirst({
            where: {
              lineOfApprovalId: p.lineOfApprovalId,
              level: p.level,
              slotType: "FIXED_USER",
              userId: toId,
            },
            select: { id: true },
          });

          if (dup) {
            await tx.lineOfApprovalUserPivot.delete({ where: { id: p.id } });
            result.templatePivotsDeletedAsDup++;
          } else {
            await tx.lineOfApprovalUserPivot.update({
              where: { id: p.id },
              data: { userId: toId },
            });
            result.templatePivotsChanged++;
          }
        }
      }

      if (affectRunningMemos) result.memoApproversChanged = 0;

      if (affectCcGroups) {
        const { count } = await tx.ccGroupMember.updateMany({
          where: { userId: fromId },
          data: { userId: toId },
        });
        result.ccMembersChanged += count;
      }
    });

    // Fetch affected line names
    const affectedLines = await prisma.lineOfApproval.findMany({
      where: { id: { in: affectedLineIds } },
      select: { name: true },
      orderBy: { id: "asc" }
    });
    const lineNames = affectedLines.map(l => l.name);

    // Log the action
    await createAdminLog(
      req.user!.id,
      "LOA_REPLACE_APPROVER",
      "LOA",
      fromId,
      `${fromUser.name} -> ${toUser.name}`,
      {
        fromUserId: fromId,
        toUserId: toId,
        affectedLines: lineNames
      }
    );

    res.json({ ok: true, ...result, fromUser, toUser });
  } catch (err) {
    console.error("replaceApprover error:", err);
    res.status(500).json({ error: "Failed to replace approver" });
  }
};

/* ───────────────── bulkUpdateSignature ───────────────── */

export const bulkUpdateSignature: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  if (!isAdminOrDcc(req)) {
    res.status(403).json({ error: "Only ADMIN/DCC can update signature requirements" });
    return;
  }

  const {
    fromUserId,
    action = "enable", // "enable" | "disable"
    businessUnitId,
    departmentId,
    memoTypeId,
    affectTemplates = true,
    dryRun = false,
    lineOfApprovalIds,
  } = req.body || {};

  const fromId = Number(fromUserId);

  if (!Number.isFinite(fromId)) {
    res.status(400).json({ error: "Invalid fromUserId" });
    return;
  }

  // Validate action
  if (!["enable", "disable"].includes(action)) {
    res.status(400).json({ error: "Invalid action. Must be 'enable' or 'disable'" });
    return;
  }

  try {
    const fromUser = await prisma.user.findUnique({
      where: { id: fromId },
      select: { id: true, name: true },
    });

    if (!fromUser) {
      res.status(400).json({ error: "User not found" });
      return;
    }

    // ---------- Scope for LineOfApproval ----------
    const lineScope: any = {};
    if (businessUnitId != null) lineScope.businessUnitId = Number(businessUnitId);

    const memoTypeScope =
      memoTypeId != null
        ? { memoTypes: { some: { id: Number(memoTypeId) } } }
        : {};

    // Filter by lineOfApprovalIds if provided
    const lineIdsFilter =
      Array.isArray(lineOfApprovalIds) && lineOfApprovalIds.length > 0
        ? {
          lineOfApprovalId: {
            in: (lineOfApprovalIds as any[]).map((id) => Number(id)),
          },
        }
        : {};

    const result = {
      templatePivotsChanged: 0,
    };

    // ---------- DRY RUN ----------
    if (dryRun) {
      if (affectTemplates) {
        result.templatePivotsChanged = await prisma.lineOfApprovalUserPivot.count({
          where: {
            slotType: "FIXED_USER",
            userId: fromId,
            ...lineIdsFilter,
            lineOfApproval: { ...lineScope, ...memoTypeScope },
          },
        });
      }

      res.json({ dryRun: true, ...result, fromUser, action });
      return;
    }

    // ---------- EXECUTE (transaction) ----------
    let affectedLineIds: number[] = [];

    await prisma.$transaction(async (tx) => {
      if (affectTemplates) {
        const pivots = await tx.lineOfApprovalUserPivot.findMany({
          where: {
            slotType: "FIXED_USER",
            userId: fromId,
            ...lineIdsFilter,
            lineOfApproval: { ...lineScope, ...memoTypeScope },
          },
          select: {
            id: true,
            lineOfApprovalId: true,
            level: true,
            isSigReq: true,
            roleDescription: true
          },
        });

        // Capture affected line IDs
        affectedLineIds = Array.from(new Set(pivots.map(p => p.lineOfApprovalId).filter((id): id is number => id != null)));

        const targetSignatureValue = action === "enable";

        for (const p of pivots) {
          // Only update if the current value is different from target
          if (p.isSigReq !== targetSignatureValue) {
            await tx.lineOfApprovalUserPivot.update({
              where: { id: p.id },
              data: { isSigReq: targetSignatureValue },
            });
            result.templatePivotsChanged++;
          }
        }
      }
    });



    // Fetch affected line names
    const affectedLines = await prisma.lineOfApproval.findMany({
      where: { id: { in: affectedLineIds } },
      select: { name: true },
      orderBy: { id: "asc" }
    });
    const lineNames = affectedLines.map(l => l.name);

    // Log the action
    await createAdminLog(
      req.user!.id,
      "LOA_UPDATE_SIGNATURE",
      "LOA",
      fromId,
      `${fromUser.name} (${action})`,
      {
        fromUserId: fromId,
        action,
        affectedLines: lineNames
      }
    );

    res.json({ ok: true, ...result, fromUser, action });
  } catch (err) {
    console.error("bulkUpdateSignature error:", err);
    res.status(500).json({ error: "Failed to update signature requirements" });
  }
};

/* ───────────────── bulkReorderApprover ───────────────── */

export const bulkReorderApprover: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  if (!isAdminOrDcc(req)) {
    res.status(403).json({ error: "Only ADMIN/DCC can reorder approvers" });
    return;
  }

  const {
    fromUserId,
    action, // "moveToFirst" | "plusOne" | "minusOne" | "moveToLast"
    affectTemplates = true,
    dryRun = false,
    lineOfApprovalIds,
  } = req.body || {};

  const fromId = Number(fromUserId);

  if (!Number.isFinite(fromId)) {
    res.status(400).json({ error: "Invalid fromUserId" });
    return;
  }

  // Validate action
  if (!["moveToFirst", "plusOne", "minusOne", "moveToLast"].includes(action)) {
    res.status(400).json({ error: "Invalid action. Must be 'moveToFirst', 'plusOne', 'minusOne', or 'moveToLast'" });
    return;
  }

  try {
    const fromUser = await prisma.user.findUnique({
      where: { id: fromId },
      select: { id: true, name: true },
    });

    if (!fromUser) {
      res.status(400).json({ error: "User not found" });
      return;
    }

    // Filter by lineOfApprovalIds if provided
    const lineIdsFilter =
      Array.isArray(lineOfApprovalIds) && lineOfApprovalIds.length > 0
        ? {
          lineOfApprovalId: {
            in: (lineOfApprovalIds as any[]).map((id) => Number(id)),
          },
        }
        : {};

    const result = {
      templatePivotsChanged: 0,
      slotsSkipped: 0,
    };

    // ---------- DRY RUN ----------
    if (dryRun) {
      if (affectTemplates) {
        result.templatePivotsChanged = await prisma.lineOfApprovalUserPivot.count({
          where: {
            slotType: "FIXED_USER",
            userId: fromId,
            ...lineIdsFilter,
          },
        });
      }

      res.json({ dryRun: true, ...result, fromUser, action });
      return;
    }

    // ---------- EXECUTE (transaction) ----------
    let affectedLineIds: number[] = [];
    
    await prisma.$transaction(async (tx) => {
      if (affectTemplates) {
        // Get all pivots for the target user in selected lines
        const pivots = await tx.lineOfApprovalUserPivot.findMany({
          where: {
            slotType: "FIXED_USER",
            userId: fromId,
            ...lineIdsFilter,
          },
          select: {
            id: true,
            lineOfApprovalId: true,
            level: true,
            isSigReq: true,
            roleDescription: true
          },
        });

        // Capture affected line IDs
        affectedLineIds = Array.from(new Set(pivots.map(p => p.lineOfApprovalId).filter((id): id is number => id != null)));

        // Group pivots by lineOfApprovalId
        const pivotsByLine = new Map<number, typeof pivots>();
        for (const p of pivots) {
          if (p.lineOfApprovalId == null) continue;
          const arr = pivotsByLine.get(p.lineOfApprovalId) ?? [];
          arr.push(p);
          if (!pivotsByLine.has(p.lineOfApprovalId)) pivotsByLine.set(p.lineOfApprovalId, arr);
        }

        // Process each line
        for (const [lineId, linePivots] of pivotsByLine) {
          // Get all slots for this line to determine min/max levels
          const allSlotsInLine = await tx.lineOfApprovalUserPivot.findMany({
            where: { lineOfApprovalId: lineId },
            select: { level: true },
          });

          if (allSlotsInLine.length === 0) continue;

          const levels = allSlotsInLine.map(s => s.level);
          const minLevel = Math.min(...levels);
          const maxLevel = Math.max(...levels);

          // Process each pivot for this user in this line
          for (const pivot of linePivots) {
            const currentLevel = pivot.level;
            let newLevel: number;

            switch (action) {
              case "moveToFirst":
                // Always create a new first level (before the current first level)
                newLevel = minLevel - 1;
                break;
              case "plusOne":
                // Plus one means moving to a higher level number (later in approval)
                // If already at max level, create a new level
                newLevel = currentLevel + 1;
                break;
              case "minusOne":
                // Minus one means moving to a lower level number (earlier in approval)
                // If already at min level, create a new level before it
                newLevel = currentLevel - 1;
                break;
              case "moveToLast":
                // Always create a new last level (after the current last level)
                newLevel = maxLevel + 1;
                break;
              default:
                newLevel = currentLevel;
            }

            // If the level hasn't changed, skip
            if (newLevel === currentLevel) {
              result.slotsSkipped++;
              continue;
            }

            // Update the pivot to the new level (will be parallel with any existing approvers at that level)
            await tx.lineOfApprovalUserPivot.update({
              where: { id: pivot.id },
              data: { level: newLevel },
            });
            result.templatePivotsChanged++;
          }
        }
      }
    });

    // Log the action
    // Fetch affected line names
    const affectedLines = await prisma.lineOfApproval.findMany({
      where: { id: { in: affectedLineIds } },
      select: { name: true },
      orderBy: { id: "asc" }
    });
    const lineNames = affectedLines.map(l => l.name);

    // Log the action
    await createAdminLog(
      req.user!.id,
      "LOA_UPDATE_LEVEL",
      "LOA",
      fromId,
      `${fromUser.name} (${action})`,
      {
        fromUserId: fromId,
        action,
        affectedLines: lineNames
      }
    );

    res.json({ ok: true, ...result, fromUser, action });
  } catch (err) {
    console.error("bulkReorderApprover error:", err);
    res.status(500).json({ error: "Failed to reorder approver" });
  }
};

/* ───────────────── getMemoTypesForLine ───────────────── */

export const getMemoTypesForLine: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  if (!isAdminOrDcc(req)) {
    res.status(403).json({ error: "Only ADMIN/DCC can view memo types" });
    return;
  }

  const lineId = Number(req.params.lineId);
  if (!Number.isFinite(lineId)) {
    res.status(400).json({ error: "Invalid line ID" });
    return;
  }

  try {
    const memoTypes = await prisma.memoType.findMany({
      where: {
        approvalLineId: lineId,
        // Show all memo types (including inactive) in approver-lines management page
      },
      select: {
        id: true,
        name: true,
        abbreviation: true,
        description: true,
        isActive: true, // Include isActive field so UI can show status
        businessUnit: {
          select: {
            id: true,
            name: true,
          },
        },
        department: {
          select: {
            id: true,
            name: true,
          },
        },
        createdAt: true,
      },
      orderBy: {
        name: "asc",
      },
    });

    res.json(memoTypes);
  } catch (err) {
    console.error("getMemoTypesForLine error:", err);
    res.status(500).json({ error: "Failed to load memo types" });
  }
};

/* ───────────────── updateApproversForLine ───────────────── */

export const updateApproversForLine: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  if (!isAdminOrDcc(req)) {
    res.status(403).json({ error: "Only ADMIN/DCC can update approval lines" });
    return;
  }

  const lineId = Number(req.params.id);
  if (!Number.isFinite(lineId)) {
    res.status(400).json({ error: "Invalid line id" });
    return;
  }

  const { lineName, slots } = req.body || {};
  if (!Array.isArray(slots)) {
    res.status(400).json({ error: "slots must be an array" });
    return;
  }

  // Fetch old pivots before any changes for logging
  const oldPivots = await prisma.lineOfApprovalUserPivot.findMany({
    where: { lineOfApprovalId: lineId },
    include: {
      user: { select: { id: true, name: true, lastname: true, email: true } }
    },
    orderBy: [{ level: "asc" }, { id: "asc" }]
  });

  // Format old levels
  const oldLevelGroups = new Map<number, any[]>();
  oldPivots.forEach(p => {
    const list = oldLevelGroups.get(p.level) || [];
    list.push(p);
    oldLevelGroups.set(p.level, list);
  });

  const oldLevelDetails = Array.from(oldLevelGroups.entries())
    .sort(([a], [b]) => a - b)
    .map(([lvl, slots]) => {
      const approvers = slots.map(s => {
        const sigSuffix = s.isSigReq ? " (SigReq)" : " (NoSigReq)";
        if (s.slotType === 'FIXED_USER' && s.user) {
          const name = `${s.user.name} ${s.user.lastname || ""}`.trim() || s.user.email;
          return `${name}${sigSuffix}`;
        }
        return `${s.slotType}${sigSuffix}`;
      }).join(", ");
      return `Level ${lvl + 1}: ${approvers || "No Approvers"}`;
    });

  // normalize: ใช้ type ของ Prisma ตรง ๆ เพื่อไม่ให้ชน enum (slotType)
  const normalized: Prisma.LineOfApprovalUserPivotCreateManyInput[] = [];

  // Track approval requirements per level
  const approvalRequirementByLevel = new Map<number, ApprovalRequirement>();

  // 1 level มีได้ "placeholder slot" ได้แค่อันเดียว (FLEXIBLE_SLOT / MEMO_REQUESTER / DEPARTMENT_HEAD)
  const placeholderAtLevel = new Map<number, ApprovalSlotType>();
  const fixedAtLevel = new Set<number>();
  const seen = new Set<string>();

  for (const s of slots) {
    const level = Number(s?.level);
    if (!Number.isFinite(level) || level < 0) continue;

    const userIdRaw = s?.userId;
    const userId = userIdRaw == null ? null : Number(userIdRaw);

    const rawType = s?.slotType ?? null;
    const isSigReq = !!s?.isSigReq;
    
    // Handle approval requirement
    const rawApprovalReq = s?.approvalRequirement;
    const approvalRequirement: ApprovalRequirement = 
      rawApprovalReq === "ANY" ? "ANY" : "ALL"; // Default to ALL

    // Store approval requirement for this level
    const existingReq = approvalRequirementByLevel.get(level);
    if (existingReq && existingReq !== approvalRequirement) {
      res.status(400).json({
        error: `Level ${level}: All slots at the same level must have the same approval requirement`,
      });
      return;
    }
    approvalRequirementByLevel.set(level, approvalRequirement);

    // decide slotType (enum only)
    let slotType: ApprovalSlotType | null = null;
    if (isApprovalSlotType(rawType)) slotType = rawType;
    else if (userId != null) slotType = "FIXED_USER"; // FE ส่ง null มาในกรณี fixed user
    else continue; // ช่องว่างจริง ๆ

    // ---- placeholder types (no userId) ----
    if (slotType !== "FIXED_USER") {
      if (userId != null) {
        res.status(400).json({
          error: `Level ${level}: ${slotType} must not have userId`,
        });
        return;
      }

      if (fixedAtLevel.has(level)) {
        res.status(400).json({
          error: `Level ${level} already has FIXED_USER; cannot add ${slotType}`,
        });
        return;
      }

      const existing = placeholderAtLevel.get(level);
      if (existing && existing !== slotType) {
        res.status(400).json({
          error: `Level ${level} has multiple placeholder slots (${existing} and ${slotType})`,
        });
        return;
      }
      placeholderAtLevel.set(level, slotType);

      const key = `${slotType}|${level}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const roleDescription =
        typeof s?.roleDescription === "string" ? s.roleDescription.trim() : null;

      normalized.push({
        lineOfApprovalId: lineId,
        level,
        userId: null,
        slotType,
        isSigReq,
        roleDescription,
        approvalRequirement,
      });
      continue;
    }

    // ---- FIXED_USER ----
    if (userId == null) continue; // FIXED_USER แต่ไม่มี user ก็ข้าม

    if (placeholderAtLevel.has(level)) {
      res.status(400).json({
        error: `Level ${level} is ${placeholderAtLevel.get(
          level
        )}; cannot add FIXED_USER`,
      });
      return;
    }
    fixedAtLevel.add(level);

    const key = `${slotType}|${level}|${userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const roleDescription =
      typeof s?.roleDescription === "string" ? s.roleDescription.trim() : null;
    normalized.push({
      lineOfApprovalId: lineId,
      level,
      userId,
      slotType: "FIXED_USER",
      isSigReq,
      roleDescription,
      approvalRequirement,
    });
  }

  try {
    // 0) Fetch existing line info for logging (Create this block before transaction)
    const existingLine = await prisma.lineOfApproval.findUnique({
      where: { id: lineId },
      select: { name: true }
    });

    await prisma.$transaction(async (tx) => {
      // update name (ถ้ามีส่งมา)
      if (typeof lineName === "string" && lineName.trim()) {
        await tx.lineOfApproval.update({
          where: { id: lineId },
          data: { name: lineName.trim() },
        });
      }

      // replace pivots ทั้งชุดของ line นี้ (ง่าย+ชัวร์)
      await tx.lineOfApprovalUserPivot.deleteMany({
        where: { lineOfApprovalId: lineId },
      });

      if (normalized.length > 0) {
        await tx.lineOfApprovalUserPivot.createMany({
          data: normalized,
        });
      }
    });


    // Fetch user details for logging
    const userIds = normalized
      .map(s => s.userId)
      .filter((id): id is number => id !== null);
      
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, lastname: true, email: true }
    });

    const userMap = new Map(users.map(u => [u.id, u]));

    // Format log details
    const levelDetails = Array.from(approvalRequirementByLevel.entries())
      .sort(([a], [b]) => a - b)
      .map(([lvl, req]) => {
        // Find approvers at this level
        const approversAtLevel = normalized
          .filter(s => s.level === lvl && s.userId !== null)
          .map(s => {
            const u = userMap.get(s.userId!);
            const sigSuffix = s.isSigReq ? " (SigReq)" : " (NoSigReq)";
            const name = u ? `${u.name} ${u.lastname || ""}`.trim() || u.email : `User ID ${s.userId}`;
            return `${name}${sigSuffix}`;
          });
        
        // Add non-user slots (like placeholders)
        const placeholders = normalized
          .filter(s => s.level === lvl && s.slotType !== "FIXED_USER")
          .map(s => {
             const sigSuffix = s.isSigReq ? " (SigReq)" : " (NoSigReq)";
             return `${s.slotType}${sigSuffix}`;
          });

        const approversList = [...approversAtLevel, ...placeholders].join(", ");
        
        return `Level ${lvl + 1}: ${approversList || "No Approvers"}`;
      });

    const logPayload: any = {};

    // Check if levels changed
    const oldStr = oldLevelDetails.join("|");
    const newStr = levelDetails.join("|");
    if (oldStr !== newStr) {
      logPayload.old_levels = oldLevelDetails;
      logPayload.levels = levelDetails;
    }

    const newName = typeof lineName === "string" ? lineName.trim() : existingLine?.name;
    if (existingLine?.name !== newName) {
      logPayload.oldName = existingLine?.name;
      logPayload.newName = newName;
    }

    // Only log if something changed (or if it's considered an update action that should be logged regardless? 
    // Usually AdminLog should check if payload has data, but LOA_UPDATE_LEVEL implies something changed. 
    // If user clicked save without changes, maybe we shouldn't log? 
    // Let's check keys.
    if (Object.keys(logPayload).length > 0) {
      await createAdminLog(
        req.user!.id,
        "LOA_UPDATE_LEVEL",
        "LOA",
        lineId,
        newName || `Line ${lineId}`,
        logPayload
      );
    }

    res.json({ ok: true, saved: normalized.length });
  } catch (err) {
    console.error("updateApproversForLine error:", err);
    res.status(500).json({ error: "Failed to update approvers" });
  }
};
