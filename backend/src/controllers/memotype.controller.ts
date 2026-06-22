// src/controllers/memotype.controller.ts

import { RequestHandler, Response } from "express";
import { prisma } from "../../prisma/client";
import { AuthenticatedRequest } from "../types/request";
import fs from "fs";
import path from "path";
import { UPLOADS_DIR } from "../middlewares/upload"; // โปรเจ็กต์คุณมีอยู่แล้ว
import { safeFileName, decodeFilename } from "../lib/filename"; // โปรเจ็กต์คุณมีอยู่แล้ว
import { Prisma } from "@prisma/client";
import { createAdminLog } from "./adminLog.controller";
/**
 * GET /api/types
 */
const normalizeOptionalId = (raw: any): number | undefined => {
  if (raw === undefined || raw === null || raw === "" || raw === "null")
    return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

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

const parseBool = (v: any): boolean | undefined => {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return undefined; // ไม่ส่งมาก็ undefined
};
// ✅ เหลือแค่ 3 เงื่อนไขที่กำหนด
// ✅ เหลือแค่ 3 เงื่อนไขที่กำหนด + กรณี no-mode (false หมด)
// context: 'creation' = for memo creation page (use businessUnitAccess)
// context: 'management' = for memo type management page (use dccManagementAccess)
const buildVisibilityWhere = async (
  req: AuthenticatedRequest,
  includeInactive: boolean = false,
  context: 'creation' | 'management' = 'creation'
): Promise<Prisma.MemoTypeWhereInput> => {
  // Admin เห็นทั้งหมด (แต่ถ้าไม่ includeInactive ก็เห็นแค่ active)
  if (isAdmin(req)) {
    // Admin sees everything, including hidden types
    return includeInactive ? {} : { isActive: true };
  }


  // DCC เห็นเฉพาะ memo types ที่อยู่ใน BU/dept ของตัวเอง หรือ BU ที่ได้รับสิทธิ์
  // - context='creation': ใช้ businessUnitAccess (Additional Business Unit Access)
  // - context='management': ใช้ dccManagementAccess (DCC Management Business Units)
  if (isDcc(req)) {
    const dccUser = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { 
        businessUnitId: true, 
        departmentId: true,
        // Include both access types
        businessUnitAccess: {
          select: { businessUnitId: true }
        },
        dccManagementAccess: {
          select: { businessUnitId: true }
        }
      },
    });

    const dccBuId = dccUser?.businessUnitId ?? null;
    const dccDeptId = dccUser?.departmentId ?? null;
    
    // Determine which BUs to use based on context
    let accessibleBuIds: number[];
    
    if (context === 'management') {
      // For management pages: use primary BU + DCC management BUs
      const dccMgmtBuIds = (dccUser?.dccManagementAccess || []).map(a => a.businessUnitId);
      accessibleBuIds = dccBuId 
        ? [dccBuId, ...dccMgmtBuIds.filter(id => id !== dccBuId)]
        : dccMgmtBuIds;
    } else {
      // For creation pages: use primary BU + additional business unit access (NOT dccManagementAccess)
      const additionalBuIds = (dccUser?.businessUnitAccess || []).map(a => a.businessUnitId);
      accessibleBuIds = dccBuId 
        ? [dccBuId, ...additionalBuIds.filter(id => id !== dccBuId)]
        : additionalBuIds;
    }

    // Check if businessUnitId filter is provided in query
    const selectedBuId = req.query.businessUnitId 
      ? Number(req.query.businessUnitId) 
      : null;

    // If a specific BU is selected, validate it's in accessible list
    if (selectedBuId && accessibleBuIds.includes(selectedBuId)) {
      // Filter to only the selected BU
      // For creation context, exclude hidden types
      const hiddenFilter = context === 'creation' ? { isDelete: false } : {};
      
      return includeInactive 
        ? { businessUnitId: selectedBuId, ...hiddenFilter } 
        : { isActive: true, businessUnitId: selectedBuId, ...hiddenFilter };
    }

    // context='creation': DCC เห็นเหมือน USER (เช็คโหมด + BU + Dept ครบ)
    // context='management': DCC เห็นทุก memo type ใน accessible BUs (ต้องจัดการได้ทั้งหมด)
    if (context === 'creation') {
      const OR: Prisma.MemoTypeWhereInput[] = [
        // 1) ทุกคนเห็น
        { forEveryone: true },
      ];

      // 2) โหมด "ทุกแผนกภายใต้ BU ที่เลือก" → BU ต้องตรง
      if (accessibleBuIds.length > 0) {
        OR.push({
          AND: [
            { forAllDepartmentUnderSelectedBu: true },
            { businessUnitId: { in: accessibleBuIds } },
          ],
        });
      }

      // 3) โหมด "ทุก BU สำหรับแผนกที่เลือก" → Department ต้องตรง
      if (dccDeptId != null) {
        OR.push({
          AND: [{ forEveryDepartmentAcrossBU: true }, { departmentId: dccDeptId }],
        });
      }

      // 4) no-mode (สามธง false หมด) → Primary BU + Additional BU + Dept ต้องตรง (สำหรับหน้า Request Document)
      if (accessibleBuIds.length > 0 && dccDeptId != null) {
        OR.push({
          AND: [
            { forEveryone: false },
            { forEveryDepartmentAcrossBU: false },
            { forAllDepartmentUnderSelectedBu: false },
            { businessUnitId: { in: accessibleBuIds } },
            { departmentId: dccDeptId },
          ],
        });
      }

      return { isActive: true, isDelete: false, OR };
    }

    // context='management': DCC ต้องเห็นทุก memo type ใน accessible BUs เพื่อจัดการ
    const OR: Prisma.MemoTypeWhereInput[] = [];

    if (accessibleBuIds.length > 0) {
      OR.push({ businessUnitId: { in: accessibleBuIds } });
    }

    // DCC can see forEveryone memo types
    OR.push({ forEveryone: true });

    // If DCC has no BU/dept assigned, they can only see forEveryone types
    if (OR.length === 1) {
      return includeInactive ? { forEveryone: true } : { forEveryone: true, isActive: true };
    }

    return includeInactive ? { OR } : { isActive: true, OR };
  }

  // ไม่ล็อกอิน เห็นเฉพาะ forEveryone และ active และไม่ hidden
  if (!req.user?.id) {
    return { forEveryone: true, isActive: true, isDelete: false };
  }

  const me = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { 
      businessUnitId: true, 
      departmentId: true,
      // Include additional business unit access
      businessUnitAccess: {
        select: { businessUnitId: true }
      }
    },
  });

  const myBuId = me?.businessUnitId ?? null;
  const myDeptId = me?.departmentId ?? null;
  
  // Get all accessible business unit IDs (primary + additional)
  const additionalBuIds = (me?.businessUnitAccess || []).map(access => access.businessUnitId);
  const allAccessibleBuIds = myBuId 
    ? [myBuId, ...additionalBuIds.filter(id => id !== myBuId)]
    : additionalBuIds;

  const OR: Prisma.MemoTypeWhereInput[] = [
    // 1) ทุกคนเห็น
    { forEveryone: true },
  ];

  // 2) โหมด "ทุกแผนกภายใต้ BU ที่เลือก" → BU ต้องตรงกับ BU ที่ user เข้าถึงได้
  if (allAccessibleBuIds.length > 0) {
    OR.push({
      AND: [
        { forAllDepartmentUnderSelectedBu: true },
        { businessUnitId: { in: allAccessibleBuIds } },
      ],
    });
  }

  // 3) โหมด "ทุก BU สำหรับแผนกที่เลือก" → Department ต้องตรง
  if (myDeptId != null) {
    OR.push({
      AND: [{ forEveryDepartmentAcrossBU: true }, { departmentId: myDeptId }],
    });
  }

  // 4) 🔥 กรณี no-mode (สามธง false หมด) → Primary BU + Additional BU ต้องตรง และ Department ต้องตรงกับ user
  if (allAccessibleBuIds.length > 0 && myDeptId != null) {
    OR.push({
      AND: [
        { forEveryone: false },
        { forEveryDepartmentAcrossBU: false },
        { forAllDepartmentUnderSelectedBu: false },
        { businessUnitId: { in: allAccessibleBuIds } },
        { departmentId: myDeptId },
      ],
    });
  }

  // ถ้าอยากให้ user ปกติเห็นเฉพาะ isActive ด้วย ให้เปิดบรรทัดถัดไป:
  // สำหรับ creation context ให้กรอง hidden ออกด้วย
  const baseWhere = { isActive: true, OR };
  if (context === 'creation') {
    return { ...baseWhere, isDelete: false };
  }
  return baseWhere;

  // return { OR };
};

export const getAllMEMOTypes: RequestHandler = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    // Check if includeInactive query parameter is set (for management pages)
    const includeInactive = req.query.includeInactive === 'true';
    // Determine context: 'management' for memo type manager, 'creation' for memo creation
    const context = req.query.context === 'management' ? 'management' : 'creation';
    const where = await buildVisibilityWhere(req, includeInactive, context);

    const types = await prisma.memoType.findMany({
      where,
      select: {
        id: true,
        name: true,
        description: true,
        abbreviation: true,
        isActive: true,
        isDelete: true, // ✅
        createdAt: true,
        defaultTypeFileId: true,
        businessUnitId: true,
        approvalLineId: true,
        // flags
        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,

        // department สำหรับ FAC
        departmentId: true,
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        // Line of Approval information
        approvalLine: { 
          select: { 
            id: true, 
            name: true 
          } 
        },
        typeFiles: {
          // ⬅ ใช้ relation ใหม่
          select: {
            id: true,
            fileName: true,
            filePath: true,
            size: true,
            orderNo: true,
          },
          orderBy: { orderNo: "asc" },
        },
      },
      orderBy: { name: "asc" },
    });

    // Add approval levels for each type
    for (const type of types) {
      if (type.approvalLineId) {
        const pivots = await prisma.lineOfApprovalUserPivot.findMany({
          where: { lineOfApprovalId: type.approvalLineId },
          select: {
            id: true,
            level: true,
            isSigReq: true,
            slotType: true,
            roleDescription: true,
            approvalRequirement: true,
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
          },
        });

        const map: Record<number, any[]> = {};
        for (const p of pivots) {
          if (p.slotType === "FIXED_USER" && p.user) {
            (map[p.level] ||= []).push({
              id: p.user.id,
              loaUserPivotId: p.id,
              name: p.user.name,
              lastname: p.user.lastname,
              nickname: p.user.nickname,
              isSigReq: !!p.isSigReq,
              slotType: p.slotType,
              roleDescription: p.roleDescription,
              approvalRequirement: p.approvalRequirement,
            });
          } else if (p.slotType && p.slotType !== "FIXED_USER") {
            (map[p.level] ||= []).push({
              id: null,
              loaUserPivotId: p.id,
              name: null,
              lastname: null,
              nickname: null,
              displayName: p.roleDescription || p.slotType,
              isSigReq: !!p.isSigReq,
              slotType: p.slotType,
              roleDescription: p.roleDescription,
              approvalRequirement: p.approvalRequirement,
            });
          }
        }

        (type as any).approvalLevels = Object.keys(map)
          .map((k) => ({ level: Number(k), users: map[Number(k)] }))
          .sort((a, b) => a.level - b.level);
      }
    }

    res.json(types);
  } catch (err) {
    console.error("getAllMEMOTypes error:", err);
    res.status(500).json({ error: "Failed to fetch types" });
  }
};

/**
 * GET /api/types/:id
 */
// src/controllers/memotype.controller.ts

export const getMEMOTypeById: RequestHandler = async (req, res: Response) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid type ID" });
    return;
  }

  try {
    // For getMEMOTypeById, use 'creation' context as this is typically used when creating/viewing a memo
    const context = (req.query.context === 'management' ? 'management' : 'creation') as 'creation' | 'management';
    const includeDeleted = req.query.includeDeleted === 'true';

    let visibilityWhere = await buildVisibilityWhere(
      req as AuthenticatedRequest,
      false,
      context
    );

    if (includeDeleted) {
      // Remove the strict isDelete and isActive constraints completely
      // to allow the user to load the "archived" type's data and files.
      // 1) Keep the structural authorization logic (BU/Dept/forEveryone paths) untouched
      // 2) Strip 'isActive' and 'isDelete' filters from the top-level
      const { isActive, isDelete, ...restWhere } = visibilityWhere as any;
      visibilityWhere = restWhere;
    }

    // ดึงเฉพาะเมื่อผู้ใช้มีสิทธิ์เห็น
    const type = await prisma.memoType.findFirst({
      where: { AND: [{ id }, visibilityWhere] },
      select: {
        id: true,
        name: true,
        description: true,
        abbreviation: true,
        isActive: true,
        isDelete: true, // ✅
        createdAt: true,
        updatedAt: true,
        defaultTypeFileId: true,
        businessUnitId: true,
        approvalLineId: true,

        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        // Line of Approval information
        approvalLine: { 
          select: { 
            id: true, 
            name: true 
          } 
        },
        typeFiles: {
          // ⬅ ใช้ TypeFile
          select: {
            id: true,
            fileName: true,
            filePath: true,
            size: true,
            orderNo: true,
          },
          orderBy: { orderNo: "asc" },
        },
      },
    });

    if (!type) {
      // ไม่เจอเพราะไม่มีสิทธิ์หรือไม่มีข้อมูล
      res
        .status(403)
        .json({ error: "You do not have permission to view this type" });
      return;
    }

    // โหลด users ของ approval line แล้วจัดกลุ่มเป็น levels
    if (type.approvalLineId) {
      const pivots = await prisma.lineOfApprovalUserPivot.findMany({
        where: { lineOfApprovalId: type.approvalLineId },
        select: {
          id: true, // ✅ pivot id สำหรับ templatePivotId
          level: true,
          isSigReq: true,
          slotType: true,
          roleDescription: true,
          approvalRequirement: true,
          user: {
            select: { id: true, name: true, lastname: true, nickname: true },
          },
        },
      });

      const map: Record<number, any[]> = {};
      for (const p of pivots) {
        if (p.slotType === "FIXED_USER" && p.user) {
          (map[p.level] ||= []).push({
            id: p.user.id, // user id
            loaUserPivotId: p.id, // ✅ pivot id สำหรับ templatePivotId
            name: p.user.name,
            lastname: p.user.lastname,
            nickname: p.user.nickname,
            isSigReq: !!p.isSigReq,
            slotType: p.slotType,
            roleDescription: p.roleDescription,
            approvalRequirement: p.approvalRequirement,
          });
        } else if (p.slotType && p.slotType !== "FIXED_USER") {
          (map[p.level] ||= []).push({
            id: null,
            loaUserPivotId: p.id, // ✅ pivot id สำหรับ templatePivotId
            name: null,
            lastname: null,
            nickname: null,
            displayName: p.roleDescription || p.slotType,
            isSigReq: !!p.isSigReq,
            slotType: p.slotType,
            roleDescription: p.roleDescription,
            approvalRequirement: p.approvalRequirement,
          });
        }
      }

      (type as any).approvalLevels = Object.keys(map)
        .map((k) => ({ level: Number(k), users: map[Number(k)] }))
        .sort((a, b) => a.level - b.level);
    }

    res.json(type);
  } catch (err) {
    console.error("getTypeById error:", err);
    res.status(500).json({ error: "Failed to fetch type" });
  }
};

export const createMEMOType = async (
  req: AuthenticatedRequest,
  res: Response
): Promise<void> => {
  const body = (req.body ?? {}) as any;
  if ("id" in body) delete (body as any).id;

  const name = body.name?.toString?.() ?? "";
  const description = body.description?.toString?.() ?? "";
  const abbreviation = body.abbreviation?.toString?.() ?? "";
  const isActiveRaw = body.isActive;

  // optional
  const buIdNorm = normalizeOptionalId(body.businessUnitId);
  const depIdNorm = normalizeOptionalId(body.departmentId);

  // flags
  const fe = parseBool(body.forEveryone) ?? false;
  const fac = parseBool(body.forEveryDepartmentAcrossBU) ?? false;
  const fbu = parseBool(body.forAllDepartmentUnderSelectedBu) ?? false;

  // Check if this is a duplication request
  const duplicateFromId = normalizeOptionalId(body.duplicateFromId);

  // เลือกได้แค่ 1 โหมด (อนุญาตให้เป็น 0 โหมดได้)
  const numTrue = [fe, fac, fbu].filter(Boolean).length;
  if (numTrue > 1) {
    res.status(400).json({
      error:
        "Only one of {forEveryone, forEveryDepartmentAcrossBU, forAllDepartmentUnderSelectedBu} can be true",
    });
    return;
  }
  const isNoMode = numTrue === 0;

  // บังคับพารามิเตอร์ตามโหมด
  // Business Unit is always required (except for forEveryone mode)
  if (!fe && buIdNorm == null) {
    res.status(400).json({
      error: "businessUnitId is required",
    });
    return;
  }
  
  // Department is required when forEveryDepartmentAcrossBU is true
  if (fac && depIdNorm == null) {
    res.status(400).json({
      error: "departmentId is required when forEveryDepartmentAcrossBU is true",
    });
    return;
  }
  
  // Department is required when forAllDepartmentUnderSelectedBu is false (no mode)
  if (isNoMode && depIdNorm == null) {
    res.status(400).json({
      error: "departmentId is required when forAllDepartmentUnderSelectedBu is false",
    });
    return;
  }

  // ตรวจ dept ถ้าส่งมา
  if (depIdNorm != null) {
    const dep = await prisma.department.findUnique({
      where: { id: depIdNorm },
      select: { id: true },
    });
    if (!dep) {
      res.status(400).json({ error: "Department not found" });
      return;
    }
  }

  // คำนวณ BU ที่จะเขียนจริง ๆ ตามโหมด
  // - FE  → businessUnitId = null
  // - FAC → ไม่เขียน BU (ปล่อยเป็น null โดยปริยาย)
  // - FBU → businessUnitId = buIdNorm (ต้องมี)
  // - NO  → businessUnitId = buIdNorm (ต้องมี)
  const buToWrite = fe
    ? null
    : fbu
    ? (buIdNorm as number)
    : isNoMode
    ? (buIdNorm as number)
    : undefined; // FAC ⇒ undefined (จะไม่ใส่ฟิลด์ลง data)

  // ⚠️ default file feature disabled - field removed from schema
  // const defaultTypeFileIdRaw = body.defaultTypeFileId; // "123" | "first"
  // const defaultTypeFileIndexRaw = body.defaultTypeFileIndex; // "0","1",...

  if (!name || !description) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }
  if (!req.user?.id) {
    res.status(403).json({ error: "Missing user in token" });
    return;
  }

  try {
    // ===== BU (optional) — validate ถ้าส่งมา =====
    if (buIdNorm !== undefined) {
      const bu = await prisma.businessUnit.findUnique({
        where: { id: buIdNorm },
        select: { id: true },
      });
      if (!bu) {
        res.status(400).json({ error: "Business Unit not found" });
        return;
      }
    }

    // parse isActive
    const isActive =
      typeof isActiveRaw === "boolean"
        ? isActiveRaw
        : typeof isActiveRaw === "string"
        ? isActiveRaw === "true"
        : undefined;

    // parse isDelete
    const isDeleteRaw = (req.body as any).isDelete; // ✅ Define isDeleteRaw
    const isDelete =
      typeof isDeleteRaw === "boolean"
        ? isDeleteRaw
        : typeof isDeleteRaw === "string"
        ? isDeleteRaw === "true"
        : false; // default false


    // ====== อ่าน payload line จาก FE ======
    type ApprovalLevelPayload = {
      name?: string;
      approvalRequirement?: "ALL" | "ANY";
      users: {
        id?: number;
        isSigReq?: boolean;
        slotType?:
          | "FIXED_USER"
          | "DEPARTMENT_HEAD"
          | "MEMO_REQUESTER"
          | "FLEXIBLE_SLOT";
        roleDescription?: string;
        approvalRequirement?: "ALL" | "ANY";
      }[];
    };

    const wantLineUsers =
      String((req.body as any).createApprovalLine ?? "").toLowerCase() ===
      "true";

    let levels: ApprovalLevelPayload[] = [];
    if (wantLineUsers) {
      let raw = (req.body as any).approvalLevels as
        | string
        | string[]
        | undefined;
      if (Array.isArray(raw)) raw = raw[0]; // กันกรณีมาเป็น array
      if (typeof raw === "string" && raw.trim() !== "") {
        try {
          levels = JSON.parse(raw);
        } catch {
          res.status(400).json({ error: "Invalid JSON in approvalLevels" });
          return;
        }
      }
    }

    // ===== สร้าง Type + Line + Users และผูกกันภายในทรานแซคชัน =====
    const { createdType } = await prisma.$transaction(async (tx) => {
      // 1) สร้าง type
      const t = await tx.memoType.create({
        data: {
          name,
          description,
          abbreviation,
          createdByUserId: req.user!.id,

          ...(isActive !== undefined ? { isActive } : {}),
          isDelete, // ✅

          // ✅ เขียนค่า BU ตามโหมด
          ...(buToWrite !== undefined ? { businessUnitId: buToWrite } : {}),

          // ✅ departmentId: save if provided (for FAC, FBU with dept, or NO mode)
          departmentId: depIdNorm ?? null,

          // ✅ flags
          forEveryone: fe,
          forEveryDepartmentAcrossBU: fac,
          forAllDepartmentUnderSelectedBu: fbu,
        },
        select: {
          id: true,
          name: true,
          description: true,
          abbreviation: true,
          isActive: true,
          isDelete: true, // ✅
          createdAt: true,
          updatedAt: true,
          createdByUserId: true,
          defaultTypeFileId: true,
          departmentId: true,
          department: { select: { id: true, name: true } },
          businessUnit: { select: { id: true, name: true } },
        },
      });

      // 2) สร้าง line ชื่อเดียวกัน
      const line = await tx.lineOfApproval.create({
        data: {
          name,
          userId: req.user!.id,
          // FE/FAC ⇒ null, FBU/NO ⇒ ใช้ buToWrite
          businessUnitId: buToWrite ?? null,
        },
        select: { id: true },
      });

      // 2.1) ถ้ามี payload ผู้อนุมัติ → สร้างแถวลง pivot
      if (wantLineUsers && Array.isArray(levels) && levels.length > 0) {
        // กัน user ซ้ำใน level เดียวกัน (เฉพาะ FIXED_USER) - อนุญาตให้ซ้ำข้าม level ได้
        // Also validate that FIXED_USER slots have valid user IDs
        for (let lvIdx = 0; lvIdx < levels.length; lvIdx++) {
          const lv = levels[lvIdx];
          const seenInLevel = new Set<number>();
          for (const u of (lv.users ?? [])) {
            if (u.slotType === "FIXED_USER") {
              if (!u.id) {
                throw new Error(`FIXED_USER slot at Level ${lvIdx + 1} requires a valid user ID`);
              }
              const id = Number(u.id);
              if (!Number.isFinite(id) || id <= 0) {
                throw new Error(`Invalid user ID at Level ${lvIdx + 1}`);
              }
              if (seenInLevel.has(id)) {
                throw new Error(`Duplicate approver at the same level (Level ${lvIdx + 1})`);
              }
              seenInLevel.add(id);
            }
          }
        }

        const rows: Prisma.LineOfApprovalUserPivotCreateManyInput[] = [];
        levels.forEach((lv, lvIdx) => {
          (lv.users || []).forEach((u) => {
            // Safely parse userId - ensure it's a valid number or null
            let userId: number | null = null;
            if (u.slotType === "FIXED_USER" && u.id !== undefined && u.id !== null) {
              const parsedId = Number(u.id);
              if (Number.isFinite(parsedId) && parsedId > 0) {
                userId = parsedId;
              }
            }

            rows.push({
              lineOfApprovalId: line.id,
              userId,
              level: lvIdx,
              isSigReq: !!u.isSigReq,
              slotType: u.slotType || "FIXED_USER",
              roleDescription: u.roleDescription || null,
              approvalRequirement: u.approvalRequirement || lv.approvalRequirement || "ALL",
            });
          });
        });

        if (rows.length > 0) {
          await tx.lineOfApprovalUserPivot.createMany({ data: rows });
        }
      }

      // 3) ผูกกลับที่ type.approvalLineId
      await tx.memoType.update({
        where: { id: t.id },
        data: { approvalLineId: line.id },
      });

      return { createdType: t };
    });

    // ===== ATTACH FILES (optional) =====
    const files = (req.files as Express.Multer.File[]) || [];
    let createdFiles: { id: number; orderNo: number }[] = [];

    // Handle file duplication if this is a duplicate request
    if (duplicateFromId) {
      const originalFiles = await prisma.typeFile.findMany({
        where: { memoTypeId: duplicateFromId },
        orderBy: { orderNo: "asc" },
        select: {
          id: true,
          fileName: true,
          filePath: true,
          size: true,
          orderNo: true,
        },
      });

      if (originalFiles.length > 0) {
        const typeDir = path.join(UPLOADS_DIR, "types");
        fs.mkdirSync(typeDir, { recursive: true });

        for (let idx = 0; idx < originalFiles.length; idx++) {
          const originalFile = originalFiles[idx];
          try {
            // Read the original file
            const originalPath = path.join(UPLOADS_DIR, originalFile.filePath.replace(/^\/uploads\//, ""));
            if (fs.existsSync(originalPath)) {
              const fileBuffer = fs.readFileSync(originalPath);
              
              // Create new filename for the duplicated file
              const timestamp = Date.now();
              const originalName = originalFile.fileName;
              const ext = path.extname(originalName);
              const baseName = path.basename(originalName, ext);
              const newFileName = `${timestamp}_${idx}_${baseName}_copy${ext}`;
              
              // Write the duplicated file
              const newFilePath = path.join(typeDir, newFileName);
              fs.writeFileSync(newFilePath, fileBuffer);

              // Create database record for the duplicated file
              const created = await prisma.typeFile.create({
                data: {
                  memoTypeId: createdType.id,
                  filePath: `/uploads/types/${newFileName}`,
                  fileName: originalName, // Keep original filename for display
                  size: originalFile.size,
                  orderNo: idx,
                },
                select: { id: true, orderNo: true },
              });
              createdFiles.push(created);
            }
          } catch (error) {
            console.error(`Failed to duplicate file ${originalFile.fileName}:`, error);
            // Continue with other files even if one fails
          }
        }
      }
    }

    // Handle new uploaded files (in addition to duplicated files)
    if (files.length > 0) {
      const typeDir = path.join(UPLOADS_DIR, "types");
      fs.mkdirSync(typeDir, { recursive: true });

      const startOrder = createdFiles.length; // Start after duplicated files

      for (let idx = 0; idx < files.length; idx++) {
        const f = files[idx];
        const original = safeFileName(decodeFilename(f.originalname || `file_${idx}`));
        const base = `${Date.now()}_${idx}_${original}`;
        fs.writeFileSync(path.join(typeDir, base), f.buffer);

        const created = await prisma.typeFile.create({
          data: {
            memoTypeId: createdType.id,
            filePath: `/uploads/types/${base}`,
            fileName: decodeFilename(f.originalname || `file_${idx}`),
            size: f.size ?? 0,
            orderNo: startOrder + idx,
          },
          select: { id: true, orderNo: true },
        });
        createdFiles.push(created);
      }
    }

    // ⚠️ Default file feature disabled - field removed from schema
    // let defaultIdToSet: number | null = null;
    // ... (defaultTypeFileId logic removed)

    // โหลดกลับพร้อม mainFiles + default + approvalLineId (+ department)
    const full = await prisma.memoType.findUnique({
      where: { id: createdType.id },
      select: {
        id: true,
        name: true,
        description: true,
        abbreviation: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        createdByUserId: true,
        defaultTypeFileId: true,
        approvalLineId: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        // Line of Approval information
        approvalLine: { 
          select: { 
            id: true, 
            name: true 
          } 
        },
        typeFiles: {
          // ⬅
          select: {
            id: true,
            fileName: true,
            filePath: true,
            size: true,
            orderNo: true,
          },
          orderBy: { orderNo: "asc" },
        },
      },
    });

    res.status(201).json(full);

    // Build levels info for logging
    const levelLines: string[] = [];
    if (wantLineUsers && levels.length > 0) {
      // Fetch user names
      const allUserIds = levels
        .flatMap(lv => lv.users || [])
        .filter(u => u.slotType === "FIXED_USER" && u.id)
        .map(u => Number(u.id));
      
      const users = allUserIds.length > 0 
        ? await prisma.user.findMany({
            where: { id: { in: allUserIds } },
            select: { id: true, name: true, lastname: true }
          })
        : [];
      
      const userMap = new Map(users.map(u => [u.id, `${u.name} ${u.lastname || ""}`.trim()]));
      
      levels.forEach((lv, idx) => {
        const approverNames = (lv.users || []).map(u => {
          let userName: string;
          if (u.slotType === "FIXED_USER" && u.id) {
            userName = userMap.get(Number(u.id)) || `User ID: ${u.id}`;
          } else {
            userName = "FLEXIBLE_SLOT";
          }
          const sig = u.isSigReq ? "SigReq" : "NoSigReq";
          return `${userName} (${sig})`;
        });
        levelLines.push(`Level ${idx + 1}: ${approverNames.join(", ")}`);
      });
    }

    // Log Create
    await createAdminLog(
      req.user!.id,
      "MEMO_TYPE_CREATE",
      "MEMO_TYPE",
      full?.id ?? 0,
      full?.name ?? name,
      {
        name,
        abbreviation,
        description,
        businessUnit: (full as any)?.businessUnit?.name ?? null,
        department: (full as any)?.department?.name ?? null,
        forEveryone: fe,
        forEveryDepartmentAcrossBU: fac,
        forAllDepartmentUnderSelectedBu: fbu,
        isDelete,
        duplicatedFrom: duplicateFromId ?? null,
        levels: levelLines.length > 0 ? levelLines : null,
      }
    );
  } catch (err: any) {
    console.error("❌ createMEMOType error:", err);
    console.error("❌ Error message:", err?.message);
    console.error("❌ Error code:", err?.code);
    console.error("❌ Error meta:", err?.meta);
    
    // Return more specific error messages for known error types
    if (err?.message?.includes("Duplicate approver")) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err?.message?.includes("FIXED_USER slot")) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err?.message?.includes("Invalid user ID")) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err?.code === "P2002") {
      res.status(400).json({ error: "A unique constraint was violated. Please check your data." });
      return;
    }
    if (err?.code === "P2003") {
      res.status(400).json({ error: "A foreign key constraint was violated. Please check referenced data exists." });
      return;
    }
    
    res.status(500).json({ 
      error: "Failed to create type",
      details: process.env.NODE_ENV === 'development' ? err?.message : undefined
    });
  }
};

/* ========= UPDATE ========= */
export const updateMEMOType: RequestHandler = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  const id = Number(req.params.id);
  const body = (req.body ?? {}) as any;

  const name = body.name?.toString?.() ?? "";
  const description = body.description?.toString?.() ?? "";
  const abbreviation = body.abbreviation?.toString?.() ?? "";
  const isActiveRaw = body.isActive;
  const isDeleteRaw = body.isDelete; // ✅

  const buIdNorm = normalizeOptionalId(body.businessUnitId);
  const depIdNorm = normalizeOptionalId(body.departmentId);

  // ⚠️ Default file feature disabled - field removed from schema
  // let defaultTypeFileIdRaw: any = body.defaultTypeFileId ?? body.defaultMainFileId;
  // let defaultTypeFileIndexRaw: any = body.defaultTypeFileIndex ?? body.defaultMainFileIndex;

  if (!Number.isFinite(id) || !name || !description) {
    res.status(400).json({ error: "Invalid data" });
    return;
  }

  try {
    const existing = await prisma.memoType.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        abbreviation: true,
        description: true,
        isActive: true,
        isDelete: true, // ✅
        approvalLineId: true,
        businessUnitId: true,
        businessUnit: { select: { name: true } },
        departmentId: true,
        department: { select: { name: true } },
        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,
        createdByUserId: true,
      },
    });
    if (!existing) {
      res.status(404).json({ error: "Type not found" });
      return;
    }

    const canManageAll = isAdminOrDcc(req);
    if (!canManageAll && existing.createdByUserId !== req.user?.id) {
      res.status(403).json({ error: "You cannot modify this type." });
      return;
    }

    // ❗ ถ้า type นี้ยังไม่มี approvalLineId เลย → ไม่ให้ update line ต่อนะ
    if (!existing.approvalLineId) {
      res.status(400).json({
        error:
          "This document type has no approval line assigned yet. Please create or attach an approval line first.",
      });
      return;
    }

    const updateData: any = {
      name,
      description,
      abbreviation: abbreviation ?? "",
      updatedAt: new Date(),
    };

    // Variables for logging (not passed to Prisma)
    let newBuName: string | null = null;
    let newDeptName: string | null = null;

    // isDelete
    if (typeof isDeleteRaw === "boolean") updateData.isDelete = isDeleteRaw;
    if (typeof isDeleteRaw === "string")
      updateData.isDelete = isDeleteRaw === "true";

    // isActive
    if (typeof isActiveRaw === "boolean") updateData.isActive = isActiveRaw;
    if (typeof isActiveRaw === "string")
      updateData.isActive = isActiveRaw === "true";

    // ⛔ Prevent modifying isActive if the type is deleted (and not being restored)
    if (existing.isDelete && updateData.isDelete !== false) {
      if (updateData.isActive !== undefined && updateData.isActive !== existing.isActive) {
        res.status(400).json({ error: "Cannot change active status of a deleted memo type." });
        return;
      }
    }


    /* ---------- BU (optional) ---------- */
    const hasBUKey = Object.prototype.hasOwnProperty.call(
      body,
      "businessUnitId"
    );
    if (hasBUKey) {
      if (buIdNorm == null) {
        updateData.businessUnitId = null;
      } else {
        const buExists = await prisma.businessUnit.findUnique({
          where: { id: buIdNorm },
          select: { id: true, name: true },
        });
        if (!buExists) {
          res.status(400).json({ error: "Business Unit not found" });
          return;
        }
        updateData.businessUnitId = buIdNorm;
        newBuName = buExists.name; // for logging
      }
    }

    /* ---------- Department (optional) ---------- */
    const hasDeptKey = Object.prototype.hasOwnProperty.call(
      body,
      "departmentId"
    );
    if (hasDeptKey) {
      if (depIdNorm == null) {
        updateData.departmentId = null;
      } else {
        const depExists = await prisma.department.findUnique({
          where: { id: depIdNorm },
          select: { id: true, name: true },
        });
        if (!depExists) {
          res.status(400).json({ error: "Department not found" });
          return;
        }
        updateData.departmentId = depIdNorm;
        newDeptName = depExists.name; // for logging
      }
    }

    /* ---------- Flags + validation (mutual exclusive, allow 0) ---------- */
    const hasFEKey = Object.prototype.hasOwnProperty.call(body, "forEveryone");
    const hasFACKey = Object.prototype.hasOwnProperty.call(
      body,
      "forEveryDepartmentAcrossBU"
    );
    const hasFBUKey = Object.prototype.hasOwnProperty.call(
      body,
      "forAllDepartmentUnderSelectedBu"
    );

    const feInput = hasFEKey ? parseBool(body.forEveryone) : undefined;
    const facInput = hasFACKey
      ? parseBool(body.forEveryDepartmentAcrossBU)
      : undefined;
    const fbuInput = hasFBUKey
      ? parseBool(body.forAllDepartmentUnderSelectedBu)
      : undefined;

    const inputTrueCount = [feInput, facInput, fbuInput].filter(
      (v) => v === true
    ).length;
    if (inputTrueCount > 1) {
      res.status(400).json({
        error:
          "Only one of {forEveryone, forEveryDepartmentAcrossBU, forAllDepartmentUnderSelectedBu} can be true",
      });
      return;
    }

    let finalFE = existing.forEveryone;
    let finalFAC = existing.forEveryDepartmentAcrossBU;
    let finalFBU = existing.forAllDepartmentUnderSelectedBu;

    if (feInput !== undefined) finalFE = feInput;
    if (facInput !== undefined) finalFAC = facInput;
    if (fbuInput !== undefined) finalFBU = fbuInput;

    if (finalFE === true) {
      finalFAC = false;
      finalFBU = false;
    } else if (finalFAC === true) {
      finalFE = false;
      finalFBU = false;
    } else if (finalFBU === true) {
      finalFE = false;
      finalFAC = false;
    }

    updateData.forEveryone = finalFE;
    updateData.forEveryDepartmentAcrossBU = finalFAC;
    updateData.forAllDepartmentUnderSelectedBu = finalFBU;

    const buWillBe = hasBUKey
      ? buIdNorm ?? null
      : existing.businessUnitId ?? null;
    const deptWillBe = hasDeptKey
      ? depIdNorm ?? null
      : existing.departmentId ?? null;

    const isNoModeFinal = !finalFE && !finalFAC && !finalFBU;

    // Business Unit is always required (except for forEveryone mode)
    if (!finalFE && buWillBe == null) {
      res.status(400).json({
        error: "businessUnitId is required",
      });
      return;
    }
    
    // Department is required when forEveryDepartmentAcrossBU is true
    if (finalFAC === true && deptWillBe == null) {
      res.status(400).json({
        error:
          "departmentId is required when forEveryDepartmentAcrossBU is true",
      });
      return;
    }
    
    // Department is required when forAllDepartmentUnderSelectedBu is false (no mode)
    if (isNoModeFinal && deptWillBe == null) {
      res.status(400).json({
        error: "departmentId is required when forAllDepartmentUnderSelectedBu is false",
      });
      return;
    }

    if (finalFE) {
      updateData.businessUnitId = null;
      updateData.departmentId = null;
    } else {
      // For all other modes, save both BU and Department (dept can be null for FBU mode)
      updateData.businessUnitId = buWillBe;
      updateData.departmentId = deptWillBe;
    }

    /* ---------- อ่าน payload การแก้ไข approval line ---------- */
    const wantUpdateApproval =
      String(body.updateApprovalLine ?? "").toLowerCase() === "true" ||
      typeof body.approvalLevels !== "undefined";

    type ApprovalLevelPayload = {
      level?: number;
      approvalRequirement?: "ALL" | "ANY";
      users: {
        id?: number;
        isSigReq?: boolean;
        slotType?:
          | "FIXED_USER"
          | "DEPARTMENT_HEAD"
          | "MEMO_REQUESTER"
          | "FLEXIBLE_SLOT";
        roleDescription?: string;
        approvalRequirement?: "ALL" | "ANY";
      }[];
    };

    let levels: ApprovalLevelPayload[] = [];
    if (wantUpdateApproval) {
      let raw = body.approvalLevels as string | string[] | undefined;
      if (Array.isArray(raw)) raw = raw[0];
      if (typeof raw === "string" && raw.trim() !== "") {
        try {
          levels = JSON.parse(raw);
        } catch {
          res.status(400).json({ error: "Invalid JSON in approvalLevels" });
          return;
        }
      } else {
        res.status(400).json({ error: "approvalLevels is required" });
        return;
      }

      // Check for duplicate approvers at the SAME level only (allow same user at different levels)
      for (let i = 0; i < levels.length; i++) {
        const lv = levels[i];
        if ((lv.users?.length ?? 0) === 0) {
          res
            .status(400)
            .json({ error: `Level ${i + 1} must have at least one approver` });
          return;
        }
        const seenInLevel = new Set<number>();
        for (const u of lv.users) {
          if (u.slotType === "FIXED_USER" && u.id) {
            const uid = Number(u.id);
            if (seenInLevel.has(uid)) {
              res
                .status(400)
                .json({ error: `Duplicate approver at the same level (Level ${i + 1})` });
              return;
            }
            seenInLevel.add(uid);
          }
        }
      }
    }

    // Fetch old LOA for comparison (before making changes)
    let oldLoaDetails: Record<string, string> = {};
    if (wantUpdateApproval && existing.approvalLineId) {
      const oldPivots = await prisma.lineOfApprovalUserPivot.findMany({
        where: { lineOfApprovalId: existing.approvalLineId },
        include: {
          user: { select: { id: true, name: true, lastname: true } }
        },
        orderBy: { level: "asc" }
      });
      
      // Group by level
      const levelGroups: Record<number, typeof oldPivots> = {};
      for (const p of oldPivots) {
        const lvl = p.level ?? 0;
        if (!levelGroups[lvl]) levelGroups[lvl] = [];
        levelGroups[lvl].push(p);
      }
      
      Object.entries(levelGroups).forEach(([lvl, pivots]) => {
        const names = pivots.map(p => {
          let userName: string;
          if (p.slotType === "FIXED_USER" && p.user) {
            userName = `${p.user.name} ${p.user.lastname || ""}`.trim();
          } else {
            userName = "FLEXIBLE_SLOT";
          }
          const sig = p.isSigReq ? "SigReq" : "NoSigReq";
          return `${userName} (${sig})`;
        });
        oldLoaDetails[`Level ${Number(lvl) + 1}`] = names.join(", ");
      });
    }

    /* ---------- ทำในทรานแซคชัน: อัปเดต type + line (ไม่สร้าง line ใหม่แล้ว) ---------- */
    const updatedType = await prisma.$transaction(async (tx) => {
      const updated = await tx.memoType.update({
        where: { id },
        data: updateData,
        select: {
          id: true,
          name: true,
          description: true,
          abbreviation: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          defaultTypeFileId: true,
          approvalLineId: true,
          businessUnitId: true,
          departmentId: true,
          department: { select: { id: true, name: true } },
          forEveryone: true,
          forEveryDepartmentAcrossBU: true,
          forAllDepartmentUnderSelectedBu: true,
        },
      });

      const lineId = existing.approvalLineId!; // เรารู้อยู่แล้วว่าไม่ null ด้านบน

      const buFinalForLine =
        finalFE || finalFAC
          ? null
          : updateData.businessUnitId ?? existing.businessUnitId ?? null;

      // ✅ อัปเดต line เดิมเท่านั้น
      await tx.lineOfApproval.update({
        where: { id: lineId },
        data: {
          name: updated.name,
          businessUnitId: buFinalForLine,
        },
      });

      // ถ้าขออัปเดต approvalLevels → rewrite pivots ของ line เดิม
      if (wantUpdateApproval) {
        await tx.lineOfApprovalUserPivot.deleteMany({
          where: { lineOfApprovalId: lineId },
        });

      const rows = levels.flatMap((lv, lvIdx) =>
          (lv.users || []).map((u) => ({
            lineOfApprovalId: lineId,
            userId: u.slotType === "FIXED_USER" ? Number(u.id) : null,
            level:
              typeof lv.level === "number" && Number.isFinite(lv.level)
                ? Number(lv.level)
                : lvIdx,
            isSigReq: !!u.isSigReq,
            slotType: u.slotType || "FIXED_USER",
            roleDescription: u.roleDescription || null,
            approvalRequirement: u.approvalRequirement || lv.approvalRequirement || "ALL",
          }))
        );

        if (rows.length > 0) {
          await tx.lineOfApprovalUserPivot.createMany({ data: rows });
        }
      }

      return updated;
    });

    // ===== HANDLE FILE UPLOADS =====
    const uploadedFiles = (req.files as Express.Multer.File[]) || [];
    if (uploadedFiles.length > 0) {
      const typeDir = path.join(UPLOADS_DIR, "types");
      fs.mkdirSync(typeDir, { recursive: true });

      // Get current max orderNo for existing files
      const existingTypeFiles = await prisma.typeFile.findMany({
        where: { memoTypeId: id },
        select: { orderNo: true },
        orderBy: { orderNo: "desc" },
        take: 1,
      });
      const startOrder = existingTypeFiles.length > 0 ? existingTypeFiles[0].orderNo + 1 : 0;

      const createdFiles: { id: number; orderNo: number }[] = [];
      for (let idx = 0; idx < uploadedFiles.length; idx++) {
        const f = uploadedFiles[idx];
        const original = safeFileName(decodeFilename(f.originalname || `file_${idx}`));
        const base = `${Date.now()}_${idx}_${original}`;
        fs.writeFileSync(path.join(typeDir, base), f.buffer);

        const created = await prisma.typeFile.create({
          data: {
            memoTypeId: id,
            filePath: `/uploads/types/${base}`,
            fileName: decodeFilename(f.originalname || `file_${idx}`),
            size: f.size ?? 0,
            orderNo: startOrder + idx,
          },
          select: { id: true, orderNo: true },
        });
        createdFiles.push(created);
      }

      // Handle defaultTypeFileId: new file index or existing file id
      const defaultMainFileIndexRaw = body.defaultMainFileIndex;
      const defaultTypeFileIdRaw = body.defaultTypeFileId;

      let defaultIdToSet: number | null | undefined = undefined;
      if (defaultMainFileIndexRaw !== undefined && defaultMainFileIndexRaw !== "") {
        const idx = Number(defaultMainFileIndexRaw);
        if (Number.isFinite(idx) && idx >= 0 && idx < createdFiles.length) {
          defaultIdToSet = createdFiles[idx].id;
        }
      } else if (defaultTypeFileIdRaw !== undefined && defaultTypeFileIdRaw !== "") {
        const typeFileId = Number(defaultTypeFileIdRaw);
        if (Number.isFinite(typeFileId) && typeFileId > 0) {
          defaultIdToSet = typeFileId;
        } else if (defaultTypeFileIdRaw === "" || typeFileId === 0) {
          defaultIdToSet = null;
        }
      }

      if (defaultIdToSet !== undefined) {
        await prisma.memoType.update({
          where: { id },
          data: { defaultTypeFileId: defaultIdToSet },
        });
      }
    } else {
      // No new files uploaded — still handle defaultTypeFileId change for existing files
      const defaultTypeFileIdRaw = body.defaultTypeFileId;
      if (defaultTypeFileIdRaw !== undefined) {
        const typeFileId = defaultTypeFileIdRaw === "" ? null : Number(defaultTypeFileIdRaw);
        const finalId = (typeFileId === null || (Number.isFinite(typeFileId) && typeFileId > 0))
          ? typeFileId
          : undefined;
        if (finalId !== undefined) {
          await prisma.memoType.update({
            where: { id },
            data: { defaultTypeFileId: finalId },
          });
        }
      }
    }

    // Return full type with typeFiles
    const full = await prisma.memoType.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        abbreviation: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        defaultTypeFileId: true,
        approvalLineId: true,
        businessUnitId: true,
        departmentId: true,
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,
        typeFiles: {
          select: { id: true, fileName: true, filePath: true, size: true, orderNo: true },
          orderBy: { orderNo: "asc" },
        },
      },
    });

    res.json(full);

    // ================= LOGGING =================
    try {
      const logDetails: Record<string, any> = {};

      if (existing.name !== name) {
        logDetails.oldName = existing.name;
        logDetails.newName = name;
      }
      if (existing.abbreviation !== abbreviation) {
        logDetails.oldAbbreviation = existing.abbreviation;
        logDetails.newAbbreviation = abbreviation;
      }
      if (existing.description !== description) {
        logDetails.oldDescription = existing.description;
        logDetails.newDescription = description;
      }
      if (existing.isActive !== updateData.isActive && updateData.isActive !== undefined) {
        logDetails.oldIsActive = existing.isActive;
        logDetails.newIsActive = updateData.isActive;
      }
      if (existing.isDelete !== updateData.isDelete && updateData.isDelete !== undefined) {
        logDetails.oldisDelete = existing.isDelete;
        logDetails.newisDelete = updateData.isDelete;
      }
      if (existing.businessUnitId !== (buIdNorm ?? null)) {
        logDetails.oldBusinessUnit = existing.businessUnit?.name ?? null;
        logDetails.newBusinessUnit = newBuName;
      }
      if (existing.departmentId !== (depIdNorm ?? null)) {
        logDetails.oldDepartment = existing.department?.name ?? null;
        logDetails.newDepartment = newDeptName;
      }

      // Scope change
      const getScopeLabel = (fe: boolean, fac: boolean, fbu: boolean, bu?: string | null, dept?: string | null) => {
        if (fe) return "Everyone";
        if (fac && dept) return `All BU for Dept: ${dept}`;
        if (fbu && bu) return `All Dept under ${bu}`;
        if (bu && dept) return `${bu} / ${dept}`;
        return "Not specified";
      };

      const oldScope = getScopeLabel(
        existing.forEveryone,
        existing.forEveryDepartmentAcrossBU,
        existing.forAllDepartmentUnderSelectedBu,
        existing.businessUnit?.name,
        existing.department?.name
      );
      const newScope = getScopeLabel(
        finalFE,
        finalFAC,
        finalFBU,
        newBuName ?? existing.businessUnit?.name,
        newDeptName ?? existing.department?.name
      );

      if (oldScope !== newScope) {
        logDetails.oldScope = oldScope;
        logDetails.newScope = newScope;
      }

      if (Object.keys(logDetails).length > 0) {
        await createAdminLog(
          req.user!.id,
          "MEMO_TYPE_UPDATE",
          "MEMO_TYPE",
          id,
          name,
          logDetails
        );
      }
    } catch (logErr) {
      console.error("Failed to create admin log:", logErr);
      // Don't fail the request if logging fails
    }

  } catch (err) {
    console.error("updateType error:", err);
    res.status(500).json({ error: "Failed to update type" });
  }

};

/**
 * DELETE /api/memotypes/:id
 */
export const deleteMEMOType: RequestHandler = async (req, res: Response) => {
  const id = Number(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid type ID" });
    return;
  }

  try {
    // 0) โหลด type เพื่อตรวจสิทธิ์และเช็คทีม/line
    const existing = await prisma.memoType.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        abbreviation: true,
        description: true,
        isActive: true,
        approvalLineId: true,
        createdByUserId: true,
        businessUnit: { select: { name: true } },
        department: { select: { name: true } },
        forEveryone: true,
        forEveryDepartmentAcrossBU: true,
        forAllDepartmentUnderSelectedBu: true,
      },
    });
    if (!existing) {
      res.status(404).json({ error: "Type not found" });
      return;
    }

    // Fetch approval levels for logging (before deletion)
    const levelLines: string[] = [];
    if (existing.approvalLineId) {
      const pivots = await prisma.lineOfApprovalUserPivot.findMany({
        where: { lineOfApprovalId: existing.approvalLineId },
        include: {
          user: { select: { id: true, name: true, lastname: true } }
        },
        orderBy: { level: "asc" }
      });
      
      // Group by level
      const groups: Record<number, typeof pivots> = {};
      pivots.forEach(p => {
        const lv = p.level ?? 0;
        if (!groups[lv]) groups[lv] = [];
        groups[lv].push(p);
      });
      
      Object.entries(groups)
        .sort(([a], [b]) => Number(a) - Number(b))
        .forEach(([lvl, items]) => {
          const names = items.map(p => {
            let uName = "FLEXIBLE_SLOT";
            if (p.slotType === "FIXED_USER" && p.user) {
              uName = `${p.user.name} ${p.user.lastname || ""}`.trim();
            }
            const sig = p.isSigReq ? "SigReq" : "NoSigReq";
            return `${uName} (${sig})`;
          });
          levelLines.push(`Level ${Number(lvl) + 1}: ${names.join(", ")}`);
        });
    }

    // 1) ป้องกัน FK: ถ้ายังมีเมโมอ้าง type นี้อยู่ ให้แจ้งก่อน
    const memoCount = await prisma.masterMemo.count({
      where: { memotypeId: id },
    });
    if (memoCount > 0) {
      res.status(409).json({
        error: "Cannot delete type that is referenced by memos",
        details: { memoCount },
      });
      return;
    }

    // 2) หาไฟล์ทั้งหมดของ type
    const files = await prisma.typeFile.findMany({
      where: { memoTypeId: id },
      select: { id: true, filePath: true },
    });
    const fileIds = files.map((f: { id: any }) => f.id);

    // 3) ลบความเกี่ยวข้องใน DB ภายในทรานแซคชัน
    await prisma.$transaction(async (tx) => {
      // 3.1) กัน FK defaultMainFileId → set null ก่อนลบไฟล์
      if (fileIds.length > 0) {
        // ⚠️ defaultTypeFileId field removed from schema
        // await tx.memoType.update({
        //   where: { id },
        //   data: { defaultTypeFileId: null },
        // });

        await tx.typeFile.deleteMany({
          where: { id: { in: fileIds } },
        });
      }

      // 3.2) ถ้ามี line ผูกอยู่ และไม่มีเมโมใดใช้อยู่ → ลบ line + pivots
      if (existing.approvalLineId) {
        const lineRefCount = await tx.masterMemo.count({
          where: { approvalLineId: existing.approvalLineId },
        });
        if (lineRefCount === 0) {
          await tx.lineOfApprovalUserPivot.deleteMany({
            where: { lineOfApprovalId: existing.approvalLineId },
          });
          await tx.lineOfApproval.delete({
            where: { id: existing.approvalLineId },
          });
        }
        // ถ้ามีเมโมยังอ้าง line อยู่ → เว้นไว้ ไม่ลบ line
      }

      // 3.3) ลบตัว type
      await tx.memoType.delete({ where: { id } });
    });

    // 4) ลบไฟล์บนดิสก์ (พยายามลบทีละไฟล์ ไม่ให้ error ดิสก์ทำให้ล้มทั้งงาน)
    const toLocalPath = (webPath: string) => {
      const normalized = webPath.replace(/\\/g, "/");
      const rest = normalized.replace(/^\/?uploads\//, "");
      const safeRest = rest
        .split("/")
        .filter((seg) => seg && seg !== "..")
        .join(path.sep);
      return path.join(UPLOADS_DIR, safeRest);
    };

    for (const f of files) {
      try {
        const local = toLocalPath(f.filePath || "");
        if (local.startsWith(UPLOADS_DIR)) {
          fs.existsSync(local) && fs.unlinkSync(local);
        }
      } catch (e) {
        console.warn("⚠️ unlink failed:", f.filePath, e);
      }
    }

    res.sendStatus(204);

    // Log Delete
    await createAdminLog(
      req.user!.id,
      "MEMO_TYPE_DELETE",
      "MEMO_TYPE",
      id,
      existing.name,
      {
        name: existing.name,
        abbreviation: existing.abbreviation,
        description: existing.description,
        isActive: existing.isActive,
        businessUnit: existing.businessUnit?.name ?? null,
        department: existing.department?.name ?? null,
        forEveryone: existing.forEveryone,
        forEveryDepartmentAcrossBU: existing.forEveryDepartmentAcrossBU,
        forAllDepartmentUnderSelectedBu: existing.forAllDepartmentUnderSelectedBu,
        levels: levelLines.length > 0 ? levelLines : null,
        deletedFilesCount: files.length,
      }
    );
  } catch (err) {
    console.error("deleteType error:", err);
    res.status(500).json({ error: "Failed to delete type" });
  }
};

// src/controllers/memotype.controller.ts (เพิ่มฟังก์ชันใหม่)
export const deleteMEMOTypeFile: RequestHandler = async (req, res) => {
  const typeId = Number(req.params.typeId);
  const fileId = Number(req.params.fileId);
  if (!Number.isFinite(typeId) || !Number.isFinite(fileId)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  try {
    // เอา type มาตรวจสิทธิ์ก่อน
    const type = await prisma.memoType.findUnique({
      where: { id: typeId },
    });
    if (!type) {
      res.status(404).json({ error: "Type not found" });
      return;
    }

    // หาไฟล์ที่ต้องลบ
    const tf = await prisma.typeFile.findFirst({
      where: { id: fileId, memoTypeId: typeId },
      select: { id: true, filePath: true },
    });
    if (!tf) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // ลบความเชื่อมโยงอื่นๆ (กัน FK) + ลบ mainFile
    await prisma.$transaction(async (tx) => {
      // ⚠️ defaultTypeFileId field removed from schema
      // await tx.memoType.updateMany({
      //   where: { id: typeId, defaultTypeFileId: fileId },
      //   data: { defaultTypeFileId: null },
      // });

      await tx.typeFile.delete({ where: { id: fileId } });
    });
    // ลบไฟล์จริง
    const toLocalPath = (webPath: string) => {
      const normalized = webPath.replace(/\\/g, "/");
      const rest = normalized.replace(/^\/?uploads\//, "");
      const safeRest = rest
        .split("/")
        .filter((seg) => seg && seg !== "..")
        .join(path.sep);
      return path.join(UPLOADS_DIR, safeRest);
    };
    try {
      const local = toLocalPath(tf.filePath || "");
      if (local.startsWith(UPLOADS_DIR) && fs.existsSync(local)) {
        fs.unlinkSync(local);
      }
    } catch (e) {
      console.warn("unlink failed:", tf.filePath, e);
    }

    res.sendStatus(204);

    // Log File Delete
    await createAdminLog(
      req.user!.id,
      "MEMO_TYPE_FILE_DELETE",
      "MEMO_TYPE",
      typeId,
      type.name,
      {
        fileId,
        filePath: tf.filePath
      }
    );

    return;
  } catch (e) {
    console.error("deleteMEMOTypeFile error:", e);
    res.status(500).json({ error: "Failed to delete file" });
    return;
  }
};

/**
 * GET /api/memotypes/count
 * Get count of active memotypes
 */
export const getMEMOTypesCount: RequestHandler = async (req, res: Response) => {
  try {
    const where = await buildVisibilityWhere(req as AuthenticatedRequest);    
    const activeCount = await prisma.memoType.count({
      where: {
        ...where,
        isActive: true,
      },
    });

    const totalCount = await prisma.memoType.count({
      where,
    });

    res.json({
      activeCount,
      totalCount,
    });
  } catch (err) {
    console.error("getMEMOTypesCount error:", err);
    res.status(500).json({ error: "Failed to get memotype count" });
  }
};
