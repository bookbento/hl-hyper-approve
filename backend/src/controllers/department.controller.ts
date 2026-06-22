import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { createAdminLog } from "./adminLog.controller";
import { AuthenticatedRequest } from "../types/request";

export const getAllDepartments: RequestHandler = async (_req, res) => {
  try {
    const depts = await prisma.department.findMany({
      where: { deletedAt: null }, // ⬅️ ดึงเฉพาะที่ยังไม่ถูกลบ
      include: {
        businessUnit: { select: { id: true, name: true } }, // ⬅️ เพิ่มตรงนี้
      },
    });
    res.json(depts);
  } catch {
    res.status(500).json({ error: "Failed to fetch departments" });
  }
};

export const getArchivedDepartments: RequestHandler = async (_req, res) => {
  try {
    const depts = await prisma.department.findMany({
      where: { deletedAt: { not: null } }, // ⬅️ ดึงเฉพาะที่ถูกลบ (Archived)
      include: {
        businessUnit: { select: { id: true, name: true } },
      },
      orderBy: { deletedAt: 'desc' },
    });
    res.json(depts);
  } catch {
    res.status(500).json({ error: "Failed to fetch archived departments" });
  }
};

export const restoreDepartment: RequestHandler = async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  try {
    const existing = await prisma.department.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Department not found" });
      return;
    }

    if (!existing.deletedAt) {
      res.status(400).json({ error: "Department is not archived" });
      return;
    }

    await prisma.department.update({
      where: { id },
      data: { deletedAt: null },
    });

    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      await createAdminLog(
        actorId,
        "DEPARTMENT_RESTORE",
        "DEPARTMENT",
        existing.id,
        existing.name,
        {
          abbreviation: existing.abbreviation,
          businessUnitId: existing.businessUnitId,
          businessUnitName: existing.businessUnitId ? (await prisma.businessUnit.findUnique({where: {id: existing.businessUnitId}}))?.name : null
        }
      );
    }

    res.sendStatus(204);
    return;
  } catch (error) {
    console.error("Failed to restore department:", error);
    res.status(500).json({ error: "Failed to restore department" });
    return;
  }
};
export const getDepartmentById: RequestHandler = async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  try {
    const dept = await prisma.department.findUnique({
      where: { id },
      include: {
        businessUnit: { select: { id: true, name: true } }, // ⬅️ เพิ่มตรงนี้
      },
    });
    if (!dept) {
      res.status(404).json({ error: "Department not found" });
      return;
    }
    res.json(dept);
  } catch {
    res.status(500).json({ error: "Failed to fetch department" });
  }
};

export const createDepartment: RequestHandler = async (req, res) => {
  const { name, abbreviation, businessUnitId } = req.body;

  if (!name || !abbreviation) {
    res.status(400).json({ error: "Both name and abbreviation are required" });
    return;
  }

  try {
    const newDept = await prisma.department.create({
      data: {
        name,
        abbreviation,
        // ถ้าอยาก “ล้าง” ให้เป็น null ได้ตาม schema
        businessUnitId: businessUnitId ?? null,
      },
      include: {
        businessUnit: { select: { id: true, name: true } },
      },
    });

    // Log the action
    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      await createAdminLog(
        actorId,
        "DEPARTMENT_CREATE",
        "DEPARTMENT",
        newDept.id,
        newDept.name,
        {
          abbreviation: newDept.abbreviation,
          businessUnitId: newDept.businessUnitId,
          businessUnitName: newDept.businessUnit?.name || null,
        }
      );
    }

    res.status(201).json(newDept);
  } catch (error) {
    console.error("Failed to create department:", error);
    res.status(500).json({ error: "Failed to create department" });
  }
};

export const updateDepartment: RequestHandler = async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  const { name, abbreviation, businessUnitId } = req.body;

  if (!name || !abbreviation) {
    res.status(400).json({ error: "Name และ abbreviation ต้องระบุ" });
    return;
  }

  try {
    const existing = await prisma.department.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Department not found" });
      return;
    }

    const updated = await prisma.department.update({
      where: { id },
      data: {
        name,
        abbreviation,
        businessUnitId: businessUnitId ?? null, // ← ใส่เพิ่ม
      },
      include: {
        businessUnit: { select: { id: true, name: true } },
      },
    });

    // Log the action
    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      const changes: Record<string, { old: any; new: any }> = {};

      if (existing.name !== updated.name) {
        changes.name = { old: existing.name, new: updated.name };
      }
      if (existing.abbreviation !== updated.abbreviation) {
        changes.abbreviation = { old: existing.abbreviation, new: updated.abbreviation };
      }
      if (existing.businessUnitId !== updated.businessUnitId) {
        // Resolve old BU name
        const oldBu = existing.businessUnitId 
          ? await prisma.businessUnit.findUnique({ where: { id: existing.businessUnitId } }) 
          : null;
        
        changes.businessUnit = { 
          old: oldBu?.name || null, 
          new: updated.businessUnit?.name || null 
        };
      }

      if (Object.keys(changes).length > 0) {
        await createAdminLog(
          actorId,
          "DEPARTMENT_UPDATE",
          "DEPARTMENT",
          updated.id,
          updated.name,
          { changes }
        );
      }
    }

    res.json(updated);
  } catch (error) {
    console.error("❌ Failed to update department:", error);
    res.status(500).json({ error: "Failed to update department" });
  }
};

export const deleteDepartment: RequestHandler = async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  try {
    const existing = await prisma.department.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Department not found" });
      return;
    }

    if (existing.deletedAt) {
      res.status(404).json({ error: "Department not found" });
      return;
    }

    // Soft delete
    await prisma.department.update({
      where: { id },
      data: { deletedAt: new Date() }
    });

    // Log the action
    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      await createAdminLog(
        actorId,
        "DEPARTMENT_ARCHIVE", // ⬅️ เปลื่ยนจาก DELETE เป็น ARCHIVE
        "DEPARTMENT",
        existing.id,
        existing.name,
        { 
          abbreviation: existing.abbreviation,
          businessUnitId: existing.businessUnitId,
          businessUnitName: existing.businessUnitId ? (await prisma.businessUnit.findUnique({where: {id: existing.businessUnitId}}))?.name : null
        }
      );
    }

    res.sendStatus(204);
    return;
  } catch {
    res.status(500).json({ error: "Failed to archive department" });
    return;
  }
};
