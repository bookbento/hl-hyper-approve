/**
 * ApproverStatusService (Nest) — per-approver progress shown on the dashboard.
 * Ported from backend memoStatus.controller getApproverStatus / getApproverStatusBulk.
 *
 *   GET  /api/memos/:id/approver-status
 *   POST /api/memos/approver-status/bulk   { memoIds } → Record<memoId, rows>
 *
 * Both use the bulk endpoint's visibility rule (mirrors the memo list). Express
 * checked nothing on the single-memo route.
 */
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { toDisplayName } from '../memo-query/search/display-name';

const SNAPSHOT_SELECT = {
  memoId: true,
  loaUserId: true,
  actedAt: true,
  createdAt: true,
  status: { select: { code: true } },
  loaUser: {
    select: {
      level: true,
      userId: true,
      approvalRequirement: true,
      user: { select: { name: true, lastname: true, nickname: true } },
    },
  },
} satisfies Prisma.MemoApproverActionSelect;

type SnapshotRow = Prisma.MemoApproverActionGetPayload<{ select: typeof SNAPSHOT_SELECT }>;

type LinePivot = {
  userId: number | null;
  level: number;
  user: { name: string | null; lastname: string | null; nickname: string | null } | null;
};

const MAX_BULK = 5000;

@Injectable()
export class ApproverStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async getOne(memoId: number, userId: number) {
    if (Number.isNaN(memoId)) throw new BadRequestException({ error: 'Invalid memo ID' });
    const visible = await this.visibleMemos(userId, [memoId]);
    if (!visible.length) throw new ForbiddenException({ error: 'Access denied' });

    const result = await this.build(visible);
    return result[memoId] ?? [];
  }

  async getBulk(userId: number, rawMemoIds: unknown): Promise<Record<number, unknown[]>> {
    const raw = rawMemoIds ?? [];
    if (!Array.isArray(raw)) throw new BadRequestException({ error: 'memoIds must be an array' });

    const memoIds = Array.from(
      new Set(raw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)),
    );
    if (memoIds.length === 0) return {};
    if (memoIds.length > MAX_BULK) {
      throw new BadRequestException({ error: `Too many memoIds (max ${MAX_BULK})` });
    }

    const visible = await this.visibleMemos(userId, memoIds);
    if (!visible.length) return {};
    return this.build(visible);
  }

  /** Visibility filter — mirrors the memo list; drops Deleted and other people's Drafts. */
  private async visibleMemos(userId: number, memoIds: number[]) {
    const memos = await this.prisma.masterMemo.findMany({
      where: {
        id: { in: memoIds },
        OR: [
          { userId },
          { approverActions: { some: { loaUser: { userId } } } },
          { ccRecipients: { some: { userId } } },
          { extraApprovalLines: { some: { approvers: { some: { userId } } } } },
          { commentTags: { some: { userId } } },
        ],
      },
      select: {
        id: true,
        userId: true,
        approvalLineId: true,
        statuses: { include: { status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    return memos.filter((m) => {
      const latest = m.statuses?.[0]?.status?.name ?? '';
      if (latest === 'Deleted') return false;
      if (latest === 'Draft' && m.userId !== userId) return false;
      return true;
    });
  }

  private async build(
    memos: { id: number; approvalLineId: number | null }[],
  ): Promise<Record<number, unknown[]>> {
    const ids = memos.map((m) => m.id);

    const latestVersions = await this.prisma.memoApproverAction.groupBy({
      by: ['memoId'],
      where: { memoId: { in: ids } },
      _max: { version: true },
    });
    const versionByMemo = new Map<number, number>();
    for (const v of latestVersions) versionByMemo.set(v.memoId, v._max.version ?? 1);

    const snapshotRows = versionByMemo.size
      ? await this.prisma.memoApproverAction.findMany({
          where: {
            OR: Array.from(versionByMemo.entries()).map(([memoId, version]) => ({
              memoId,
              version,
            })),
          },
          select: SNAPSHOT_SELECT,
          orderBy: [{ memoId: 'asc' }, { loaUser: { level: 'asc' } }, { loaUserId: 'asc' }],
        })
      : [];
    const snapshotByMemo = new Map<number, SnapshotRow[]>();
    for (const r of snapshotRows) {
      const list = snapshotByMemo.get(r.memoId);
      if (list) list.push(r);
      else snapshotByMemo.set(r.memoId, [r]);
    }

    // Memos without a snapshot (still Draft) fall back to the approval line template.
    const lineIds = new Set<number>();
    for (const m of memos) {
      if (!snapshotByMemo.has(m.id) && m.approvalLineId) lineIds.add(m.approvalLineId);
    }
    const pivots = lineIds.size
      ? await this.prisma.lineOfApprovalUserPivot.findMany({
          where: { lineOfApprovalId: { in: Array.from(lineIds) } },
          select: {
            lineOfApprovalId: true,
            userId: true,
            level: true,
            user: { select: { name: true, lastname: true, nickname: true } },
          },
          orderBy: [{ level: 'asc' }, { userId: 'asc' }],
        })
      : [];
    const pivotsByLine = new Map<number, LinePivot[]>();
    for (const p of pivots) {
      if (p.lineOfApprovalId == null) continue;
      const list = pivotsByLine.get(p.lineOfApprovalId);
      if (list) list.push(p);
      else pivotsByLine.set(p.lineOfApprovalId, [p]);
    }

    const result: Record<number, unknown[]> = {};
    for (const m of memos) {
      const snapshot = snapshotByMemo.get(m.id);
      result[m.id] = snapshot?.length
        ? fromSnapshot(snapshot)
        : fromLine(m.approvalLineId ? (pivotsByLine.get(m.approvalLineId) ?? []) : []);
    }
    return result;
  }
}

const nameOf = (u: LinePivot['user'], userId: number | null) =>
  toDisplayName(u, { includeNickname: true }) || `User#${userId}`;

function fromSnapshot(snapshot: SnapshotRow[]) {
  const roundStart = new Date(
    Math.min(...snapshot.map((r) => r.createdAt?.getTime() ?? Date.now())),
  );

  const levelStatus = new Map<
    number,
    { hasApproval: boolean; requirement: string; approvedBy?: string }
  >();
  for (const row of snapshot) {
    const level = row.loaUser.level;
    if (!levelStatus.has(level)) {
      levelStatus.set(level, {
        hasApproval: false,
        requirement: row.loaUser.approvalRequirement || 'ALL',
      });
    }
    if (row.status?.code === 'approved') {
      const ls = levelStatus.get(level)!;
      ls.hasApproval = true;
      ls.approvedBy = nameOf(row.loaUser.user, row.loaUser.userId);
    }
  }

  return snapshot.map((row) => {
    const code = row.status?.code ?? 'waiting';
    const ls = levelStatus.get(row.loaUser.level);
    const isLevelSatisfied = ls?.requirement === 'ANY' && ls?.hasApproval;
    const base = {
      userId: row.loaUser.userId,
      name: nameOf(row.loaUser.user, row.loaUser.userId),
      level: row.loaUser.level,
    };

    if (code !== 'waiting') {
      const since = row.actedAt ?? row.createdAt ?? null;
      return {
        ...base,
        statusCode: code,
        actedAt: row.actedAt?.toISOString(),
        since: since ? since.toISOString() : null,
        approvalRequirement: row.loaUser.approvalRequirement || 'ALL',
        isLevelSatisfied,
        approvedBy: ls?.approvedBy,
      };
    }

    if (isLevelSatisfied) {
      return {
        ...base,
        statusCode: 'not_required',
        actedAt: undefined,
        since: null,
        approvalRequirement: row.loaUser.approvalRequirement || 'ALL',
        isLevelSatisfied: true,
        approvedBy: ls?.approvedBy,
      };
    }

    // Still waiting: count from the latest lower-level approver who acted.
    const prevDone = snapshot
      .filter(
        (s) =>
          s.loaUser.level < row.loaUser.level &&
          (s.status?.code === 'approved' || s.status?.code === 'rejected') &&
          s.actedAt,
      )
      .sort((a, b) => b.loaUser.level - a.loaUser.level)[0];
    const borrowedSince = prevDone?.actedAt ?? roundStart;

    return {
      ...base,
      statusCode: 'waiting',
      actedAt: undefined,
      since: borrowedSince ? borrowedSince.toISOString() : null,
      approvalRequirement: row.loaUser.approvalRequirement || 'ALL',
      isLevelSatisfied: false,
    };
  });
}

function fromLine(pivots: LinePivot[]) {
  return pivots.map((p) => ({
    userId: p.userId,
    name: nameOf(p.user, p.userId),
    level: p.level,
    statusCode: 'waiting',
    actedAt: undefined,
    since: null,
  }));
}
