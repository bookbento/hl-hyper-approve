// src/controllers/memo.controller.ts

import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import {
  getUserDisplayName,
  toDisplayName,
  notifyStatusUpdate,
} from "./memoStatus.controller";
import { evaluateAndUpdateMemoStatus } from "../services/memoApproveAction.service";
import { getApproverLineStatus } from "../approverLine";
import { makeEmailToken } from "../lib/token";
import { ActionType, ExtraStatus, Prisma } from "@prisma/client";
import { AuthenticatedRequest } from "../types/request";
import { sendEmail } from "../lib/mailer";
import { verifyEmailToken } from "../lib/token";
import { toPublicUploadPath, UPLOADS_DIR } from "../middlewares/upload";
import sharp from "sharp";
import contentDisposition from "content-disposition";
import { decodeFilename, safeFileName } from "../lib/filename";
import { getUserId } from "../lib/filesec";
import { reserveMemoNumber } from "../lib/memoNumber";
import { pushNoti } from "../lib/notify";
import { filterUsersForEmail } from "../lib/notificationPreferences";
import { canViewMemo } from "../services/memoAccess.service";
import { getWaitingStatusId } from "../services/memoQuery.service";
export {
  getAllMemos,
  searchMemosHandler,
  searchMemoStatsHandler,
  getCurrentApprovers,
  getMemoById,
  getAwaitingApproval,
  getWaitingStatusId,
} from "../services/memoQuery.service";

/* ───── FRONTEND_URL: ต้องมีใน .env ───── */
if (!process.env.FRONTEND_URL) {
  throw new Error("Environment variable FRONTEND_URL is not set");
}
const FRONTEND_URL: string = process.env.FRONTEND_URL as string;

// ─── Lifecycle functions (Wave 9) — moved to memoLifecycle.service.ts ───
export {
  createMemo,
  updateMemo,
  deleteMemo,
  forceDeleteMemo,
  renewExpiry,
  parseExpiresAt,
  getStatusIdByName,
  absFromDbPath,
} from "../services/memoLifecycle.service";


// Helper function to check for delegation and return effective approver
async function getEffectiveApprover(userId: number): Promise<{
  effectiveUserId: number;
  isDelegated: boolean;
  delegationInfo?: {
    originalUserId: number;
    originalUserName: string;
    delegatedUserName: string;
    startDate: Date;
    endDate: Date;
  };
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      delegatedToUser: {
        select: {
          id: true,
          name: true,
          lastname: true,
        },
      },
    },
  });

  if (!user) {
    return { effectiveUserId: userId, isDelegated: false };
  }

  // Check if user has active delegation
  if (
    user.delegatedToUserId &&
    user.delegationStartDate &&
    user.delegationEndDate
  ) {
    const now = new Date();
    const isActiveDelegation =
      now >= user.delegationStartDate && now <= user.delegationEndDate;

    if (isActiveDelegation && user.delegatedToUser) {
      return {
        effectiveUserId: user.delegatedToUserId,
        isDelegated: true,
        delegationInfo: {
          originalUserId: userId,
          originalUserName: `${user.name} ${user.lastname || ""}`.trim(),
          delegatedUserName:
            `${user.delegatedToUser.name} ${user.delegatedToUser.lastname || ""}`.trim(),
          startDate: user.delegationStartDate,
          endDate: user.delegationEndDate,
        },
      };
    }
  }

  return { effectiveUserId: userId, isDelegated: false };
}

// Get delegation info for multiple users (for memo creation)
export const getUsersDelegationInfo: RequestHandler = async (req, res) => {
  try {
    const userIds = req.body.userIds;
    if (!Array.isArray(userIds)) {
      res.status(400).json({ error: "userIds must be an array" });
      return;
    }

    const delegationInfos = await Promise.all(
      userIds.map(async (userId: number) => {
        const user = await prisma.user.findUnique({
          where: { id: userId },
          include: {
            delegatedToUser: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
              },
            },
          },
        });

        if (!user) {
          return {
            originalUserId: userId,
            effectiveUserId: userId,
            isDelegated: false,
          };
        }

        // Check if user has active delegation
        if (
          user.delegatedToUserId &&
          user.delegationStartDate &&
          user.delegationEndDate
        ) {
          const now = new Date();
          const isActiveDelegation =
            now >= user.delegationStartDate && now <= user.delegationEndDate;

          if (isActiveDelegation && user.delegatedToUser) {
            const result = {
              originalUserId: userId,
              effectiveUserId: user.delegatedToUserId,
              isDelegated: true,
              delegationInfo: {
                originalUserId: userId,
                originalUserName: `${user.name} ${user.lastname || ""}`.trim(),
                delegatedUserName:
                  `${user.delegatedToUser.name} ${user.delegatedToUser.lastname || ""}`.trim(),
                startDate: user.delegationStartDate,
                endDate: user.delegationEndDate,
              },
              // Include the delegated user's full info for frontend display
              effectiveUser: {
                id: user.delegatedToUser.id,
                name: user.delegatedToUser.name,
                lastname: user.delegatedToUser.lastname,
                nickname: user.delegatedToUser.nickname,
              },
            };
            return result;
          }
        }

        return {
          originalUserId: userId,
          effectiveUserId: userId,
          isDelegated: false,
        };
      }),
    );

    res.json(delegationInfos);
  } catch (error) {
    console.error("Failed to get users delegation info:", error);
    res.status(500).json({ error: "Failed to get delegation info" });
  }
};

// recall handlers moved to memoRecall.service (Wave 8)
export { recallMemo, recallMemoPreserve } from "../services/memoRecall.service";

// POST /api/memos/:id/action-signature
// approveAction moved to memoApproveAction.service (Wave 7)
export { approveAction } from "../services/memoApproveAction.service";

// ===== MEMO REFERENCE ENDPOINTS (moved to memoReference.service.ts) =====
export {
  searchMemosForReference,
  getMemoReferences,
  updateMemoReferences,
  getReferenceMemoContent,
} from "../services/memoReference.service";

// ─── POST /api/memos/:id/renew-expiry ───
