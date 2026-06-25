/**
 * MemoQueryService (Nest)
 *
 * Port of backend/src/services/memoQuery.service.ts — pure logic, no req/res.
 * Handles: getAllMemos, getMemoById, getAwaitingApproval, getCurrentApprovers,
 *          getUsersDelegationInfo
 *
 * Heavy search pipeline (searchMemos / getCachedStatCounts) is delegated to
 * MemoSearchService to keep file sizes within the 800-line budget.
 */
import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoAccessService } from './memo-access.service';
import { ActionType } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { PDFDocument } from 'pdf-lib';

// Resolve uploads dir — mirrors Express UPLOADS_DIR
const UPLOADS_DIR = process.env['UPLOADS_DIR'] ?? path.join(process.cwd(), '..', '..', 'uploads');

// ── helper: display name ──────────────────────────────────────────────────────

function toDisplayName(
  user: { name: string; lastname?: string | null; nickname?: string | null } | null | undefined,
  opts: { includeNickname?: boolean } = {},
): string {
  if (!user) return '';
  const parts = [user.name, user.lastname].filter(Boolean).join(' ');
  const nick = opts.includeNickname && user.nickname ? ` (${user.nickname})` : '';
  return `${parts}${nick}`.trim();
}

// ── helper: getWaitingStatusId ────────────────────────────────────────────────

async function getWaitingStatusId(prisma: PrismaService): Promise<number> {
  const waiting = await prisma.approvalActionStatus.findFirst({
    where: { code: 'waiting' },
    select: { id: true },
  });
  if (!waiting) throw new Error('ต้องมี status code = "waiting"');
  return waiting.id;
}

// ── helper: getCurrentWaitingApprovers ───────────────────────────────────────

async function getCurrentWaitingApprovers(
  prisma: PrismaService,
  memoIds: number[],
): Promise<Record<number, { names: string[]; level: number }>> {
  if (memoIds.length === 0) return {};

  const waitingStatusId = await getWaitingStatusId(prisma);

  const latestVersions = await prisma.memoApproverAction.groupBy({
    by: ['memoId'],
    where: { memoId: { in: memoIds } },
    _max: { version: true },
  });

  const versionMap = new Map(
    latestVersions.map((v: { memoId: number; _max: { version: number | null } }) => [
      v.memoId,
      v._max.version ?? 1,
    ]),
  );

  const result: Record<number, { names: string[]; level: number }> = {};

  for (const memoId of memoIds) {
    const latestVersion = versionMap.get(memoId) ?? 1;

    const waitingApprovers = await prisma.memoApproverAction.findMany({
      where: { memoId, statusId: waitingStatusId, version: latestVersion },
      include: {
        loaUser: {
          include: {
            user: { select: { name: true, lastname: true, nickname: true } },
          },
        },
      },
      orderBy: { loaUser: { level: 'asc' } },
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

// ── helper: decode filename ───────────────────────────────────────────────────

function decodeFilename(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

// ── helper: verify email token ────────────────────────────────────────────────
// Kept minimal — just validate structure without full JWT lib dependency

function verifyEmailToken(token: string): { memoId: number } | null {
  try {
    const jwt = require('jsonwebtoken') as typeof import('jsonwebtoken');
    const secret = process.env['EMAIL_TOKEN_SECRET'] ?? process.env['JWT_SECRET'] ?? 'changeme';
    const payload = jwt.verify(token, secret) as { memoId?: number };
    if (typeof payload?.memoId !== 'number') return null;
    return { memoId: payload.memoId };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

@Injectable()
export class MemoQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly memoAccess: MemoAccessService,
  ) {}

  // ── GET /api/memos ──────────────────────────────────────────────────────────

  async getAllMemos(currentUserId: number, hostUrl: string) {
    const memos = await this.prisma.masterMemo.findMany({
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
          orderBy: { createdAt: 'desc' },
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
      orderBy: { id: 'desc' },
    });

    const filtered = memos.filter((memo) => {
      const latestStatus = (memo.statuses[0] as any)?.status?.name ?? '';
      if (latestStatus === 'Deleted') return false;
      if (latestStatus === 'Draft' && memo.userId !== currentUserId) return false;
      return true;
    });

    if (!filtered.length) return [];

    const memoIds = filtered.map((m) => m.id);

    const latestHistoryRows = await this.prisma.memoHistory.findMany({
      where: { memoId: { in: memoIds } },
      orderBy: [{ memoId: 'asc' }, { timestamp: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        memoId: true,
        action: true,
        actiontype: true,
        timestamp: true,
        status: { select: { name: true } },
        user: { select: { id: true, name: true, lastname: true, nickname: true } },
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
        userName: row.user?.name ?? '-',
        statusName: row.status?.name ?? null,
      });
    }

    const waitingApprovers = await getCurrentWaitingApprovers(this.prisma, memoIds);

    const latestComments = await this.prisma.comment.findMany({
      where: { memoId: { in: memoIds } },
      orderBy: [{ memoId: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
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

    const host = hostUrl.replace(/\/+$/, '');
    const normalizeUrl = (p: string) =>
      p.startsWith('/api/uploads') ? p.replace(/^\/api/, '') : p;

    for (const c of latestComments) {
      if (latestCommentMap.has(c.memoId)) continue;

      const atts = ((c as any).attachments ?? []).map((att: any) => {
        const pathNormalized = normalizeUrl(att.url);
        const fullUrl = `${host}${encodeURI(pathNormalized)}`;
        const fileName =
          (att.filename ?? '').trim() ||
          decodeFilename(path.basename(pathNormalized));
        const mimeType = att.mimetype ?? null;
        const isImage = !!mimeType && mimeType.startsWith('image/');
        return { url: fullUrl, fileName, mimeType, isImage };
      });

      latestCommentMap.set(c.memoId, {
        id: c.id,
        userId: c.userId,
        text: c.comment,
        createdAt: c.createdAt,
        userName: [c.user?.name, c.user?.lastname].filter(Boolean).join(' ') || '-',
        userNickname: c.user?.nickname ?? null,
        attachments: atts,
      });
    }

    return filtered.map((memo) => {
      const lastHis = lastHistoryMap.get(memo.id) || null;
      const lastC = latestCommentMap.get(memo.id) || null;

      const isOwner = memo.userId === currentUserId;
      const isApprover = (memo.approverActions?.length ?? 0) > 0;
      const isCC = (memo.ccRecipients?.length ?? 0) > 0;
      const isExtra = (memo.extraApprovalLines?.length ?? 0) > 0;
      const canSeeComments = isOwner || isApprover || isCC || isExtra;

      return {
        id: memo.id,
        subject: memo.subject,
        documentCode: `MEMO-${memo.id}`,
        memonumber: memo.memonumber,
        user: memo.user,
        department: memo.department,
        businessUnit: memo.businessUnit,
        type: (memo as any).memoType?.name,
        status: (memo.statuses[0] as any)?.status?.name ?? 'Processing',
        latestApprovedDate: memo.statuses[0]?.createdAt ?? null,
        createdAt: (memo as any).createdAt ?? null,
        currentApprover: waitingApprovers[memo.id] || null,
        expiresAt: (memo as any).expiresAt ?? null,
        canSeeComments,
        latestComment: lastC
          ? {
              id: lastC.id,
              userId: lastC.userId,
              userName: lastC.userName,
              nickname: lastC.userNickname ?? null,
              comment: lastC.text,
              snippet: (lastC.text || '').replace(/\s+/g, ' ').slice(0, 120),
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
  }

  // ── GET /api/memos/:id ──────────────────────────────────────────────────────

  async getMemoById(
    memoId: number,
    currentUserId: number | null,
    viewToken?: string,
  ) {
    if (isNaN(memoId)) throw new BadRequestException('Invalid memo ID');

    if (viewToken) {
      const payload = verifyEmailToken(viewToken);
      if (!payload || payload.memoId !== memoId) {
        throw new ForbiddenException('Invalid or expired token');
      }
    }

    const latestVer =
      (
        await this.prisma.memoApproverAction.aggregate({
          where: { memoId },
          _max: { version: true },
        })
      )._max.version ?? 1;

    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      include: {
        user: { select: { id: true, name: true, lastname: true, nickname: true } },
        businessUnit: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        memoType: { select: { id: true, name: true } },
        memoNumberRecord: { select: { id: true, memonumber: true } },
        approverActions: {
          where: { version: latestVer },
          orderBy: [{ loaUser: { level: 'asc' } }],
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
            user: { select: { id: true, name: true, lastname: true, nickname: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        history: {
          orderBy: [{ timestamp: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            action: true,
            actiontype: true,
            timestamp: true,
            user: { select: { id: true, name: true, lastname: true, nickname: true } },
            status: { select: { id: true, name: true } },
          },
        },
      },
    });

    if (!memo) throw new NotFoundException('Memo not found');

    if (!viewToken) {
      if (currentUserId === null) throw new ForbiddenException('Unauthorized');
      const canView = await this.memoAccess.canViewMemo(currentUserId, memoId);
      if (!canView) {
        throw new ForbiddenException('You do not have access to this memo');
      }
    }

    const latestStatusPivot = memo.statuses[0];
    if ((latestStatusPivot as any)?.status?.name === 'Deleted') {
      throw new NotFoundException('Memo not found (deleted)');
    }

    const filesWithCounts = await Promise.all(
      memo.mainFiles.map(async (f) => {
        try {
          const abs = path.join(UPLOADS_DIR, path.basename(f.filePath));
          if (!fs.existsSync(abs)) {
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
          const pdfDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });
          return {
            id: f.id,
            fileName: f.fileName,
            orderNo: f.orderNo,
            pageCount: pdfDoc.getPageCount(),
            url: `/uploads/${path.basename(f.filePath)}`,
          };
        } catch {
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
        : `/uploads/attached/${path.basename(f.filePath || '')}`,
      isUrl: f.isUrl,
    }));

    const approverRows = memo.approverActions.map((a) => {
      const code = (a.status as any).code as string;
      const since =
        code === 'waiting'
          ? a.createdAt
          : code === 'approved' || code === 'rejected'
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

    return {
      ...memo,
      approverActions: approverRows,
      mainFiles: filesWithCounts,
      attachedFiles,
    };
  }

  // ── GET /api/memos/awaiting-approval ────────────────────────────────────────

  async getAwaitingApproval(userId: number) {
    const [waitingStatus, approvedStatus] = await this.prisma.approvalActionStatus
      .findMany({
        where: { code: { in: ['waiting', 'approved'] } },
        select: { id: true, code: true },
      })
      .then((list) => [
        list.find((s) => s.code === 'waiting')?.id,
        list.find((s) => s.code === 'approved')?.id,
      ]);

    if (!waitingStatus || !approvedStatus) {
      throw new Error('Missing status codes');
    }

    const myLatestActions = await this.prisma.memoApproverAction.findMany({
      where: { loaUser: { userId } },
      orderBy: [{ version: 'desc' }],
      distinct: ['memoId'],
      select: {
        memoId: true,
        statusId: true,
        version: true,
        loaUser: { select: { level: true } },
        memo: { select: { subject: true, user: { select: { name: true } } } },
      },
    });

    const myWaitingActions = myLatestActions.filter((a) => a.statusId === waitingStatus);

    const result: { id: number; subject: string; createdBy: string; latestStatus: string }[] = [];

    for (const action of myWaitingActions) {
      const { memoId, version, loaUser } = action;
      const myLevel = loaUser.level;

      const prevActions = await this.prisma.memoApproverAction.findMany({
        where: { memoId, version, loaUser: { level: { lt: myLevel } } },
        select: { loaUserId: true },
      });

      const prevIds = prevActions.map((a) => a.loaUserId);
      if (prevIds.length === 0) {
        result.push({
          id: memoId,
          subject: action.memo.subject,
          createdBy: action.memo.user.name,
          latestStatus: 'Processing',
        });
        continue;
      }

      const latestVersions = await this.prisma.memoApproverAction.groupBy({
        by: ['loaUserId'],
        where: { memoId, version, loaUserId: { in: prevIds } },
        _max: { id: true },
      });
      const prevLatest = await this.prisma.memoApproverAction.findMany({
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
          latestStatus: 'Processing',
        });
      }
    }

    const memoIds = result.map((r) => r.id);
    const statuses = await this.prisma.memoStatusPivot.findMany({
      where: { memoId: { in: memoIds } },
      orderBy: { createdAt: 'desc' },
      distinct: ['memoId'],
      include: { status: { select: { id: true, name: true } } },
    });

    const statusMap = new Map<number, { id: number; name: string }>();
    statuses.forEach((s) => statusMap.set(s.memoId, { id: s.status.id, name: s.status.name }));

    return result
      .filter((r) => statusMap.get(r.id)?.id === 5)
      .map((r) => ({
        id: r.id,
        subject: r.subject,
        createdBy: r.createdBy,
        latestStatus: statusMap.get(r.id)!.name,
      }));
  }

  // ── GET /api/memos/current-approvers ────────────────────────────────────────

  async getCurrentApprovers(currentUserId: number) {
    const memos = await this.prisma.masterMemo.findMany({
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
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const visibleMemoIds = memos
      .filter((m) => {
        const latest = (m.statuses[0] as any)?.status?.name ?? '';
        return !(latest === 'Draft' && m.userId !== currentUserId);
      })
      .map((m) => m.id);

    if (!visibleMemoIds.length) return [];

    const latestVersions = await this.prisma.memoApproverAction.groupBy({
      by: ['memoId'],
      where: { memoId: { in: visibleMemoIds } },
      _max: { version: true },
    });

    const pairs = latestVersions.map((v) => ({
      memoId: v.memoId,
      version: v._max.version ?? 1,
    }));

    const latestActions = await this.prisma.memoApproverAction.findMany({
      where: { OR: pairs.map((p) => ({ memoId: p.memoId, version: p.version })) },
      include: {
        loaUser: {
          include: {
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
          },
        },
      },
      orderBy: [{ loaUser: { user: { name: 'asc' } } }],
    });

    const latestExtraLines = await this.prisma.extraApprovalLine.groupBy({
      by: ['memoId'],
      where: { memoId: { in: visibleMemoIds } },
      _max: { id: true },
    });

    const extraLineIds = latestExtraLines
      .map((x) => x._max.id)
      .filter((id): id is number => id != null);

    const extraApprovers = extraLineIds.length
      ? await this.prisma.extraApprover.findMany({
          where: { extraId: { in: extraLineIds } },
          include: {
            user: {
              select: { id: true, name: true, lastname: true, nickname: true },
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

    return Array.from(userMap.values()).sort((a, b) =>
      (a.firstName ?? '').localeCompare(b.firstName ?? '', undefined, {
        sensitivity: 'base',
      }),
    );
  }

  // ── POST /api/memos/users-delegation-info ────────────────────────────────────

  async getUsersDelegationInfo(userIds: number[]) {
    if (!Array.isArray(userIds)) {
      throw new BadRequestException('userIds must be an array');
    }

    return Promise.all(
      userIds.map(async (userId: number) => {
        const user = await this.prisma.user.findUnique({
          where: { id: userId },
          include: {
            delegatedToUser: {
              select: { id: true, name: true, lastname: true, nickname: true },
            },
          },
        });

        if (!user) {
          return { originalUserId: userId, effectiveUserId: userId, isDelegated: false };
        }

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
              originalUserId: userId,
              effectiveUserId: user.delegatedToUserId,
              isDelegated: true,
              delegationInfo: {
                originalUserId: userId,
                originalUserName: `${user.name} ${user.lastname || ''}`.trim(),
                delegatedUserName:
                  `${user.delegatedToUser.name} ${user.delegatedToUser.lastname || ''}`.trim(),
                startDate: user.delegationStartDate,
                endDate: user.delegationEndDate,
              },
              effectiveUser: {
                id: user.delegatedToUser.id,
                name: user.delegatedToUser.name,
                lastname: user.delegatedToUser.lastname,
                nickname: user.delegatedToUser.nickname,
              },
            };
          }
        }

        return { originalUserId: userId, effectiveUserId: userId, isDelegated: false };
      }),
    );
  }
}
