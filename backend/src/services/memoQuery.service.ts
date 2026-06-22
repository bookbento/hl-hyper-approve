// src/services/memoQuery.service.ts
//
// Wave 6: Read/query handlers extracted from memo.controller.ts
// Contains: getAllMemos, searchMemosHandler, searchMemoStatsHandler,
//           getCurrentApprovers, getMemoById, getApprovers,
//           getMemoApprovalLine, getBusinessUnits, getApprovalLines,
//           getAwaitingApproval
//
// Dependencies consumed (no circular imports):
//   - prisma/client
//   - services/memoAccess.service (canViewMemo)
//   - services/memoSearch.service (searchMemos, getCachedStatCounts)
//   - controllers/memoStatus.controller (toDisplayName, getWaitingStatusId)
//   - lib/token (verifyEmailToken)
//   - lib/filename (decodeFilename)
//   - middlewares/upload (UPLOADS_DIR)
//   - types/request (AuthenticatedRequest)
//   - pdf-lib (PDFDocument)
//   - fs, path (built-in)

import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import path from "path";
import { ActionType } from "@prisma/client";
import { AuthenticatedRequest } from "../types/request";
import {
  getCachedStatCounts,
  searchMemos as searchMemosService,
} from "./memoSearch.service";
import { verifyEmailToken } from "../lib/token";
import { UPLOADS_DIR } from "../middlewares/upload";
import { decodeFilename } from "../lib/filename";
import { canViewMemo } from "./memoAccess.service";
import { toDisplayName } from "../controllers/memoStatus.controller";

// ─────────────────────────────────────────────────────────────────────────────
// Exported helper: resolve the numeric ID of the "waiting" approval status.
// Moved here from memo.controller.ts to break the controller→service circular
// dependency. memo.controller.ts re-exports this symbol via barrel export.
// ─────────────────────────────────────────────────────────────────────────────

export const getWaitingStatusId = async (): Promise<number> => {
  const waiting = await prisma.approvalActionStatus.findFirst({
    where: { code: "waiting" },
    select: { id: true },
  });
  if (!waiting) throw new Error('ต้องมี status code = "waiting"');
  return waiting.id;
};

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper: current waiting approvers for a list of memos
// (Extracted alongside getAllMemos to preserve behaviour parity)
// ─────────────────────────────────────────────────────────────────────────────

async function getCurrentWaitingApprovers(
  memoIds: number[],
): Promise<Record<number, { names: string[]; level: number }>> {
  if (memoIds.length === 0) return {};

  const waitingStatusId = await getWaitingStatusId();

  const latestVersions = await prisma.memoApproverAction.groupBy({
    by: ["memoId"],
    where: { memoId: { in: memoIds } },
    _max: { version: true },
  });

  const versionMap = new Map(
    latestVersions.map((v: any) => [v.memoId, v._max.version ?? 1]),
  );

  const result: Record<number, { names: string[]; level: number }> = {};

  for (const memoId of memoIds) {
    const latestVersion = versionMap.get(memoId) ?? 1;

    const waitingApprovers = await prisma.memoApproverAction.findMany({
      where: {
        memoId,
        statusId: waitingStatusId,
        version: latestVersion,
      },
      include: {
        loaUser: {
          include: {
            user: { select: { name: true, lastname: true, nickname: true } },
          },
        },
      },
      orderBy: { loaUser: { level: "asc" } },
    });

    if (waitingApprovers.length > 0) {
      const lowestLevel = waitingApprovers[0].loaUser.level;
      const approversAtLowestLevel = waitingApprovers.filter(
        (approver) => approver.loaUser.level === lowestLevel,
      );

      result[memoId] = {
        names: approversAtLowestLevel.map(
          (approver) =>
            toDisplayName(approver.loaUser.user, { includeNickname: true }) ||
            `User#${approver.loaUser.userId}`,
        ),
        level: lowestLevel,
      };
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/memos
// ─────────────────────────────────────────────────────────────────────────────

export const getAllMemos: RequestHandler = async (req, res) => {
  const currentUserId = (req as any).user?.id;
  if (!currentUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const memos = await prisma.masterMemo.findMany({
      where: {
        OR: [
          { userId: currentUserId },
          { approverActions: { some: { loaUser: { userId: currentUserId } } } },
          { ccRecipients: { some: { userId: currentUserId } } },
          {
            extraApprovalLines: {
              some: { approvers: { some: { userId: currentUserId } } },
            },
          },
          { commentTags: { some: { userId: currentUserId } } },
        ],
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            lastname: true,
            nickname: true,
            department: { select: { id: true, name: true } },
          },
        },
        department: { select: { id: true, name: true } },
        businessUnit: { select: { id: true, name: true } },
        memoType: { select: { name: true } },
        statuses: {
          include: { status: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        approverActions: {
          where: { loaUser: { userId: currentUserId } },
          select: { id: true },
          take: 1,
        },
        ccRecipients: {
          where: { userId: currentUserId },
          select: { id: true },
          take: 1,
        },
        extraApprovalLines: {
          where: { approvers: { some: { userId: currentUserId } } },
          select: { id: true },
          take: 1,
        },
      },
      orderBy: { id: "desc" },
    });

    const filtered = memos.filter((memo: any) => {
      const latestStatus = memo.statuses[0]?.status?.name ?? "";
      if (latestStatus === "Deleted") return false;
      if (latestStatus === "Draft" && memo.userId !== currentUserId) return false;
      return true;
    });

    if (!filtered.length) {
      res.json([]);
      return;
    }

    const memoIds = filtered.map((m: any) => m.id);

    const latestHistoryRows = await prisma.memoHistory.findMany({
      where: { memoId: { in: memoIds } },
      orderBy: [{ memoId: "asc" }, { timestamp: "desc" }, { id: "desc" }],
      select: {
        id: true,
        memoId: true,
        action: true,
        actiontype: true,
        timestamp: true,
        status: { select: { name: true } },
        user: {
          select: { id: true, name: true, lastname: true, nickname: true },
        },
      },
    });

    const lastHistoryMap = new Map<
      number,
      {
        action: string;
        actiontype: ActionType | null;
        timestamp: Date;
        userName: string;
        statusName: string | null;
      }
    >();

    for (const row of latestHistoryRows) {
      if (lastHistoryMap.has(row.memoId)) continue;
      lastHistoryMap.set(row.memoId, {
        action: row.action,
        actiontype: row.actiontype ?? null,
        timestamp: row.timestamp,
        userName: row.user?.name ?? "-",
        statusName: row.status?.name ?? null,
      });
    }

    const waitingApprovers = await getCurrentWaitingApprovers(memoIds);

    const latestComments = await prisma.comment.findMany({
      where: { memoId: { in: memoIds } },
      orderBy: [{ memoId: "asc" }, { createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        memoId: true,
        comment: true,
        createdAt: true,
        userId: true,
        user: { select: { name: true, lastname: true, nickname: true } },
        attachments: true,
      },
    });

    const latestCommentMap = new Map<
      number,
      {
        id: number;
        userId: number;
        text: string;
        createdAt: Date;
        userName: string;
        userNickname?: string | null;
        attachments: Array<{
          url: string;
          fileName: string;
          mimeType: string | null;
          isImage: boolean;
        }>;
      }
    >();

    const host = (req.protocol + "://" + req.get("host")).replace(/\/+$/, "");
    const normalize = (p: string) =>
      p.startsWith("/api/uploads") ? p.replace(/^\/api/, "") : p;

    for (const c of latestComments) {
      if (latestCommentMap.has(c.memoId)) continue;

      const atts = (c.attachments ?? []).map((att: any) => {
        const pathNormalized = normalize(att.url);
        const fullUrl = `${host}${encodeURI(pathNormalized)}`;
        const fileName =
          (att.filename ?? "").trim() ||
          decodeFilename(path.basename(pathNormalized));
        const mimeType = att.mimetype ?? null;
        const isImage = !!mimeType && mimeType.startsWith("image/");
        return { url: fullUrl, fileName, mimeType, isImage };
      });

      latestCommentMap.set(c.memoId, {
        id: c.id,
        userId: c.userId,
        text: c.comment,
        createdAt: c.createdAt,
        userName:
          [c.user?.name, c.user?.lastname].filter(Boolean).join(" ") || "-",
        userNickname: c.user?.nickname ?? null,
        attachments: atts,
      });
    }

    const result = filtered.map((memo: any) => {
      const lastHis = lastHistoryMap.get(memo.id) || null;
      const lastC = latestCommentMap.get(memo.id) || null;

      const isOwner = memo.userId === currentUserId;
      const isApprover = (memo.approverActions?.length ?? 0) > 0;
      const isCC = (memo.ccRecipients?.length ?? 0) > 0;
      const isExtra = (memo.extraApprovalLines?.length ?? 0) > 0;
      const isTagged = (memo.commentTags?.length ?? 0) > 0;
      const canSeeComments =
        isOwner || isApprover || isCC || isExtra || isTagged;

      return {
        id: memo.id,
        subject: memo.subject,
        documentCode: `MEMO-${memo.id}`,
        memonumber: memo.memonumber,
        user: memo.user,
        department: memo.department,
        businessUnit: memo.businessUnit,
        type: memo.memoType?.name,
        status: memo.statuses[0]?.status?.name ?? "Processing",
        latestApprovedDate: memo.statuses[0]?.createdAt ?? null,
        createdAt: memo.createdAt ?? null,
        currentApprover: waitingApprovers[memo.id] || null,
        expiresAt: memo.expiresAt ?? null,
        canSeeComments,
        latestComment: lastC
          ? {
              id: lastC.id,
              userId: lastC.userId,
              userName: lastC.userName,
              nickname: lastC.userNickname ?? null,
              comment: lastC.text,
              snippet: (lastC.text || "").replace(/\s+/g, " ").slice(0, 120),
              createdAt: lastC.createdAt,
              attachments: lastC.attachments,
            }
          : null,
        lastHistory: lastHis
          ? {
              action: lastHis.action,
              actiontype: lastHis.actiontype,
              timestamp: lastHis.timestamp,
              userName: lastHis.userName,
              statusName: lastHis.statusName,
            }
          : null,
      };
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch memos" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/memos/search
// ─────────────────────────────────────────────────────────────────────────────

export const searchMemosHandler: RequestHandler = async (req, res) => {
  const currentUserId = (req as any).user?.id;
  if (!currentUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const body = req.body ?? {};

    if (
      body.pageSize !== undefined &&
      body.pageSize !== "all" &&
      (typeof body.pageSize !== "number" ||
        body.pageSize < 1 ||
        body.pageSize > 100)
    ) {
      res.status(400).json({ error: "pageSize must be 1-100 or 'all'" });
      return;
    }

    const hostUrl = `${req.protocol}://${req.get("host") ?? ""}`;
    const result = await searchMemosService(body, currentUserId, hostUrl);
    res.json(result);
  } catch (err) {
    console.error("[searchMemosHandler] error:", err);
    res.status(500).json({ error: "Failed to search memos" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/memos/search/stats
// ─────────────────────────────────────────────────────────────────────────────

export const searchMemoStatsHandler: RequestHandler = async (req, res) => {
  const currentUserId = (req as any).user?.id;
  if (!currentUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const forceRefresh =
      req.body?.forceRefresh === true || req.query.refresh === "1";
    const statCounts = await getCachedStatCounts(currentUserId, undefined, {
      forceRefresh,
    });
    res.json({ statCounts });
  } catch (err) {
    console.error("[searchMemoStatsHandler] error:", err);
    res.status(500).json({ error: "Failed to load memo stats" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/memos/current-approvers
// ─────────────────────────────────────────────────────────────────────────────

export const getCurrentApprovers: RequestHandler = async (req, res) => {
  const currentUserId = (req as any).user?.id;
  if (!currentUserId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const memos = await prisma.masterMemo.findMany({
      where: {
        OR: [
          { userId: currentUserId },
          { approverActions: { some: { loaUser: { userId: currentUserId } } } },
          { ccRecipients: { some: { userId: currentUserId } } },
        ],
      },
      select: {
        id: true,
        userId: true,
        statuses: {
          include: { status: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
    });

    const visibleMemoIds = memos
      .filter((m) => {
        const latest = m.statuses[0]?.status?.name ?? "";
        return !(latest === "Draft" && m.userId !== currentUserId);
      })
      .map((m) => m.id);

    if (!visibleMemoIds.length) {
      res.json([]);
      return;
    }

    const latestVersions = await prisma.memoApproverAction.groupBy({
      by: ["memoId"],
      where: { memoId: { in: visibleMemoIds } },
      _max: { version: true },
    });

    const pairs = latestVersions.map((v) => ({
      memoId: v.memoId,
      version: v._max.version ?? 1,
    }));

    const latestActions = await prisma.memoApproverAction.findMany({
      where: {
        OR: pairs.map((p) => ({ memoId: p.memoId, version: p.version })),
      },
      include: {
        loaUser: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
              },
            },
          },
        },
      },
      orderBy: [{ loaUser: { user: { name: "asc" } } }],
    });

    const latestExtraLines = await prisma.extraApprovalLine.groupBy({
      by: ["memoId"],
      where: { memoId: { in: visibleMemoIds } },
      _max: { id: true },
    });

    const extraLineIds = latestExtraLines
      .map((x) => x._max.id)
      .filter((id): id is number => id != null);

    const extraApprovers = extraLineIds.length
      ? await prisma.extraApprover.findMany({
          where: { extraId: { in: extraLineIds } },
          include: {
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
              },
            },
          },
        })
      : [];

    const userMap = new Map<
      number,
      {
        id: number;
        firstName: string | null;
        lastName: string | null;
        nickname: string | null;
        name: string | null;
      }
    >();

    for (const a of latestActions) {
      const u = a.loaUser?.user;
      if (!u) continue;
      userMap.set(u.id, {
        id: u.id,
        firstName: u.name ?? null,
        lastName: u.lastname ?? null,
        nickname: u.nickname ?? null,
        name: u.name ?? null,
      });
    }

    for (const e of extraApprovers) {
      const u = e.user;
      if (!u || userMap.has(u.id)) continue;
      userMap.set(u.id, {
        id: u.id,
        firstName: u.name ?? null,
        lastName: u.lastname ?? null,
        nickname: u.nickname ?? null,
        name: u.name ?? null,
      });
    }

    const uniq = Array.from(userMap.values()).sort((a, b) =>
      (a.firstName ?? "").localeCompare(b.firstName ?? "", undefined, {
        sensitivity: "base",
      }),
    );

    res.json(uniq);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to fetch current approvers" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/memos/:id
// ─────────────────────────────────────────────────────────────────────────────

export const getMemoById: RequestHandler = async (
  req: AuthenticatedRequest,
  res,
  next,
) => {
  const memoId = Number(req.params.id);
  if (isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memo ID" });
    return;
  }

  const viewToken = req.query.token as string | undefined;
  if (viewToken) {
    const payload = verifyEmailToken(viewToken);
    if (!payload || payload.memoId !== memoId) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
  }

  try {
    const latestVer =
      (
        await prisma.memoApproverAction.aggregate({
          where: { memoId },
          _max: { version: true },
        })
      )._max.version ?? 1;

    const memo = await prisma.masterMemo.findUnique({
      where: { id: memoId },
      include: {
        user: {
          select: { id: true, name: true, lastname: true, nickname: true },
        },
        businessUnit: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        memoType: { select: { id: true, name: true } },
        memoNumberRecord: { select: { id: true, memonumber: true } },
        approverActions: {
          where: { version: latestVer },
          orderBy: [{ loaUser: { level: "asc" } }],
          select: {
            status: { select: { id: true, code: true, label: true } },
            actedAt: true,
            createdAt: true,
            updatedAt: true,
            loaUser: {
              select: {
                level: true,
                isSigReq: true,
                userId: true,
                user: {
                  select: {
                    id: true,
                    name: true,
                    lastname: true,
                    profileImagePath: true,
                  },
                },
              },
            },
          },
        },
        signaturePositions: true,
        datePositions: true,
        memoNumberPositions: true,
        notePositions: true,
        mainFiles: {
          select: { id: true, filePath: true, fileName: true, orderNo: true },
        },
        attachedFiles: {
          select: {
            id: true,
            fileName: true,
            filePath: true,
            fileType: true,
            size: true,
            url: true,
            isUrl: true,
          },
        },
        statuses: {
          select: {
            id: true,
            createdAt: true,
            status: { select: { id: true, name: true } },
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
          },
          orderBy: { createdAt: "desc" },
        },
        history: {
          orderBy: [{ timestamp: "asc" }, { id: "asc" }],
          select: {
            id: true,
            action: true,
            actiontype: true,
            timestamp: true,
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
            status: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!memo) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }

    if (!viewToken) {
      const currentUserId = req.user!.id;
      const canView = await canViewMemo(currentUserId, memoId);
      if (!canView) {
        res.status(403).json({ error: "You do not have access to this memo" });
        return;
      }
    }

    const latestStatusPivot = memo.statuses[0];
    if (latestStatusPivot?.status?.name === "Deleted") {
      res.status(404).json({ error: "Memo not found (deleted)" });
      return;
    }

    const filesWithCounts = await Promise.all(
      memo.mainFiles.map(async (f) => {
        try {
          const abs = path.join(UPLOADS_DIR, path.basename(f.filePath));
          if (!fs.existsSync(abs)) {
            console.warn(`[getMemoById] mainFile missing on disk: ${abs}`);
            return {
              id: f.id,
              fileName: f.fileName,
              orderNo: f.orderNo,
              pageCount: null,
              url: `/uploads/${path.basename(f.filePath)}`,
              missing: true,
            };
          }

          const bytes = fs.readFileSync(abs);
          const pdfDoc = await PDFDocument.load(bytes, {
            ignoreEncryption: true,
          });
          return {
            id: f.id,
            fileName: f.fileName,
            orderNo: f.orderNo,
            pageCount: pdfDoc.getPageCount(),
            url: `/uploads/${path.basename(f.filePath)}`,
          };
        } catch (e) {
          console.error(
            `[getMemoById] PDF load error for mainFile id=${f.id}`,
            e,
          );
          return {
            id: f.id,
            fileName: f.fileName,
            orderNo: f.orderNo,
            pageCount: null,
            url: `/uploads/${path.basename(f.filePath)}`,
            broken: true,
          };
        }
      }),
    );

    const attachedFiles = memo.attachedFiles.map((f) => ({
      id: f.id,
      fileName: f.fileName,
      fileType: f.fileType,
      size: f.size,
      url: f.isUrl
        ? f.url
        : `/uploads/attached/${path.basename(f.filePath || "")}`,
      isUrl: f.isUrl,
    }));

    const approverRows = memo.approverActions.map((a) => {
      const code = a.status.code;
      const since =
        code === "waiting"
          ? a.createdAt
          : code === "approved" || code === "rejected"
            ? a.actedAt
            : a.updatedAt;

      return {
        level: a.loaUser.level,
        isSigReq: a.loaUser.isSigReq,
        userId: a.loaUser.userId,
        user: a.loaUser.user,
        statusCode: code,
        actedAt: a.actedAt,
        since,
      };
    });

    res.json({
      ...memo,
      approverActions: approverRows,
      mainFiles: filesWithCounts,
      attachedFiles,
    });
  } catch (err) {
    console.error("getMemoById error:", err);
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/memos/:id/approvers
// ─────────────────────────────────────────────────────────────────────────────

export const getApprovers: RequestHandler = async (req, res, next) => {
  try {
    const memoId = Number(req.params.id);
    if (Number.isNaN(memoId)) {
      res.status(400).json({ error: "Invalid memo ID" });
      return;
    }

    const memo = (await prisma.masterMemo.findUnique({
      where: { id: memoId },
    })) as any;

    if (!memo) {
      res.status(404).json({ error: "Memo not found" });
      return;
    }

    const rows = await prisma.memoApproverAction.findMany({
      where: { memoId },
      orderBy: { loaUser: { level: "asc" } },
      include: {
        loaUser: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
              },
            },
          },
        },
      },
    });

    const approvers = rows
      .filter((r) => r.loaUser.user)
      .map((r) => ({
        id: r.loaUser.user!.id,
        name: r.loaUser.user!.name,
      }));

    res.json(approvers);
  } catch (err) {
    next(err);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/memos/:id/approval-line
// ─────────────────────────────────────────────────────────────────────────────

export const getMemoApprovalLine: RequestHandler = async (req, res) => {
  try {
    const memoId = Number(req.params.id);
    console.log(
      `[getMemoApprovalLine] ========== START ========== memoId=${memoId}`,
    );

    if (Number.isNaN(memoId)) {
      res.status(400).json({ error: "Invalid memo ID" });
      return;
    }

    const userId = req.user!.id;
    const canView = await canViewMemo(userId, memoId);
    if (!canView) {
      console.log(`[getMemoApprovalLine] Access denied for user ${userId}`);
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const { _max } = await prisma.memoApproverAction.aggregate({
      where: { memoId },
      _max: { version: true },
    });
    const latestVersion = _max.version ?? 1;
    console.log(`[getMemoApprovalLine] Latest version: ${latestVersion}`);

    const actions = await prisma.memoApproverAction.findMany({
      where: { memoId, version: latestVersion },
      include: {
        status: { select: { code: true } },
        loaUser: {
          select: {
            level: true,
            userId: true,
            isSigReq: true,
            approvalRequirement: true,
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
                delegatedToUserId: true,
                delegationStartDate: true,
                delegationEndDate: true,
                delegatedToUser: {
                  select: {
                    id: true,
                    name: true,
                    lastname: true,
                    nickname: true,
                  },
                },
              },
            },
          },
        },
        actualActor: {
          select: {
            id: true,
            name: true,
            lastname: true,
            nickname: true,
          },
        },
      },
      orderBy: [{ loaUserId: "asc" }],
    });

    console.log(`[getMemoApprovalLine] Found ${actions.length} actions`);

    const levelApprovalStatus = new Map<
      number,
      {
        hasApproval: boolean;
        requirement: string;
        approvedBy?: string;
      }
    >();

    for (const action of actions) {
      const level = action.loaUser.level;
      if (!levelApprovalStatus.has(level)) {
        levelApprovalStatus.set(level, {
          hasApproval: false,
          requirement: action.loaUser.approvalRequirement || "ALL",
        });
      }
      if (action.status?.code === "approved") {
        const levelStatus = levelApprovalStatus.get(level)!;
        levelStatus.hasApproval = true;
        const user = action.loaUser.user;
        levelStatus.approvedBy = user
          ? toDisplayName(user, { includeNickname: true })
          : `User#${action.loaUser.userId}`;
      }
    }

    console.log(
      `[getMemoApprovalLine] Level approval status:`,
      JSON.stringify(
        Array.from(levelApprovalStatus.entries()).map(([level, status]) => ({
          level,
          requirement: status.requirement,
          hasApproval: status.hasApproval,
          approvedBy: status.approvedBy,
        })),
        null,
        2,
      ),
    );

    const levelMap: Record<number, any[]> = {};

    for (const action of actions) {
      const level = action.loaUser.level;
      if (!levelMap[level]) {
        levelMap[level] = [];
      }

      if (action.loaUser.user) {
        const originalUser = action.loaUser.user;
        let displayUser: {
          id: number;
          name: string;
          lastname: string | null;
          nickname: string | null;
        } = {
          id: originalUser.id,
          name: originalUser.name,
          lastname: originalUser.lastname,
          nickname: originalUser.nickname,
        };

        if (
          originalUser.delegatedToUserId &&
          originalUser.delegationStartDate &&
          originalUser.delegationEndDate
        ) {
          const now = new Date();
          const isActiveDelegation =
            now >= originalUser.delegationStartDate &&
            now <= originalUser.delegationEndDate;

          if (isActiveDelegation && originalUser.delegatedToUser) {
            displayUser = {
              id: originalUser.delegatedToUser.id,
              name: originalUser.delegatedToUser.name,
              lastname: originalUser.delegatedToUser.lastname,
              nickname: originalUser.delegatedToUser.nickname,
            };
          }
        }

        if (action.actualActorId && action.actualActor) {
          displayUser = {
            id: action.actualActor.id,
            name: action.actualActor.name,
            lastname: action.actualActor.lastname,
            nickname: action.actualActor.nickname,
          };
        }

        const displayName = toDisplayName(displayUser, {
          includeNickname: true,
        });
        const statusCode = action.status?.code || "waiting";

        const levelStatus = levelApprovalStatus.get(level);
        const isLevelSatisfied =
          levelStatus?.requirement === "ANY" && levelStatus?.hasApproval;
        const finalStatus =
          statusCode === "waiting" && isLevelSatisfied
            ? "not_required"
            : statusCode;

        console.log(
          `[getMemoApprovalLine] User ${displayUser.id} (${displayName}) at level ${level}: originalStatus=${statusCode}, finalStatus=${finalStatus}, requirement=${levelStatus?.requirement}, hasApproval=${levelStatus?.hasApproval}, isLevelSatisfied=${isLevelSatisfied}`,
        );

        levelMap[level].push({
          id: displayUser.id,
          name: displayName,
          level,
          loaUserPivotId: action.loaUserId,
          status: finalStatus,
          actedAt: action.actedAt,
          since: action.createdAt,
          isSigReq: action.loaUser.isSigReq || false,
          approvalRequirement: action.loaUser.approvalRequirement || "ALL",
          isLevelSatisfied: isLevelSatisfied || false,
          approvedBy: levelStatus?.approvedBy,
        });
      }
    }

    const levels = Object.keys(levelMap)
      .map((level) => Number(level))
      .sort((a, b) => a - b)
      .map((level) => ({
        level,
        users: levelMap[level],
      }));

    const memo = await prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { approvalLineId: true },
    });

    console.log(
      `[getMemoApprovalLine] Returning ${levels.length} levels with ${levels.reduce((sum, l) => sum + l.users.length, 0)} total users`,
    );
    console.log(`[getMemoApprovalLine] ========== END ==========`);

    res.json({
      id: memo?.approvalLineId || null,
      levels,
    });
  } catch (error) {
    console.error("[getMemoApprovalLine] ERROR:", error);
    res.status(500).json({ error: "Failed to get memo approval line" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/business-units
// ─────────────────────────────────────────────────────────────────────────────

export const getBusinessUnits: RequestHandler = async (_req, res) => {
  try {
    const businessUnits = await prisma.businessUnit.findMany({
      include: {
        departments: true,
      },
    });
    res.json(businessUnits);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch business units" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/approval-lines
// ─────────────────────────────────────────────────────────────────────────────

export const getApprovalLines: RequestHandler = async (_req, res) => {
  try {
    const approvalLines = await prisma.lineOfApproval.findMany({
      include: {
        approvalUsers: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
              },
            },
          },
        },
        businessUnit: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });
    res.json(approvalLines);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch approval lines" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/memos/awaiting-approval
// ─────────────────────────────────────────────────────────────────────────────

export const getAwaitingApproval: RequestHandler = async (req, res) => {
  const me = req.user!.id;

  const [waitingStatus, approvedStatus] = await prisma.approvalActionStatus
    .findMany({
      where: { code: { in: ["waiting", "approved"] } },
      select: { id: true, code: true },
    })
    .then((list) => [
      list.find((s) => s.code === "waiting")?.id,
      list.find((s) => s.code === "approved")?.id,
    ]);

  if (!waitingStatus || !approvedStatus) {
    res.status(500).json({ error: "Missing status codes" });
    return;
  }

  const myLatestActions = await prisma.memoApproverAction.findMany({
    where: { loaUser: { userId: me } },
    orderBy: [{ version: "desc" }],
    distinct: ["memoId"],
    select: {
      memoId: true,
      statusId: true,
      version: true,
      loaUser: { select: { level: true } },
      memo: { select: { subject: true, user: { select: { name: true } } } },
    },
  });

  const myWaitingActions = myLatestActions.filter(
    (a) => a.statusId === waitingStatus,
  );

  const result: {
    id: number;
    subject: string;
    createdBy: string;
    latestStatus: string;
  }[] = [];

  for (const action of myWaitingActions) {
    const { memoId, version, loaUser } = action;
    const myLevel = loaUser.level;

    const prevActions = await prisma.memoApproverAction.findMany({
      where: {
        memoId,
        version,
        loaUser: { level: { lt: myLevel } },
      },
      select: { loaUserId: true },
    });

    const prevIds = prevActions.map((a) => a.loaUserId);
    if (prevIds.length === 0) {
      result.push({
        id: memoId,
        subject: action.memo.subject,
        createdBy: action.memo.user.name,
        latestStatus: "Processing",
      });
      continue;
    }

    const latestVersions = await prisma.memoApproverAction.groupBy({
      by: ["loaUserId"],
      where: { memoId, version, loaUserId: { in: prevIds } },
      _max: { id: true },
    });
    const prevLatest = await prisma.memoApproverAction.findMany({
      where: {
        memoId,
        version,
        OR: latestVersions.map((v) => ({ loaUserId: v.loaUserId })),
      },
      select: { statusId: true },
    });

    const allPrevApproved =
      prevLatest.length === prevIds.length &&
      prevLatest.every((a) => a.statusId === approvedStatus);
    if (allPrevApproved) {
      result.push({
        id: memoId,
        subject: action.memo.subject,
        createdBy: action.memo.user.name,
        latestStatus: "Processing",
      });
    }
  }

  const memoIds = result.map((r) => r.id);
  const statuses = await prisma.memoStatusPivot.findMany({
    where: { memoId: { in: memoIds } },
    orderBy: { createdAt: "desc" },
    distinct: ["memoId"],
    include: { status: { select: { id: true, name: true } } },
  });

  const statusMap = new Map<number, { id: number; name: string }>();
  statuses.forEach((s) =>
    statusMap.set(s.memoId, { id: s.status.id, name: s.status.name }),
  );

  const final = result
    .filter((r) => statusMap.get(r.id)?.id === 5)
    .map((r) => ({
      id: r.id,
      subject: r.subject,
      createdBy: r.createdBy,
      latestStatus: statusMap.get(r.id)!.name,
    }));

  res.json(final);
};
