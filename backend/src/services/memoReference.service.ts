/**
 * MemoReferenceService
 *
 * Extracted from memo.controller.ts (Wave 4 — Phase 0 refactor).
 * Behavior is identical to the original — no logic changes.
 *
 * Functions:
 *   searchMemosForReference  — GET /api/memos/search-for-reference
 *                              Returns user-owned memos (excluding Draft/Cancelled/Deleted)
 *                              for use as reference targets.
 *
 *   getMemoReferences        — GET /api/memos/:id/references
 *                              Returns references of a memo filtered by access control.
 *                              CRITICAL (D-6): filters Deleted + calls canViewMemo from
 *                              memoAccess.service — access bypass || true has been removed.
 *
 *   updateMemoReferences     — PUT /api/memos/:id/references
 *                              Replaces all references for a memo in a transaction.
 *
 *   getReferenceMemoContent  — GET /api/memos/:id/reference-content/:referenceId
 *                              Returns full content of a referenced memo.
 *                              CRITICAL (D-6): calls canViewMemo — 403 when user has no access.
 */

import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { canViewMemo } from "./memoAccess.service";

// GET /api/memos/search-for-reference
export const searchMemosForReference: RequestHandler = async (req, res) => {
  try {
    const currentUserId = req.user!.id;
    const query = String(req.query.q || "").trim();
    const excludeIds = String(req.query.exclude || "")
      .split(",")
      .map((id) => Number(id.trim()))
      .filter((id) => !isNaN(id));
    const limit = Math.min(Number(req.query.limit) || 10, 50);

    let whereCondition: any = {
      userId: currentUserId,
      id: { notIn: excludeIds },
    };

    // If query is provided and long enough, add search conditions
    if (query.length >= 2) {
      whereCondition.OR = [
        { subject: { contains: query, mode: "insensitive" } },
        {
          memoNumberRecord: {
            memonumber: { contains: query, mode: "insensitive" },
          },
        },
      ];
    }
    // If no query or query too short, just return recent memos (no additional OR condition)

    // Search memos created by the current user only
    const memos = await prisma.masterMemo.findMany({
      where: whereCondition,
      select: {
        id: true,
        subject: true,
        createdAt: true,
        memoNumberRecord: {
          select: { memonumber: true },
        },
        statuses: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            status: { select: { name: true } },
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            lastname: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    // Filter out Draft and Cancelled memos
    const filteredMemos = memos.filter((memo) => {
      const statusName = memo.statuses[0]?.status?.name || "Draft";
      const statusUpper = statusName.toUpperCase();
      return statusUpper !== "DRAFT" && statusUpper !== "CANCELLED" && statusUpper !== "DELETED";
    });

    const results = filteredMemos.map((memo) => ({
      id: memo.id,
      subject: memo.subject,
      memoNumber: memo.memoNumberRecord?.memonumber || "",
      createdAt: memo.createdAt,
      status: memo.statuses[0]?.status?.name || "Draft",
      createdBy: {
        id: memo.user.id,
        name: memo.user.name,
        lastname: memo.user.lastname,
      },
    }));

    res.json(results);
  } catch (error) {
    console.error("Search memos for reference failed:", error);
    res.status(500).json({ error: "Search failed" });
  }
};

// GET /api/memos/:id/references
export const getMemoReferences: RequestHandler = async (req, res) => {
  try {
    const memoId = Number(req.params.id);
    const currentUserId = req.user!.id;

    if (isNaN(memoId)) {
      res.status(400).json({ error: "Invalid memo ID" });
      return;
    }

    // Get memo references with permission checking
    const references = await prisma.memoReference.findMany({
      where: { mainMemoId: memoId },
      include: {
        referenceMemo: {
          select: {
            id: true,
            subject: true,
            createdAt: true,
            userId: true,
            memoNumberRecord: {
              select: { memonumber: true },
            },
            statuses: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: {
                status: { select: { name: true } },
              },
            },
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                profileImagePath: true,
              },
            },
            mainFiles: {
              select: {
                id: true,
                fileName: true,
                filePath: true,
                size: true,
              },
            },
            attachedFiles: {
              select: {
                id: true,
                fileName: true,
                filePath: true,
                fileType: true,
                size: true,
              },
            },
            comments: {
              select: {
                id: true,
                comment: true,
                createdAt: true,
                user: {
                  select: {
                    id: true,
                    name: true,
                    lastname: true,
                    profileImagePath: true,
                  },
                },
                attachments: {
                  select: {
                    id: true,
                    filename: true,
                    url: true,
                    mimetype: true,
                    size: true,
                  },
                },
              },
              orderBy: { createdAt: "asc" },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // D-6: Filter references based on actual memo access permissions.
    // Deleted memos are skipped, then canViewMemo (from memoAccess.service)
    // is called for each reference — no || true bypass.
    const accessibleReferences: typeof references = [];
    for (const ref of references) {
      const statusName = ref.referenceMemo.statuses[0]?.status?.name || "";
      if (statusName === "Deleted") continue;
      const hasAccess = await canViewMemo(currentUserId, ref.referenceMemo.id);
      if (hasAccess) accessibleReferences.push(ref);
    }

    const result = accessibleReferences.map((ref) => ({
      id: ref.referenceMemo.id,
      subject: ref.referenceMemo.subject,
      memoNumber: ref.referenceMemo.memoNumberRecord?.memonumber || "",
      createdAt: ref.referenceMemo.createdAt,
      status: ref.referenceMemo.statuses[0]?.status?.name || "Draft",
      createdBy: {
        id: ref.referenceMemo.user.id,
        name: ref.referenceMemo.user.name,
        lastname: ref.referenceMemo.user.lastname,
        profileImagePath: ref.referenceMemo.user.profileImagePath,
      },
      mainFiles: ref.referenceMemo.mainFiles,
      attachedFiles: ref.referenceMemo.attachedFiles,
      comments: ref.referenceMemo.comments,
      hasAccess: true, // Since we filtered above
    }));

    res.json(result);
  } catch (error) {
    console.error("Get memo references failed:", error);
    res.status(500).json({ error: "Failed to get references" });
  }
};

// PUT /api/memos/:id/references
export const updateMemoReferences: RequestHandler = async (req, res) => {
  try {
    const memoId = Number(req.params.id);
    const currentUserId = req.user!.id;
    const { referenceIds } = req.body;

    if (isNaN(memoId)) {
      res.status(400).json({ error: "Invalid memo ID" });
      return;
    }

    if (!Array.isArray(referenceIds)) {
      res.status(400).json({ error: "referenceIds must be an array" });
      return;
    }

    // Verify user owns the main memo
    const mainMemo = await prisma.masterMemo.findFirst({
      where: { id: memoId, userId: currentUserId },
      select: { id: true },
    });

    if (!mainMemo) {
      res.status(404).json({ error: "Memo not found or access denied" });
      return;
    }

    // Validate reference memo IDs exist and are accessible
    const validReferenceIds: number[] = [];
    for (const refId of referenceIds) {
      const refMemo = await prisma.masterMemo.findFirst({
        where: {
          id: Number(refId),
          userId: currentUserId, // User can only reference their own memos
        },
        select: { id: true },
      });

      if (refMemo && refMemo.id !== memoId) {
        // Prevent self-reference
        validReferenceIds.push(refMemo.id);
      }
    }

    // Update references in a transaction
    await prisma.$transaction(async (tx) => {
      // Remove existing references
      await tx.memoReference.deleteMany({
        where: { mainMemoId: memoId },
      });

      // Add new references
      if (validReferenceIds.length > 0) {
        await tx.memoReference.createMany({
          data: validReferenceIds.map((refId) => ({
            mainMemoId: memoId,
            referenceMemoId: refId,
            createdBy: currentUserId,
          })),
        });
      }
    });

    res.json({ success: true, referencesCount: validReferenceIds.length });
  } catch (error) {
    console.error("Update memo references failed:", error);
    res.status(500).json({ error: "Failed to update references" });
  }
};

// GET /api/memos/:id/reference-content/:referenceId
export const getReferenceMemoContent: RequestHandler = async (req, res) => {
  try {
    const memoId = Number(req.params.id);
    const referenceId = Number(req.params.referenceId);
    const currentUserId = req.user!.id;

    if (isNaN(memoId) || isNaN(referenceId)) {
      res.status(400).json({ error: "Invalid memo or reference ID" });
      return;
    }

    // Verify the reference relationship exists
    const reference = await prisma.memoReference.findFirst({
      where: {
        mainMemoId: memoId,
        referenceMemoId: referenceId,
      },
    });

    if (!reference) {
      res.status(404).json({ error: "Reference not found" });
      return;
    }

    // Get the reference memo with full content
    const referenceMemo = await prisma.masterMemo.findFirst({
      where: { id: referenceId },
      select: {
        id: true,
        subject: true,
        createdAt: true,
        userId: true,
        memoNumberRecord: {
          select: { memonumber: true },
        },
        statuses: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            status: { select: { name: true } },
          },
        },
        user: {
          select: {
            id: true,
            name: true,
            lastname: true,
            profileImagePath: true,
          },
        },
        mainFiles: {
          select: {
            id: true,
            fileName: true,
            filePath: true,
            size: true,
          },
        },
        attachedFiles: {
          select: {
            id: true,
            fileName: true,
            filePath: true,
            fileType: true,
            size: true,
          },
        },
        comments: {
          select: {
            id: true,
            comment: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                profileImagePath: true,
              },
            },
            attachments: {
              select: {
                id: true,
                filename: true,
                url: true,
                mimetype: true,
                size: true,
              },
            },
          },
          orderBy: { createdAt: "asc" },
        },
      },
    });

    if (!referenceMemo) {
      res.status(404).json({ error: "Reference memo not found" });
      return;
    }

    // D-6: Check if user has access using the authoritative canViewMemo permission logic.
    // Import is from memoAccess.service — NOT an inline || true bypass.
    const hasAccess = await canViewMemo(currentUserId, referenceMemo.id);

    if (!hasAccess) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    if (referenceMemo.statuses[0]?.status?.name === "Deleted") {
      res.status(404).json({ error: "Reference not found (deleted)" });
      return;
    }

    const result = {
      id: referenceMemo.id,
      subject: referenceMemo.subject,
      memoNumber: referenceMemo.memoNumberRecord?.memonumber || "",
      createdAt: referenceMemo.createdAt,
      status: referenceMemo.statuses[0]?.status?.name || "Draft",
      createdBy: {
        id: referenceMemo.user.id,
        name: referenceMemo.user.name,
        lastname: referenceMemo.user.lastname,
        profileImagePath: referenceMemo.user.profileImagePath,
      },
      mainFiles: referenceMemo.mainFiles,
      attachedFiles: referenceMemo.attachedFiles,
      comments: referenceMemo.comments,
      hasAccess: true,
    };

    res.json(result);
  } catch (error) {
    console.error("Get reference memo content failed:", error);
    res.status(500).json({ error: "Failed to get reference content" });
  }
};
