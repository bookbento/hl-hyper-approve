import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { AuthenticatedRequest } from "../types/request";
import { createAdminLog } from "./adminLog.controller";

/**
 * Get business unit access for a specific user
 * GET /api/users/:id/business-unit-access
 */
export const getUserBusinessUnitAccess: RequestHandler = async (req, res) => {
  const userId = Number(req.params.id);

  try {
    const access = await prisma.userBusinessUnitAccess.findMany({
      where: { userId },
      include: {
        businessUnit: {
          select: { id: true, name: true, abbreviation: true },
        },
      },
      orderBy: { grantedAt: "desc" },
    });

    res.json(access);
  } catch (error) {
    console.error("Error fetching user business unit access:", error);
    res.status(500).json({ error: "Failed to fetch business unit access" });
  }
};

/**
 * Update business unit access for a user
 * PUT /api/users/:id/business-unit-access
 * Body: { businessUnitIds: number[] }
 */
export const updateUserBusinessUnitAccess: RequestHandler = async (req, res) => {
  const userId = Number(req.params.id);
  const { businessUnitIds } = req.body as { businessUnitIds: number[] };
  const authReq = req as AuthenticatedRequest;
  const grantedBy = authReq.user?.id;

  if (!Array.isArray(businessUnitIds)) {
    res.status(400).json({ error: "businessUnitIds must be an array" });
    return;
  }

  try {
    // Verify user exists
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Get existing access for logging
    const existingAccess = await prisma.userBusinessUnitAccess.findMany({
      where: { userId },
      include: {
        businessUnit: {
          select: { id: true, name: true },
        },
      },
    });
    const oldBusinessUnits = existingAccess.map(a => ({
      id: a.businessUnit.id,
      name: a.businessUnit.name,
    }));

    // Verify all business units exist
    const businessUnits = await prisma.businessUnit.findMany({
      where: { id: { in: businessUnitIds } },
    });

    if (businessUnits.length !== businessUnitIds.length) {
      res.status(400).json({ error: "One or more business units not found" });
      return;
    }

    // Delete existing access and create new ones in a transaction
    await prisma.$transaction(async (tx) => {
      // Remove all existing access
      await tx.userBusinessUnitAccess.deleteMany({
        where: { userId },
      });

      // Create new access records
      if (businessUnitIds.length > 0) {
        await tx.userBusinessUnitAccess.createMany({
          data: businessUnitIds.map((businessUnitId) => ({
            userId,
            businessUnitId,
            grantedBy,
          })),
        });
      }
    });

    // Fetch updated access
    const updatedAccess = await prisma.userBusinessUnitAccess.findMany({
      where: { userId },
      include: {
        businessUnit: {
          select: { id: true, name: true, abbreviation: true },
        },
      },
    });

    // Log the change
    if (grantedBy) {
      const newBusinessUnits = updatedAccess.map(a => ({
        id: a.businessUnit.id,
        name: a.businessUnit.name,
      }));

      // Only log if there's an actual change
      const oldIds = oldBusinessUnits.map(b => b.id).sort().join(',');
      const newIds = newBusinessUnits.map(b => b.id).sort().join(',');
      
      if (oldIds !== newIds) {
        await createAdminLog(
          grantedBy,
          "USER_BU_ACCESS_UPDATE",
          "USER",
          userId,
          `${user.name} ${user.lastname || ""}`.trim(),
          {
            changes: {
              additionalBusinessUnitAccess: {
                old: oldBusinessUnits.length > 0 ? oldBusinessUnits.map(b => b.name) : null,
                new: newBusinessUnits.length > 0 ? newBusinessUnits.map(b => b.name) : null,
              },
            },
          }
        );
      }
    }

    res.json(updatedAccess);
  } catch (error) {
    console.error("Error updating user business unit access:", error);
    res.status(500).json({ error: "Failed to update business unit access" });
  }
};


/**
 * Get all business units accessible by a user (primary + additional)
 * GET /api/users/:id/accessible-business-units
 */
export const getAccessibleBusinessUnits: RequestHandler = async (req, res) => {
  const userId = Number(req.params.id);

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { businessUnitId: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Get additional business unit access
    const additionalAccess = await prisma.userBusinessUnitAccess.findMany({
      where: { userId },
      select: { businessUnitId: true },
    });

    // Combine primary and additional business units
    const businessUnitIds = new Set<number>();
    if (user.businessUnitId) {
      businessUnitIds.add(user.businessUnitId);
    }
    additionalAccess.forEach((access) => businessUnitIds.add(access.businessUnitId));

    // Fetch business unit details
    const businessUnits = await prisma.businessUnit.findMany({
      where: { id: { in: Array.from(businessUnitIds) } },
      select: { id: true, name: true, abbreviation: true },
      orderBy: { name: "asc" },
    });

    res.json(businessUnits);
  } catch (error) {
    console.error("Error fetching accessible business units:", error);
    res.status(500).json({ error: "Failed to fetch accessible business units" });
  }
};
