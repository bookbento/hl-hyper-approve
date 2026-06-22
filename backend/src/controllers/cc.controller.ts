// src/controllers/cc.controller.ts

import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";

// --- GET /api/memos/:id/cc ---
export const getMemoCC: RequestHandler = async (req, res, next) => {
  const memoId = Number(req.params.id);

  if (isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memo ID" });
    return;
  }

  try {
    // Check if memo exists first
    const memo = await prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { id: true }
    });

    if (!memo) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }

    // Fetch CC recipients for the memo
    const ccRecipients = await prisma.memoCc.findMany({
      where: { memoId },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            profileImagePath: true
          }
        }
      },
      orderBy: { createdAt: "asc" }
    });

    // Transform to match expected frontend format
    const formattedCC = ccRecipients.map(cc => ({
      userId: cc.user.id,
      name: cc.user.name,
      email: cc.user.email,
      addedAt: cc.createdAt.toISOString(),
      profileImage: cc.user.profileImagePath
    }));

    res.status(200).json(formattedCC);
    return;
  } catch (error) {
    console.error("Error fetching CC recipients:", error);
    res.status(500).json({ error: "Failed to fetch CC recipients" });
    return;
  }
};
