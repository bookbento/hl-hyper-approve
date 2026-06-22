import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { AuthenticatedRequest } from "../types/request";
import { Prisma } from "@prisma/client";

// Helper function to create admin log
export const createAdminLog = async (
  actorId: number,
  actionType: string,
  module: string,
  targetId?: number | null,
  targetName?: string | null,
  details?: Record<string, any> | null
) => {
  try {
    await prisma.adminLog.create({
      data: {
        actorId,
        actionType,
        module,
        targetId: targetId ?? null,
        targetName: targetName ?? null,
        details: details !== null && details !== undefined 
          ? (details as Prisma.InputJsonValue) 
          : Prisma.JsonNull,
      },
    });
  } catch (error) {
    console.error("Failed to create admin log:", error);
    // Don't throw - logging should not break main operations
  }
};

// Manually create a log entry (for frontend actions)
export const createLog: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  try {
    const { actionType, module, targetId, targetName, details } = req.body;
    const actorId = req.user?.id;

    if (!actorId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await createAdminLog(
      actorId,
      actionType,
      module,
      targetId,
      targetName,
      details
    );

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("Failed to create admin log via API:", error);
    res.status(500).json({ error: "Failed to create log" });
  }
};

// Get logs by module with pagination and filters
export const getLogsByModule: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  try {
    const module = String(req.query.module ?? "").toUpperCase();
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
    const skip = (page - 1) * limit;

    // Filters
    const search = String(req.query.search ?? "").trim();
    const actionType = String(req.query.actionType ?? "").trim();
    const startDate = String(req.query.startDate ?? "");
    const endDate = String(req.query.endDate ?? "");
    const targetId = req.query.targetId ? parseInt(String(req.query.targetId), 10) : null;

    const whereClause: Prisma.AdminLogWhereInput = {};

    if (module) {
      whereClause.module = module;
    }

    if (actionType) {
      whereClause.actionType = actionType;
    }

    if (targetId !== null && !isNaN(targetId)) {
      whereClause.targetId = targetId;
    }

    if (startDate || endDate) {
      whereClause.createdAt = {};
      if (startDate) {
        whereClause.createdAt.gte = new Date(startDate);
      }
      if (endDate) {
        // End of the day
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        whereClause.createdAt.lte = end;
      }
    }

    if (search) {
      whereClause.OR = [
        { targetName: { contains: search, mode: "insensitive" } },
        { actionType: { contains: search, mode: "insensitive" } },
        { 
          actor: { 
            OR: [
              { name: { contains: search, mode: "insensitive" } },
              { lastname: { contains: search, mode: "insensitive" } },
              { email: { contains: search, mode: "insensitive" } }
            ] 
          } 
        }
      ];
    }

    const [logs, total] = await Promise.all([
      prisma.adminLog.findMany({
        where: whereClause,
        include: {
          actor: {
            select: {
              id: true,
              name: true,
              lastname: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.adminLog.count({ where: whereClause }),
    ]);

    // Format date to dd/mm/yyyy HH:mm:ss
    const formattedLogs = logs.map((log) => {
      const date = new Date(log.createdAt);
      const day = String(date.getDate()).padStart(2, "0");
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const year = date.getFullYear();
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      const seconds = String(date.getSeconds()).padStart(2, "0");

      return {
        ...log,
        createdAtFormatted: `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`,
      };
    });

    res.json({
      logs: formattedLogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Failed to fetch admin logs:", error);
    res.status(500).json({ error: "Failed to fetch admin logs" });
  }
};

// Get all logs (for admin dashboard)
export const getAllLogs: RequestHandler = async (
  req: AuthenticatedRequest,
  res
) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "50"), 10)));
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      prisma.adminLog.findMany({
        include: {
          actor: {
            select: {
              id: true,
              name: true,
              lastname: true,
              email: true,
            },
          },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.adminLog.count(),
    ]);

    // Format date to dd/mm/yyyy HH:mm:ss
    const formattedLogs = logs.map((log) => {
      const date = new Date(log.createdAt);
      const day = String(date.getDate()).padStart(2, "0");
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const year = date.getFullYear();
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      const seconds = String(date.getSeconds()).padStart(2, "0");

      return {
        ...log,
        createdAtFormatted: `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`,
      };
    });

    res.json({
      logs: formattedLogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Failed to fetch admin logs:", error);
    res.status(500).json({ error: "Failed to fetch admin logs" });
  }
};
