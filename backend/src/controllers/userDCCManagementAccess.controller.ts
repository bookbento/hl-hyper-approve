import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { AuthenticatedRequest } from "../types/request";
import { createAdminLog } from "./adminLog.controller";

/**
 * Get DCC management access for a specific user
 * GET /api/users/:id/dcc-management-access
 */
export const getDCCManagementAccess: RequestHandler = async (req, res) => {
  const userId = Number(req.params.id);

  try {
    // Verify user exists
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const access = await prisma.userDCCManagementAccess.findMany({
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
    console.error("Error fetching DCC management access:", error);
    res.status(500).json({ error: "Failed to fetch DCC management access" });
  }
};

/**
 * Update DCC management access for a user
 * PUT /api/users/:id/dcc-management-access
 * Body: { businessUnitIds: number[] }
 * 
 * Requirements:
 * - Only admins can modify DCC management access (403 for non-admin)
 * - Target user must have DCC role (400 for non-DCC users)
 * - All business unit IDs must be valid (400 for invalid IDs)
 */
export const updateDCCManagementAccess: RequestHandler = async (req, res) => {
  const userId = Number(req.params.id);
  const { businessUnitIds } = req.body as { businessUnitIds: number[] };
  const authReq = req as AuthenticatedRequest;
  const grantedBy = authReq.user?.id;
  const requestorRole = authReq.user?.role?.toLowerCase();

  // Check if requestor is admin
  if (requestorRole !== "admin") {
    res.status(403).json({ error: "Only administrators can modify DCC management access" });
    return;
  }

  if (!Array.isArray(businessUnitIds)) {
    res.status(400).json({ error: "businessUnitIds must be an array" });
    return;
  }

  try {
    // Verify user exists and has DCC role
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, lastname: true, role: true, businessUnitId: true },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Check if user has DCC role
    if (user.role?.toLowerCase() !== "dcc") {
      res.status(400).json({ error: "DCC management access can only be assigned to users with DCC role" });
      return;
    }

    // Get existing access for logging
    const existingAccess = await prisma.userDCCManagementAccess.findMany({
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
    if (businessUnitIds.length > 0) {
      const businessUnits = await prisma.businessUnit.findMany({
        where: { id: { in: businessUnitIds } },
      });

      if (businessUnits.length !== businessUnitIds.length) {
        res.status(400).json({ error: "One or more business units not found" });
        return;
      }
    }

    // Delete existing access and create new ones in a transaction
    await prisma.$transaction(async (tx) => {
      // Remove all existing DCC management access
      await tx.userDCCManagementAccess.deleteMany({
        where: { userId },
      });

      // Create new access records
      if (businessUnitIds.length > 0) {
        await tx.userDCCManagementAccess.createMany({
          data: businessUnitIds.map((businessUnitId) => ({
            userId,
            businessUnitId,
            grantedBy,
          })),
        });
      }
    });

    // Fetch updated access
    const updatedAccess = await prisma.userDCCManagementAccess.findMany({
      where: { userId },
      include: {
        businessUnit: {
          select: { id: true, name: true, abbreviation: true },
        },
      },
      orderBy: { grantedAt: "desc" },
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
          "USER_DCC_ACCESS_UPDATE",
          "USER",
          userId,
          `${user.name} ${user.lastname || ""}`.trim(),
          {
            changes: {
              dccManagementBusinessUnits: {
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
    console.error("Error updating DCC management access:", error);
    res.status(500).json({ error: "Failed to update DCC management access" });
  }
};


/**
 * Get all business units manageable by a DCC user (primary + additional DCC management access)
 * GET /api/users/:id/manageable-business-units
 * 
 * Returns business units that the DCC user can manage memo types and approval lines for.
 * This is different from accessible-business-units which is for memo creation.
 */
export const getManageableBusinessUnits: RequestHandler = async (req, res) => {
  const userId = Number(req.params.id);

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { 
        businessUnitId: true,
        role: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Get additional DCC management access
    const additionalAccess = await prisma.userDCCManagementAccess.findMany({
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

    // Mark primary business unit
    const result = businessUnits.map((bu) => ({
      ...bu,
      isPrimary: bu.id === user.businessUnitId,
    }));

    res.json(result);
  } catch (error) {
    console.error("Error fetching manageable business units:", error);
    res.status(500).json({ error: "Failed to fetch manageable business units" });
  }
};
