import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { createAdminLog } from "./adminLog.controller";
import { AuthenticatedRequest } from "../types/request";

// controllers/businessUnit.ts

export const getAllBusinessUnits: RequestHandler = async (_req, res) => {
  try {
    const units = await prisma.businessUnit.findMany({
      include: {
        departments: { 
          where: { deletedAt: null },
          select: { id: true, name: true, businessUnitId: true } 
        },
      },
    });
    res.json(units);
  } catch {
    res.status(500).json({ error: "Failed to fetch business units" });
  }
};



export const getBusinessUnitById: RequestHandler = async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  try {
    const unit = await prisma.businessUnit.findUnique({ where: { id } });
    if (!unit) {
      res.status(404).json({ error: "Business unit not found" });
      return;
    }
    res.json(unit);
    return;
  } catch {
    res.status(500).json({ error: "Failed to fetch business unit" });
    return;
  }
};

export const createBusinessUnit: RequestHandler = async (req, res) => {
  const { name, abbreviation } = req.body;
  if (!name){
     res.status(400).json({ error: "Name is required" });
     return;
  } 
  try {
    // Check if business unit with same name already exists
    const existing = await prisma.businessUnit.findUnique({ 
      where: { name } 
    });
    
    if (existing) {
      res.status(409).json({ error: "Business unit with this name already exists" });
      return;
    }

    const newUnit = await prisma.businessUnit.create({
      data: { 
        name, 
        abbreviation: abbreviation || null 
      },
    });

    // Log the action
    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      await createAdminLog(
        actorId,
        "BU_CREATE",
        "BUSINESS_UNIT",
        newUnit.id,
        newUnit.name,
        { abbreviation: newUnit.abbreviation }
      );
    }

     res.status(201).json(newUnit);
     return;
  } catch (error) {
    console.error("❌ Error creating business unit:", error);
    res.status(500).json({ error: "Failed to create business unit" });
    return ;
  }
};

export const updateBusinessUnit: RequestHandler = async (req, res) => {
  const id = Number(req.params.id);
  const { name, abbreviation } = req.body;
  if (!name){
     res.status(400).json({ error: "Name is required" });
     return;
  } 

  try {
    const existing = await prisma.businessUnit.findUnique({ where: { id } });
    if (!existing){
      res.status(404).json({ error: "Business unit not found" });
      return ;
    } 

    // Check if another business unit with same name exists
    const duplicate = await prisma.businessUnit.findFirst({
      where: { 
        name,
        id: { not: id }
      }
    });
    
    if (duplicate) {
      res.status(409).json({ error: "Business unit with this name already exists" });
      return;
    }

    const updated = await prisma.businessUnit.update({
      where: { id },
      data: { 
        name, 
        abbreviation: abbreviation || null 
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

      if (Object.keys(changes).length > 0) {
        await createAdminLog(
          actorId,
          "BU_UPDATE",
          "BUSINESS_UNIT",
          updated.id,
          updated.name,
          { changes }
        );
      }
    }

    res.json(updated);
    return ;
  } catch (error) {
    console.error("❌ Error updating business unit:", error);
    res.status(500).json({ error: "Failed to update business unit" });
    return ;
  }
};


export const deleteBusinessUnit: RequestHandler = async (req, res) => {
  const id = parseInt(req.params.id as string, 10);
  try {
    const existing = await prisma.businessUnit.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: "Business unit not found" });
      return;
    }
    await prisma.businessUnit.delete({ where: { id } });

    // Log the action
    const actorId = (req as AuthenticatedRequest).user?.id;
    if (actorId) {
      await createAdminLog(
        actorId,
        "BU_DELETE",
        "BUSINESS_UNIT",
        existing.id,
        existing.name,
        { abbreviation: existing.abbreviation }
      );
    }

    res.sendStatus(204);
    return;
  } catch {
    res.status(500).json({ error: "Failed to delete business unit" });
    return;
  }
};
