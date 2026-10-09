/**
 * Fetch + format the rows of a search result page.
 * Ported from backend/src/services/memoSearch.service.ts.
 */
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { toDisplayName } from './display-name';
import { resolveOrderBy } from './memo-search.filters';
import type { MemoListItem, SearchMemosRequest } from './memo-search.types';

export async function fetchItemsForPage(
  db: PrismaService,
  where: Prisma.MasterMemoWhereInput,
  req: SearchMemosRequest,
  userId: number,
  hostUrl: string,
  skip: number,
  take: number | null,
): Promise<MemoListItem[]> {
  const items = await db.masterMemo.findMany({
    where,
    orderBy: resolveOrderBy(req),
    skip,
    take: take ?? undefined,
    include: includeShape(),
  });
  return formatItems(db, items, userId, hostUrl);
}

export async function fetchItemsByIds(
  db: PrismaService,
  ids: number[],
  userId: number,
  hostUrl: string,
): Promise<MemoListItem[]> {
  if (!ids.length) return [];
  const items = await db.masterMemo.findMany({
    where: { id: { in: ids } },
    include: includeShape(),
  });
  // preserve order from `ids`
  const byId = new Map(items.map((m) => [m.id, m]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((m): m is NonNullable<typeof m> => Boolean(m));
  return formatItems(db, ordered, userId, hostUrl);
}

function includeShape() {
  return {
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
      orderBy: { createdAt: 'desc' as const },
      take: 1,
    },
    ccRecipients: {
      include: {
        user: { select: { id: true, name: true, lastname: true, nickname: true } },
      },
    },
    extraApprovalLines: {
      include: {
        approvers: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
                profileImagePath: true,
              },
            },
            status: { select: { id: true, name: true } },
          },
          orderBy: { id: 'asc' as const },
        },
      },
      orderBy: { id: 'desc' as const },
      take: 1,
    },
    commentTags: { select: { id: true } },
  } satisfies Prisma.MasterMemoInclude;
}

type FetchedMemo = Prisma.MasterMemoGetPayload<{ include: ReturnType<typeof includeShape> }>;
type ExtraLine = FetchedMemo['extraApprovalLines'][number];

async function formatItems(
  db: PrismaService,
  items: FetchedMemo[],
  userId: number,
  hostUrl: string,
): Promise<MemoListItem[]> {
  if (!items.length) return [];
  const memoIds = items.map((m) => m.id);

  const [snapshotByMemo, latestComments, latestHistories] = await Promise.all([
    fetchApproverSnapshots(db, memoIds),
    fetchLatestComments(db, memoIds, hostUrl),
    fetchLastHistories(db, memoIds),
  ]);

  return items.map((memo) => {
    const approverStatus = snapshotByMemo.get(memo.id) ?? [];
    const extraLine = memo.extraApprovalLines[0] ?? null;
    const ccUsers = memo.ccRecipients.map((cc) => ({
      id: cc.user.id,
      name: cc.user.name,
      lastname: cc.user.lastname,
      nickname: cc.user.nickname,
    }));

    const latestActionAt = computeLatestActionAt(approverStatus, extraLine);
    const isMyTurnMain = computeIsMyTurnMain(approverStatus, userId);
    const isMyTurnExtra = computeIsMyTurnExtra(extraLine, userId);

    const isOwner = memo.userId === userId;
    const isApprover = approverStatus.some((r) => r.userId === userId);
    const isCC = ccUsers.some((u) => u.id === userId);
    const isExtra = !!extraLine?.approvers?.some((a) => a.user.id === userId);
    const isTagged = (memo.commentTags?.length ?? 0) > 0;

    const status = memo.statuses[0]?.status?.name ?? 'Processing';

    return {
      id: memo.id,
      subject: memo.subject,
      documentCode: `MEMO-${memo.id}`,
      memonumber: memo.memonumber,
      user: memo.user,
      department: memo.department ?? null,
      businessUnit: memo.businessUnit ?? null,
      type: memo.memoType?.name ?? null,
      status,
      latestApprovedDate: memo.statuses[0]?.createdAt?.toISOString() ?? null,
      createdAt: memo.createdAt?.toISOString() ?? null,
      expiresAt: memo.expiresAt?.toISOString() ?? null,
      currentApprover: extractCurrentApprover(approverStatus),
      canSeeComments: isOwner || isApprover || isCC || isExtra || isTagged,
      latestComment: latestComments.get(memo.id) ?? null,
      lastHistory: latestHistories.get(memo.id) ?? null,
      approverStatus,
      extraApproval: extraLine
        ? {
            id: extraLine.id,
            status: String(extraLine.status),
            createdAt: extraLine.createdAt.toISOString(),
            approvers: extraLine.approvers.map((a) => ({
              id: a.id,
              actedAt: a.actedAt?.toISOString() ?? null,
              statusId: a.statusId ?? null,
              status: a.status ? { id: a.status.id, name: a.status.name } : null,
              user: {
                id: a.user.id,
                name: a.user.name,
                lastname: a.user.lastname,
                nickname: a.user.nickname,
                profileImagePath: a.user.profileImagePath,
              },
            })),
          }
        : null,
      ccUsers,
      isMyTurnMain,
      isMyTurnExtra,
      latestActionAt,
    };
  });
}

// ─── per-memo helpers ─────────────────────────────────────────────────────

async function fetchApproverSnapshots(db: PrismaService, memoIds: number[]) {
  const map = new Map<number, MemoListItem['approverStatus']>();
  if (!memoIds.length) return map;

  const versions = await db.memoApproverAction.groupBy({
    by: ['memoId'],
    where: { memoId: { in: memoIds } },
    _max: { version: true },
  });
  if (!versions.length) return map;

  const rows = await db.memoApproverAction.findMany({
    where: {
      OR: versions.map((v) => ({ memoId: v.memoId, version: v._max.version ?? 0 })),
    },
    select: {
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
    },
    orderBy: [{ memoId: 'asc' }, { loaUser: { level: 'asc' } }, { loaUserId: 'asc' }],
  });

  type ActionRow = (typeof rows)[number];
  const rowsByMemo = new Map<number, ActionRow[]>();
  for (const row of rows) {
    const arr = rowsByMemo.get(row.memoId);
    if (arr) arr.push(row);
    else rowsByMemo.set(row.memoId, [row]);
  }

  for (const [memoId, memoRows] of rowsByMemo) {
    const levelStatus = new Map<
      number,
      { hasApproval: boolean; requirement: 'ALL' | 'ANY'; approvedBy?: string }
    >();

    for (const row of memoRows) {
      const level = row.loaUser.level;
      const requirement = row.loaUser.approvalRequirement ?? 'ALL';
      const current = levelStatus.get(level) ?? { hasApproval: false, requirement };
      current.requirement = requirement;
      if (row.status?.code === 'approved') {
        current.hasApproval = true;
        current.approvedBy =
          toDisplayName(row.loaUser.user, { includeNickname: true }) ||
          `User#${row.loaUser.userId ?? 0}`;
      }
      levelStatus.set(level, current);
    }

    const arr = map.get(memoId) ?? [];
    for (const r of memoRows) {
      const rawCode = (r.status?.code ?? 'waiting') as string;
      const levelInfo = levelStatus.get(r.loaUser.level);
      // An ANY level that someone already approved no longer waits on the rest.
      const isSatisfiedAnyLevel =
        rawCode === 'waiting' && levelInfo?.requirement === 'ANY' && levelInfo.hasApproval;
      const code = isSatisfiedAnyLevel ? 'not_required' : rawCode;
      const since =
        code === 'waiting'
          ? (r.createdAt?.toISOString() ?? null)
          : code === 'not_required'
            ? null
            : ((r.actedAt ?? r.createdAt)?.toISOString() ?? null);

      arr.push({
        userId: r.loaUser.userId ?? 0,
        loaUserId: r.loaUserId,
        level: r.loaUser.level,
        name:
          toDisplayName(r.loaUser.user, { includeNickname: true }) ||
          `User#${r.loaUser.userId ?? 0}`,
        statusCode: code,
        actedAt: r.actedAt?.toISOString() ?? null,
        since,
        approvalRequirement: r.loaUser.approvalRequirement ?? 'ALL',
      });
    }
    map.set(memoId, arr);
  }
  return map;
}

export function toSecureUploadPath(rawPath: string): string {
  let p = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/');
  if (!p) return '';

  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = `${u.pathname}${u.search}`;
    } catch {
      p = p.replace(/^https?:\/\/[^/]+/i, '');
    }
  }

  p = p.replace(/^\/+/, '');
  p = p.replace(/^(?:api\/secure-uploads\/)+/i, '');
  p = p.replace(/^api\/uploads\//i, 'uploads/');
  p = p.replace(/^(?:uploads\/)+/i, '');

  return p ? `/api/secure-uploads/${p}` : '';
}

async function fetchLatestComments(db: PrismaService, memoIds: number[], hostUrl: string) {
  const map = new Map<number, MemoListItem['latestComment']>();
  if (!memoIds.length) return map;

  const rows = await db.comment.findMany({
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

  const host = hostUrl.replace(/\/+$/, '');

  for (const c of rows) {
    if (map.has(c.memoId)) continue;
    const atts = (c.attachments ?? []).map((att) => {
      const pathNormalized = toSecureUploadPath(att.url);
      const fullUrl = pathNormalized ? `${host}${encodeURI(pathNormalized)}` : '';
      const fileName =
        (att.filename ?? '').trim() || pathNormalized.split('?')[0].split('/').pop() || '';
      const mimeType = att.mimetype ?? null;
      const isImage = !!mimeType && mimeType.startsWith('image/');
      return { url: fullUrl, fileName, mimeType, isImage };
    });
    map.set(c.memoId, {
      id: c.id,
      userId: c.userId,
      userName: [c.user?.name, c.user?.lastname].filter(Boolean).join(' ') || '-',
      nickname: c.user?.nickname ?? null,
      comment: c.comment,
      snippet: (c.comment || '').replace(/\s+/g, ' ').slice(0, 120),
      createdAt: c.createdAt.toISOString(),
      attachments: atts,
    });
  }
  return map;
}

async function fetchLastHistories(db: PrismaService, memoIds: number[]) {
  const map = new Map<number, MemoListItem['lastHistory']>();
  if (!memoIds.length) return map;

  const rows = await db.memoHistory.findMany({
    where: { memoId: { in: memoIds } },
    orderBy: [{ memoId: 'asc' }, { timestamp: 'desc' }, { id: 'desc' }],
    select: {
      memoId: true,
      action: true,
      actiontype: true,
      timestamp: true,
      status: { select: { name: true } },
      user: { select: { name: true } },
    },
  });

  for (const r of rows) {
    if (map.has(r.memoId)) continue;
    map.set(r.memoId, {
      action: r.action,
      actiontype: r.actiontype ? String(r.actiontype) : null,
      timestamp: r.timestamp.toISOString(),
      userName: r.user?.name ?? '-',
      statusName: r.status?.name ?? null,
    });
  }
  return map;
}

export function extractCurrentApprover(
  approverStatus: MemoListItem['approverStatus'],
): MemoListItem['currentApprover'] {
  const waiting = approverStatus.filter((r) => r.statusCode === 'waiting');
  if (!waiting.length) return null;
  const minLevel = Math.min(...waiting.map((r) => r.level));
  const atLevel = waiting.filter((r) => r.level === minLevel);
  return { names: atLevel.map((r) => r.name), level: minLevel };
}

export function computeIsMyTurnMain(
  approverStatus: MemoListItem['approverStatus'],
  userId: number,
): boolean {
  if (!approverStatus.length) return false;
  const waiting = approverStatus.filter((r) => r.statusCode === 'waiting');
  if (!waiting.length) return false;
  const minLevel = Math.min(...waiting.map((r) => r.level));
  return waiting.some((r) => r.level === minLevel && r.userId === userId);
}

export function computeIsMyTurnExtra(
  extraLine: Pick<ExtraLine, 'status' | 'approvers'> | null,
  userId: number,
): boolean {
  if (!extraLine) return false;
  const status = String(extraLine.status);
  if (status !== 'PENDING' && status !== 'IN_PROGRESS') return false;
  // first waiting approver (by id) is "current"
  const waiting = extraLine.approvers.filter((a) => a.actedAt == null);
  if (!waiting.length) return false;
  const first = waiting[0]; // already ordered by id asc
  return first.user.id === userId;
}

export function computeLatestActionAt(
  approverStatus: MemoListItem['approverStatus'],
  extraLine: Pick<ExtraLine, 'approvers'> | null,
): string | null {
  let latest: number | null = null;
  for (const r of approverStatus) {
    if (r.actedAt) {
      const t = new Date(r.actedAt).getTime();
      if (latest === null || t > latest) latest = t;
    }
  }
  if (extraLine) {
    for (const a of extraLine.approvers) {
      if (a.actedAt) {
        const t = new Date(a.actedAt).getTime();
        if (latest === null || t > latest) latest = t;
      }
    }
  }
  return latest === null ? null : new Date(latest).toISOString();
}
