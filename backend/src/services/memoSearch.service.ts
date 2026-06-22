import { Prisma } from "@prisma/client";
import { LRUCache } from "lru-cache";
import { prisma } from "../../prisma/client";
import { toDisplayName } from "../controllers/memoStatus.controller";
import type {
  SearchMemosRequest,
  SearchMemosResponse,
  MemoListItem,
  StatCounts,
  Facets,
  FacetUser,
  FacetEntity,
} from "./memoSearch.types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const STAT_COUNTS_CACHE_TTL_MS = 60 * 1000;
const STAT_COUNTS_CACHE_MAX = 500;
const FACET_CACHE_TTL_MS = 60 * 1000;
const FACET_CACHE_MAX = 500;
const MEMO_SEARCH_TIMING_THRESHOLD_MS = parseTimingThreshold(
  process.env.MEMO_SEARCH_TIMING_THRESHOLD_MS
);
const MEMO_SEARCH_TIMING_ALWAYS =
  process.env.MEMO_SEARCH_TIMING === "1" ||
  process.env.MEMO_SEARCH_TIMING === "true";
const MEMO_SEARCH_TIMING_DISABLED =
  process.env.MEMO_SEARCH_TIMING === "0" ||
  process.env.MEMO_SEARCH_TIMING === "false";

type MemoSearchTimingPhase = {
  name: string;
  ms: number;
};

type MemoSearchTimingMeta = {
  userId: number;
  page: number;
  pageSize: number | "all";
  total: number;
  items: number;
  hiddenIds: number;
  statusFilters: number;
  includeStatCounts: boolean;
  includeFacets: boolean;
  searchLength: number;
  view?: string;
  sortBy?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// LRU caches for metadata (per-user)
// ─────────────────────────────────────────────────────────────────────────────

const statCountsCache = new LRUCache<string, StatCounts>({
  max: STAT_COUNTS_CACHE_MAX,
  ttl: STAT_COUNTS_CACHE_TTL_MS,
});

const facetCache = new LRUCache<string, Facets>({
  max: FACET_CACHE_MAX,
  ttl: FACET_CACHE_TTL_MS,
});

function parseTimingThreshold(raw?: string): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 750;
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function formatMs(ms: number): string {
  return `${Math.round(ms)}ms`;
}

function shouldLogMemoSearchTiming(totalMs: number): boolean {
  if (MEMO_SEARCH_TIMING_DISABLED) return false;
  if (MEMO_SEARCH_TIMING_ALWAYS) return true;
  return totalMs >= MEMO_SEARCH_TIMING_THRESHOLD_MS;
}

function createMemoSearchTiming() {
  const startedAt = nowMs();
  const phases: MemoSearchTimingPhase[] = [];

  return {
    async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const phaseStartedAt = nowMs();
      try {
        return await fn();
      } finally {
        phases.push({
          name,
          ms: nowMs() - phaseStartedAt,
        });
      }
    },

    log(meta: MemoSearchTimingMeta) {
      const totalMs = nowMs() - startedAt;
      if (!shouldLogMemoSearchTiming(totalMs)) return;

      const phaseText = phases
        .map((phase) => `${phase.name}=${formatMs(phase.ms)}`)
        .join(" ");

      console.info(
        [
          `[memoSearch] total=${formatMs(totalMs)}`,
          phaseText,
          `userId=${meta.userId}`,
          `page=${meta.page}`,
          `pageSize=${meta.pageSize}`,
          `totalRows=${meta.total}`,
          `items=${meta.items}`,
          `hiddenIds=${meta.hiddenIds}`,
          `statusFilters=${meta.statusFilters}`,
          `searchLength=${meta.searchLength}`,
          `view=${meta.view ?? "ALL"}`,
          `sortBy=${meta.sortBy ?? "default"}`,
          `statCounts=${meta.includeStatCounts ? "yes" : "no"}`,
          `facets=${meta.includeFacets ? "yes" : "no"}`,
        ]
          .filter(Boolean)
          .join(" ")
      );
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entrypoint
// ─────────────────────────────────────────────────────────────────────────────

// Step 1.12 — main pipeline
//
// Pipeline:
//   1. parse pagination
//   2. build base where (visibility + hidden filter)
//   3. apply column / search filters
//   4. apply view (MY_CREATED, MY_APPROVAL)
//   5. apply status filter (latest pivot)
//   6. apply current approver filter (raw SQL resolver)
//   7. count + fetch items (optional latestAction sort)
//   8. compute statCounts + facets in parallel (opt-in)
export async function searchMemos(
  req: SearchMemosRequest,
  userId: number,
  hostUrl: string
): Promise<SearchMemosResponse> {
  const timing = createMemoSearchTiming();

  // ── 1. pagination ─────────────────────────────────────────────────
  const requestedPageSize = req.pageSize ?? DEFAULT_PAGE_SIZE;
  const isAll = requestedPageSize === "all";
  const pageSizeNum = isAll
    ? null
    : Math.min(MAX_PAGE_SIZE, Math.max(1, Number(requestedPageSize)));
  const page = Math.max(1, Number(req.page) || 1);
  const skip = isAll || pageSizeNum === null ? 0 : (page - 1) * pageSizeNum;
  const take = isAll ? null : pageSizeNum;

  // ── 2. base where (visibility + exclude hidden) ───────────────────
  const visibility = buildVisibilityClause(userId);
  const hiddenIds = await timing.measure("hiddenIds", () =>
    resolveHiddenMemoIds(userId)
  );
  const filters = buildFilterClause(req);

  const baseAnd: Prisma.MasterMemoWhereInput[] = [visibility, filters];
  if (hiddenIds.length) baseAnd.push({ id: { notIn: hiddenIds } });

  // ── 3. view filter ────────────────────────────────────────────────
  if (req.view === "MY_CREATED") {
    baseAnd.push({ userId });
  }

  // ── 4. status filter (single + multi) ─────────────────────────────
  const statusList = collectStatuses(req);
  if (statusList.length) {
    const ids = await timing.measure("statusIds", () =>
      resolveMemoIdsByStatus(statusList)
    );
    baseAnd.push(ids.length ? { id: { in: ids } } : { id: -1 });
  }

  // ── 5. current approver filter (ids + names) ──────────────────────
  const approverIds = await timing.measure("currentApproverIds", () =>
    collectCurrentApproverIds(req)
  );
  if (approverIds !== null) {
    if (!approverIds.length) {
      baseAnd.push({ id: -1 });
    } else {
      const ids = await timing.measure("currentApproverMemoIds", () =>
        resolveMemoIdsByCurrentApprover(approverIds)
      );
      baseAnd.push(ids.length ? { id: { in: ids } } : { id: -1 });
    }
  }

  // ── 5b. latest comment filter ────────────────────────────────────────
  if (req.latestCommentContains?.trim()) {
    const ids = await timing.measure("latestCommentMemoIds", () =>
      resolveMemoIdsByLatestComment(req.latestCommentContains!.trim())
    );
    baseAnd.push(ids.length ? { id: { in: ids } } : { id: -1 });
  }

  // ── 6. MY_APPROVAL view (after status/etc. baseline so it can refine) ─
  if (req.view === "MY_APPROVAL") {
    const [awaitingIds, processingIds] = await timing.measure(
      "myApprovalIds",
      () =>
        Promise.all([
          resolveAwaitingMemoIds(userId),
          resolveMemoIdsByStatus(["Processing"]),
        ])
    );
    const processingSet = new Set(processingIds);
    const intersect = awaitingIds.filter((id) => processingSet.has(id));
    baseAnd.push(intersect.length ? { id: { in: intersect } } : { id: -1 });
  }

  const where: Prisma.MasterMemoWhereInput = { AND: baseAnd };

  // ── 7. count + fetch items ────────────────────────────────────────
  let items: MemoListItem[];
  let total: number;

  if (req.sortBy === "latestAction") {
    const matching = await timing.measure("latestActionCandidates", () =>
      prisma.masterMemo.findMany({
        where,
        select: { id: true },
      })
    );
    total = matching.length;
    const orderedIds = await timing.measure(
      "latestActionOrder",
      () =>
        resolveLatestActionOrder(
          matching.map((m) => m.id),
          req.sortDir ?? "desc",
          skip,
          take
        )
    );
    items = await timing.measure("fetchItemsByIds", () =>
      fetchItemsByIds(orderedIds, userId, hostUrl)
    );
  } else if (req.sortBy === "latest") {
    const matching = await timing.measure("latestCommentCandidates", () =>
      prisma.masterMemo.findMany({
        where,
        select: { id: true },
      })
    );
    total = matching.length;
    const orderedIds = await timing.measure(
      "latestCommentOrder",
      () =>
        resolveLatestCommentOrder(
          matching.map((m) => m.id),
          req.sortDir ?? "desc",
          skip,
          take
        )
    );
    items = await timing.measure("fetchItemsByIds", () =>
      fetchItemsByIds(orderedIds, userId, hostUrl)
    );
  } else {
    const [count, fetched] = await Promise.all([
      timing.measure("count", () => prisma.masterMemo.count({ where })),
      timing.measure("fetchItems", () =>
        fetchItemsForPage(where, req, userId, hostUrl, skip, take)
      ),
    ]);
    total = count;
    items = fetched;
  }

  // ── 8. aggregates (optional) ──────────────────────────────────────
  const wantStat = req.includeStatCounts !== false;
  const wantFacets = req.includeFacets === true;

  let statCounts: StatCounts | undefined;
  let facets: Facets | undefined;

  if (wantStat || wantFacets) {
    if (wantStat) {
      statCounts = await timing.measure("statCounts", () =>
        getCachedStatCounts(userId, hiddenIds)
      );
    }
    if (wantFacets) {
      facets = await timing.measure("facets", () => getFacets(userId));
    }
  }

  timing.log({
    userId,
    page,
    pageSize: isAll ? "all" : pageSizeNum!,
    total,
    items: items.length,
    hiddenIds: hiddenIds.length,
    statusFilters: statusList.length,
    includeStatCounts: wantStat,
    includeFacets: wantFacets,
    searchLength: req.search?.trim().length ?? 0,
    view: req.view,
    sortBy: req.sortBy,
  });

  return {
    items,
    page,
    pageSize: isAll ? "all" : pageSizeNum!,
    total,
    totalPages: isAll
      ? 1
      : pageSizeNum
        ? Math.max(1, Math.ceil(total / pageSizeNum))
        : 1,
    statCounts,
    facets,
  };
}

export async function getCachedStatCounts(
  userId: number,
  preResolvedHiddenIds?: number[],
  options: { forceRefresh?: boolean } = {}
): Promise<StatCounts> {
  const key = `statCounts:userId=${userId}`;
  if (!options.forceRefresh) {
    const cached = statCountsCache.get(key);
    if (cached) return cached;
  }

  const fresh = await computeVisibleStatCounts(userId, preResolvedHiddenIds);
  statCountsCache.set(key, fresh);
  return fresh;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers for searchMemos pipeline
// ─────────────────────────────────────────────────────────────────────────────

function collectStatuses(req: SearchMemosRequest): string[] {
  const set = new Set<string>();
  if (req.status && req.status !== "All") set.add(req.status);
  if (req.statuses?.length) {
    for (const s of req.statuses) {
      if (s && s !== "All") set.add(s);
    }
  }
  return Array.from(set);
}

// Returns null if no current-approver filter; [] if filter requested but
// no matching users found (caller should treat as "match nothing"); else
// an array of user ids to filter by.
async function collectCurrentApproverIds(
  req: SearchMemosRequest
): Promise<number[] | null> {
  const ids = new Set<number>();
  if (req.currentApproverIds?.length) {
    for (const id of req.currentApproverIds) {
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
  }
  if (req.currentApproverNames?.length) {
    const namedIds = await resolveUserIdsByNames(req.currentApproverNames);
    for (const id of namedIds) ids.add(id);
  }
  if (!req.currentApproverIds?.length && !req.currentApproverNames?.length) {
    return null;
  }
  return Array.from(ids);
}

function resolveOrderBy(
  req: SearchMemosRequest
): Prisma.MasterMemoOrderByWithRelationInput[] {
  const dir = req.sortDir ?? "desc";
  switch (req.sortBy) {
    case "memonumber":
      return [{ memonumber: dir }, { id: "desc" }];
    case "subject":
      return [{ subject: dir }, { id: "desc" }];
    case "expires":
      return [{ expiresAt: dir }, { id: "desc" }];
    case "createdAt":
      return [{ createdAt: dir }, { id: "desc" }];
    default:
      // status / current / extra / latest / ccStatus / author / latestAction
      // are handled elsewhere or not directly mappable. Fall back to id.
      return [{ id: dir }];
  }
}

async function fetchItemsForPage(
  where: Prisma.MasterMemoWhereInput,
  req: SearchMemosRequest,
  userId: number,
  hostUrl: string,
  skip: number,
  take: number | null
): Promise<MemoListItem[]> {
  const items = await prisma.masterMemo.findMany({
    where,
    orderBy: resolveOrderBy(req),
    skip,
    take: take ?? undefined,
    include: includeShape(),
  });
  return formatItems(items, userId, hostUrl);
}

async function fetchItemsByIds(
  ids: number[],
  userId: number,
  hostUrl: string
): Promise<MemoListItem[]> {
  if (!ids.length) return [];
  const items = await prisma.masterMemo.findMany({
    where: { id: { in: ids } },
    include: includeShape(),
  });
  // preserve order from `ids`
  const byId = new Map(items.map((m) => [m.id, m]));
  const ordered = ids.map((id) => byId.get(id)).filter((m): m is NonNullable<typeof m> => Boolean(m));
  return formatItems(ordered, userId, hostUrl);
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
      orderBy: { createdAt: "desc" as const },
      take: 1,
    },
    ccRecipients: {
      include: {
        user: {
          select: { id: true, name: true, lastname: true, nickname: true },
        },
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
          orderBy: { id: "asc" as const },
        },
      },
      orderBy: { id: "desc" as const },
      take: 1,
    },
    commentTags: { select: { id: true } },
  } satisfies Prisma.MasterMemoInclude;
}

type FetchedMemo = Prisma.MasterMemoGetPayload<{ include: ReturnType<typeof includeShape> }>;

async function formatItems(
  items: FetchedMemo[],
  userId: number,
  hostUrl: string
): Promise<MemoListItem[]> {
  if (!items.length) return [];
  const memoIds = items.map((m) => m.id);

  const [snapshotByMemo, latestComments, latestHistories] = await Promise.all([
    fetchApproverSnapshots(memoIds),
    fetchLatestComments(memoIds, hostUrl),
    fetchLastHistories(memoIds),
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

    const status = memo.statuses[0]?.status?.name ?? "Processing";

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
              status: a.status
                ? { id: a.status.id, name: a.status.name }
                : null,
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

async function fetchApproverSnapshots(memoIds: number[]) {
  const map = new Map<number, MemoListItem["approverStatus"]>();
  if (!memoIds.length) return map;

  const versions = await prisma.memoApproverAction.groupBy({
    by: ["memoId"],
    where: { memoId: { in: memoIds } },
    _max: { version: true },
  });
  if (!versions.length) return map;

  const rows = await prisma.memoApproverAction.findMany({
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
    orderBy: [
      { memoId: "asc" },
      { loaUser: { level: "asc" } },
      { loaUserId: "asc" },
    ],
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
      { hasApproval: boolean; requirement: "ALL" | "ANY"; approvedBy?: string }
    >();

    for (const row of memoRows) {
      const level = row.loaUser.level;
      const requirement = row.loaUser.approvalRequirement ?? "ALL";
      const current = levelStatus.get(level) ?? {
        hasApproval: false,
        requirement,
      };
      current.requirement = requirement;
      if (row.status?.code === "approved") {
        current.hasApproval = true;
        current.approvedBy =
          toDisplayName(row.loaUser.user, { includeNickname: true }) ||
          `User#${row.loaUser.userId ?? 0}`;
      }
      levelStatus.set(level, current);
    }

    const arr = map.get(memoId) ?? [];
    for (const r of memoRows) {
      const rawCode = (r.status?.code ?? "waiting") as string;
      const levelInfo = levelStatus.get(r.loaUser.level);
      const isSatisfiedAnyLevel =
        rawCode === "waiting" &&
        levelInfo?.requirement === "ANY" &&
        levelInfo.hasApproval;
      const code = isSatisfiedAnyLevel ? "not_required" : rawCode;
      const since =
        code === "waiting"
          ? r.createdAt?.toISOString() ?? null
          : code === "not_required"
            ? null
            : (r.actedAt ?? r.createdAt)?.toISOString() ?? null;

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
        approvalRequirement: r.loaUser.approvalRequirement ?? "ALL",
      });
    }
    map.set(memoId, arr);
  }
  return map;
}

async function fetchLatestComments(memoIds: number[], hostUrl: string) {
  const map = new Map<number, MemoListItem["latestComment"]>();
  if (!memoIds.length) return map;

  const rows = await prisma.comment.findMany({
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

  const host = hostUrl.replace(/\/+$/, "");
  const toSecureUploadPath = (rawPath: string) => {
    let p = String(rawPath || "").trim().replace(/\\/g, "/");
    if (!p) return "";

    if (/^https?:\/\//i.test(p)) {
      try {
        const u = new URL(p);
        p = `${u.pathname}${u.search}`;
      } catch {
        p = p.replace(/^https?:\/\/[^/]+/i, "");
      }
    }

    p = p.replace(/^\/+/, "");
    p = p.replace(/^(?:api\/secure-uploads\/)+/i, "");
    p = p.replace(/^api\/uploads\//i, "uploads/");
    p = p.replace(/^(?:uploads\/)+/i, "");

    return p ? `/api/secure-uploads/${p}` : "";
  };

  for (const c of rows) {
    if (map.has(c.memoId)) continue;
    const atts = (c.attachments ?? []).map((att) => {
      const pathNormalized = toSecureUploadPath(att.url);
      const fullUrl = pathNormalized ? `${host}${encodeURI(pathNormalized)}` : "";
      const fileName =
        (att.filename ?? "").trim() ||
        pathNormalized.split("?")[0].split("/").pop() ||
        "";
      const mimeType = att.mimetype ?? null;
      const isImage = !!mimeType && mimeType.startsWith("image/");
      return { url: fullUrl, fileName, mimeType, isImage };
    });
    map.set(c.memoId, {
      id: c.id,
      userId: c.userId,
      userName:
        [c.user?.name, c.user?.lastname].filter(Boolean).join(" ") || "-",
      nickname: c.user?.nickname ?? null,
      comment: c.comment,
      snippet: (c.comment || "").replace(/\s+/g, " ").slice(0, 120),
      createdAt: c.createdAt.toISOString(),
      attachments: atts,
    });
  }
  return map;
}

async function fetchLastHistories(memoIds: number[]) {
  const map = new Map<number, MemoListItem["lastHistory"]>();
  if (!memoIds.length) return map;

  const rows = await prisma.memoHistory.findMany({
    where: { memoId: { in: memoIds } },
    orderBy: [{ memoId: "asc" }, { timestamp: "desc" }, { id: "desc" }],
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
      userName: r.user?.name ?? "-",
      statusName: r.status?.name ?? null,
    });
  }
  return map;
}

function extractCurrentApprover(
  approverStatus: MemoListItem["approverStatus"]
): MemoListItem["currentApprover"] {
  const waiting = approverStatus.filter((r) => r.statusCode === "waiting");
  if (!waiting.length) return null;
  const minLevel = Math.min(...waiting.map((r) => r.level));
  const atLevel = waiting.filter((r) => r.level === minLevel);
  return {
    names: atLevel.map((r) => r.name),
    level: minLevel,
  };
}

function computeIsMyTurnMain(
  approverStatus: MemoListItem["approverStatus"],
  userId: number
): boolean {
  if (!approverStatus.length) return false;
  const waiting = approverStatus.filter((r) => r.statusCode === "waiting");
  if (!waiting.length) return false;
  const minLevel = Math.min(...waiting.map((r) => r.level));
  return waiting.some((r) => r.level === minLevel && r.userId === userId);
}

function computeIsMyTurnExtra(
  extraLine: FetchedMemo["extraApprovalLines"][number] | null,
  userId: number
): boolean {
  if (!extraLine) return false;
  const status = String(extraLine.status);
  if (status !== "PENDING" && status !== "IN_PROGRESS") return false;
  // first waiting approver (by id) is "current"
  const waiting = extraLine.approvers.filter((a) => a.actedAt == null);
  if (!waiting.length) return false;
  const first = waiting[0]; // already ordered by id asc
  return first.user.id === userId;
}

function computeLatestActionAt(
  approverStatus: MemoListItem["approverStatus"],
  extraLine: FetchedMemo["extraApprovalLines"][number] | null
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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers exposed for tests / future reuse
// ─────────────────────────────────────────────────────────────────────────────

// Step 1.4 — visibility OR clause (mirrors getAllMemos)
//
// User can see a memo if any of:
//   - they are the owner (userId)
//   - they have an approver action on it
//   - they are in CC recipients
//   - they are in any extra approval line approvers
//   - they are tagged in a comment
//
// NOTE: This does NOT exclude Deleted memos or Draft-of-others — those
// are filtered separately via resolveHiddenMemoIds() in the main pipeline.
export function buildVisibilityClause(
  userId: number
): Prisma.MasterMemoWhereInput {
  return {
    OR: [
      { userId },
      { approverActions: { some: { loaUser: { userId } } } },
      { ccRecipients: { some: { userId } } },
      {
        extraApprovalLines: {
          some: { approvers: { some: { userId } } },
        },
      },
      { commentTags: { some: { userId } } },
    ],
  };
}

// Resolve memoIds whose LATEST status pivot is "Deleted",
// or "Draft" while the current user is NOT the owner.
// Returned ids must be excluded from the result set.
//
// Uses DISTINCT ON to pick the latest pivot row per memo (Postgres-only).
export async function resolveHiddenMemoIds(
  userId: number
): Promise<number[]> {
  const rows = await prisma.$queryRaw<{ memoId: number }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (sp."memoId")
        sp."memoId"      AS "memoId",
        s."name"          AS "statusName",
        m."userId"        AS "ownerId"
      FROM "MemoStatusPivot" sp
      JOIN "Status" s       ON sp."statusId" = s."id"
      JOIN "MasterMemo" m   ON m."id" = sp."memoId"
      ORDER BY sp."memoId", sp."createdAt" DESC, sp."id" DESC
    )
    SELECT "memoId"
    FROM latest
    WHERE "statusName" = 'Deleted'
       OR ("statusName" = 'Draft' AND "ownerId" <> ${userId})
  `;
  return rows.map((r) => r.memoId);
}

// Step 1.5 — request → Prisma where (excluding visibility + filters that need raw SQL)
//
// Filters that need raw SQL are NOT handled here, they go through resolvers:
//   - statuses[]                  → resolveMemoIdsByStatus (Step 1.6)
//   - currentApproverIds/Names    → resolveMemoIdsByCurrentApprover (Step 1.7)
//   - view = MY_APPROVAL          → resolveAwaitingMemoIds (Step 1.8)
//   - sortBy = latestAction       → resolveLatestActionOrder (Step 1.9)
//   - status (single, top-bar)    → folded into statuses[]
export function buildFilterClause(
  req: SearchMemosRequest
): Prisma.MasterMemoWhereInput {
  const and: Prisma.MasterMemoWhereInput[] = [];
  const insensitive = "insensitive" as const;

  // ── Free-text search ────────────────────────────────────────────────
  // Searches: subject, memonumber, author name (name + lastname + nickname).
  // Special case: "MEMO-{id}" pattern → match id directly.
  const searchText = req.search?.trim();
  if (searchText) {
    const memoIdMatch = searchText.match(/^MEMO-(\d+)$/i);
    if (memoIdMatch) {
      and.push({ id: Number(memoIdMatch[1]) });
    } else {
      and.push({
        OR: [
          { subject: { contains: searchText, mode: insensitive } },
          { memonumber: { contains: searchText, mode: insensitive } },
          {
            user: {
              OR: [
                { name: { contains: searchText, mode: insensitive } },
                { lastname: { contains: searchText, mode: insensitive } },
                { nickname: { contains: searchText, mode: insensitive } },
              ],
            },
          },
        ],
      });
    }
  }

  // ── Column text filters ─────────────────────────────────────────────
  if (req.memonumberContains?.trim()) {
    and.push({
      memonumber: { contains: req.memonumberContains.trim(), mode: insensitive },
    });
  }
  if (req.subjectContains?.trim()) {
    and.push({
      subject: { contains: req.subjectContains.trim(), mode: insensitive },
    });
  }
  if (req.authorContains?.trim()) {
    const q = req.authorContains.trim();
    and.push({
      user: {
        OR: [
          { name: { contains: q, mode: insensitive } },
          { lastname: { contains: q, mode: insensitive } },
          { nickname: { contains: q, mode: insensitive } },
        ],
      },
    });
  }
  // ── Top-bar filters ─────────────────────────────────────────────────
  if (req.businessUnitId !== undefined && req.businessUnitId !== "All") {
    const buId = Number(req.businessUnitId);
    if (!Number.isNaN(buId)) and.push({ businessUnitId: buId });
  }
  if (req.departmentId !== undefined && req.departmentId !== "All") {
    const deptId = Number(req.departmentId);
    if (!Number.isNaN(deptId)) and.push({ departmentId: deptId });
  }

  // ── view = MY_CREATED (MY_APPROVAL handled in main pipeline) ────────
  if (req.view === "MY_CREATED") {
    // userId filter is added in main pipeline since it needs current user id
  }

  // ── CC user filter (multi) ──────────────────────────────────────────
  if (req.ccUserIds?.length) {
    and.push({
      ccRecipients: { some: { userId: { in: req.ccUserIds } } },
    });
  }

  // ── CC status filter (multi names from header dropdown) ─────────────
  // Matches by user name fragment, mirroring FE's ccUserLabel comparison.
  if (req.ccStatuses?.length) {
    const nameClauses: Prisma.UserWhereInput[] = req.ccStatuses.flatMap((n) => {
      const trimmed = n.trim();
      if (!trimmed) return [];
      return [
        { name: { contains: trimmed, mode: insensitive } },
        { lastname: { contains: trimmed, mode: insensitive } },
        { nickname: { contains: trimmed, mode: insensitive } },
      ];
    });
    if (nameClauses.length) {
      and.push({
        ccRecipients: {
          some: { user: { OR: nameClauses } },
        },
      });
    }
  }

  // ── Extra approver name filter (multi) ──────────────────────────────
  // Match by name fragment in name/lastname/nickname.
  if (req.extraApproverIds?.length || req.extraApproverNames?.length) {
    const approverClauses: Prisma.ExtraApproverWhereInput[] = [];
    if (req.extraApproverIds?.length) {
      approverClauses.push({ userId: { in: req.extraApproverIds } });
    }

    const nameClauses: Prisma.UserWhereInput[] = (req.extraApproverNames ?? [])
      .flatMap((n) => {
        const trimmed = n.trim();
        if (!trimmed) return [];
        return [
          { name: { contains: trimmed, mode: insensitive } },
          { lastname: { contains: trimmed, mode: insensitive } },
          { nickname: { contains: trimmed, mode: insensitive } },
        ];
      });
    if (nameClauses.length) {
      approverClauses.push({ user: { OR: nameClauses } });
    }

    if (approverClauses.length) {
      and.push({
        extraApprovalLines: {
          some: {
            approvers: {
              some: { OR: approverClauses },
            },
          },
        },
      });
    }
  }

  // ── Extra approver text filter (single contains) ────────────────────
  if (req.extraApproverContains?.trim()) {
    const q = req.extraApproverContains.trim();
    and.push({
      extraApprovalLines: {
        some: {
          approvers: {
            some: {
              user: {
                OR: [
                  { name: { contains: q, mode: insensitive } },
                  { lastname: { contains: q, mode: insensitive } },
                  { nickname: { contains: q, mode: insensitive } },
                ],
              },
            },
          },
        },
      },
    });
  }

  // ── Date ranges ─────────────────────────────────────────────────────
  if (req.expiresFrom || req.expiresTo) {
    const range: Prisma.DateTimeNullableFilter = {};
    if (req.expiresFrom) range.gte = new Date(req.expiresFrom);
    if (req.expiresTo) {
      // Include the whole "to" day → use start of next day
      const to = new Date(req.expiresTo);
      to.setHours(23, 59, 59, 999);
      range.lte = to;
    }
    and.push({ expiresAt: range });
  }
  if (req.createdFrom || req.createdTo) {
    const range: Prisma.DateTimeFilter = {};
    if (req.createdFrom) range.gte = new Date(req.createdFrom);
    if (req.createdTo) {
      const to = new Date(req.createdTo);
      to.setHours(23, 59, 59, 999);
      range.lte = to;
    }
    and.push({ createdAt: range });
  }

  return and.length ? { AND: and } : {};
}

// Step 1.6 — find memoIds whose LATEST status name is in the given set
//
// "latest" means the MemoStatusPivot row with the most recent createdAt
// (ties broken by id). Returns empty array if statuses is empty.
export async function resolveMemoIdsByStatus(
  statuses: string[]
): Promise<number[]> {
  if (!statuses.length) return [];
  const rows = await prisma.$queryRaw<{ memoId: number }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (sp."memoId")
        sp."memoId" AS "memoId",
        s."name"    AS "statusName"
      FROM "MemoStatusPivot" sp
      JOIN "Status" s ON sp."statusId" = s."id"
      ORDER BY sp."memoId", sp."createdAt" DESC, sp."id" DESC
    )
    SELECT "memoId"
    FROM latest
    WHERE "statusName" = ANY(${statuses})
  `;
  return rows.map((r) => r.memoId);
}

// Step 1.7 — find memoIds whose CURRENT WAITING SET (lowest waiting level
// of the latest version) intersects the given approver user ids.
//
// Algorithm:
//   1. for each memo: find the max(version) of MemoApproverAction
//   2. among rows of that version with status code = 'waiting',
//      find the MIN(level)  →  that's the "current waiting level"
//   3. return memos where ANY user at that level is in the filter list
export async function resolveMemoIdsByCurrentApprover(
  userIds: number[]
): Promise<number[]> {
  if (!userIds.length) return [];
  const rows = await prisma.$queryRaw<{ memoId: number }[]>`
    WITH latest_version AS (
      SELECT "memoId", MAX("version") AS v
      FROM "MemoApproverAction"
      GROUP BY "memoId"
    ),
    latest_rows AS (
      SELECT
        a."memoId" AS "memoId",
        lou."level" AS "level",
        lou."userId" AS "userId",
        lou."approvalRequirement" AS "approvalRequirement",
        s."code" AS "code"
      FROM "MemoApproverAction" a
      JOIN latest_version lv
        ON a."memoId" = lv."memoId" AND a."version" = lv.v
      JOIN "ApprovalActionStatus" s ON a."statusId" = s."id"
      JOIN "LineOfApprovalUserPivotForUse" lou ON a."loaUserId" = lou."id"
    ),
    level_state AS (
      SELECT
        "memoId",
        "level",
        BOOL_OR("approvalRequirement" = 'ANY') AS "isAny",
        BOOL_OR("code" = 'approved') AS "hasApproved"
      FROM latest_rows
      GROUP BY "memoId", "level"
    ),
    waiting_rows AS (
      SELECT lr."memoId", lr."level", lr."userId"
      FROM latest_rows lr
      JOIN level_state ls
        ON lr."memoId" = ls."memoId" AND lr."level" = ls."level"
      WHERE lr."code" = 'waiting'
        AND NOT (ls."isAny" AND ls."hasApproved")
    ),
    min_level AS (
      SELECT "memoId", MIN("level") AS "minLevel"
      FROM waiting_rows
      GROUP BY "memoId"
    )
    SELECT DISTINCT wr."memoId"
    FROM waiting_rows wr
    JOIN min_level ml
      ON wr."memoId" = ml."memoId" AND wr."level" = ml."minLevel"
    WHERE wr."userId" = ANY(${userIds})
  `;
  return rows.map((r) => r.memoId);
}

// Resolve approver names → user ids for the current-approver filter.
// Matches against name / lastname / nickname (case-insensitive contains).
export async function resolveUserIdsByNames(
  names: string[]
): Promise<number[]> {
  const trimmed = names.map((n) => n.trim()).filter(Boolean);
  if (!trimmed.length) return [];
  const insensitive = "insensitive" as const;
  const users = await prisma.user.findMany({
    where: {
      OR: trimmed.flatMap((n) => [
        { name: { contains: n, mode: insensitive } },
        { lastname: { contains: n, mode: insensitive } },
        { nickname: { contains: n, mode: insensitive } },
      ]),
      deletedAt: null,
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

// Step 1.8 — find memoIds where the user is currently "next to act"
// (used for view = MY_APPROVAL).
//
// Combines two sources:
//   1. Main approval: user is in the current waiting set (lowest waiting
//      level of the latest version) — reuses resolveMemoIdsByCurrentApprover
//   2. Extra approval: user is the first-still-waiting approver in any
//      active (PENDING / IN_PROGRESS) extra approval line
//
// Note: the FE additionally filters by `status === "Processing"` — that
// constraint is applied at the main pipeline level (combined with
// resolveMemoIdsByStatus(['Processing'])).
export async function resolveAwaitingMemoIds(
  userId: number
): Promise<number[]> {
  const [mainIds, extraRows] = await Promise.all([
    resolveMemoIdsByCurrentApprover([userId]),
    prisma.$queryRaw<{ memoId: number }[]>`
      SELECT DISTINCT eal."memoId"
      FROM "ExtraApprovalLine" eal
      WHERE eal."status" IN ('PENDING', 'IN_PROGRESS')
        AND EXISTS (
          SELECT 1 FROM "ExtraApprover" ea
          WHERE ea."extraId" = eal."id"
            AND ea."userId" = ${userId}
            AND ea."actedAt" IS NULL
            AND ea."id" = (
              SELECT MIN(ea2."id") FROM "ExtraApprover" ea2
              WHERE ea2."extraId" = eal."id"
                AND ea2."actedAt" IS NULL
            )
        )
    `,
  ]);
  const extraIds = extraRows.map((r) => r.memoId);
  return Array.from(new Set([...mainIds, ...extraIds]));
}

// Step 1.9 — sort memoIds by "latest action timestamp"
//
// latestActionAt = max(actedAt) over (
//   MemoApproverAction rows for the memo  ∪
//   ExtraApprover rows for any extra approval line of the memo
// )
//
// Returns a slice of memoIds in the requested order, ready to feed
// into `findMany({ where: { id: { in: ids } } })`. The caller must
// preserve order using a Map.
export async function resolveLatestActionOrder(
  candidateIds: number[],
  dir: "asc" | "desc",
  skip: number,
  take: number | null
): Promise<number[]> {
  if (!candidateIds.length) return [];

  // Use Prisma.sql for safe ORDER BY direction injection
  const orderSql = dir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const limitSql =
    take === null
      ? Prisma.sql``
      : Prisma.sql`LIMIT ${take} OFFSET ${skip}`;

  const rows = await prisma.$queryRaw<{ memoId: number }[]>`
    WITH latest_main AS (
      SELECT "memoId", MAX("actedAt") AS t
      FROM "MemoApproverAction"
      WHERE "memoId" = ANY(${candidateIds})
      GROUP BY "memoId"
    ),
    latest_extra AS (
      SELECT eal."memoId", MAX(ea."actedAt") AS t
      FROM "ExtraApprover" ea
      JOIN "ExtraApprovalLine" eal ON ea."extraId" = eal."id"
      WHERE eal."memoId" = ANY(${candidateIds})
      GROUP BY eal."memoId"
    )
    SELECT m."id" AS "memoId"
    FROM "MasterMemo" m
    LEFT JOIN latest_main lm  ON lm."memoId"  = m."id"
    LEFT JOIN latest_extra le ON le."memoId" = m."id"
    WHERE m."id" = ANY(${candidateIds})
    ORDER BY GREATEST(
      COALESCE(lm.t, '1970-01-01'::timestamp),
      COALESCE(le.t, '1970-01-01'::timestamp)
    ) ${orderSql}, m."id" ${orderSql}
    ${limitSql}
  `;
  return rows.map((r) => r.memoId);
}

export async function resolveMemoIdsByLatestComment(
  query: string
): Promise<number[]> {
  const q = query.trim();
  if (!q) return [];

  const rows = await prisma.$queryRaw<{ memoId: number }[]>`
    WITH latest AS (
      SELECT DISTINCT ON (c."memoId")
        c."memoId"  AS "memoId",
        c."comment" AS "comment"
      FROM "Comment" c
      ORDER BY c."memoId", c."createdAt" DESC, c."id" DESC
    )
    SELECT "memoId"
    FROM latest
    WHERE "comment" ILIKE ${`%${q}%`}
  `;
  return rows.map((r) => r.memoId);
}

export async function resolveLatestCommentOrder(
  candidateIds: number[],
  dir: "asc" | "desc",
  skip: number,
  take: number | null
): Promise<number[]> {
  if (!candidateIds.length) return [];

  const orderSql = dir === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const limitSql =
    take === null
      ? Prisma.sql``
      : Prisma.sql`LIMIT ${take} OFFSET ${skip}`;

  const rows = await prisma.$queryRaw<{ memoId: number }[]>`
    SELECT m."id" AS "memoId"
    FROM "MasterMemo" m
    LEFT JOIN LATERAL (
      SELECT c."comment" AS "comment"
      FROM "Comment" c
      WHERE c."memoId" = m."id"
      ORDER BY c."createdAt" DESC, c."id" DESC
      LIMIT 1
    ) lc ON true
    WHERE m."id" = ANY(${candidateIds})
    ORDER BY
      CASE
        WHEN lc."comment" IS NULL OR btrim(lc."comment") = '' THEN 1
        ELSE 0
      END ASC,
      lower(lc."comment") ${orderSql},
      m."id" ${orderSql}
    ${limitSql}
  `;
  return rows.map((r) => r.memoId);
}

// Step 1.10 — aggregate counts for the dashboard stat cards
//
// Counts represent the user's full visible set (visibility + hidden filter
// applied) — they do NOT shrink when filters/search are applied. This
// matches the existing FE behavior where stat cards always show totals.
//
// `visibleMemoIds` should already exclude:
//   - memos the user can't see (visibility OR clause)
//   - memos whose latest status is Deleted
//   - Drafts owned by other users
export async function computeStatCounts(
  userId: number,
  visibleMemoIds: number[]
): Promise<StatCounts> {
  const empty: StatCounts = {
    total: 0,
    Draft: 0,
    Processing: 0,
    Approved: 0,
    Rejected: 0,
    Terminated: 0,
    Published: 0,
    Recalled: 0,
    myApproval: 0,
    myCreated: 0,
    myCC: 0,
  };
  if (!visibleMemoIds.length) return empty;

  const [statusRows, myCreated, myCC, awaitingIds, processingIds] = await Promise.all([
    prisma.$queryRaw<{ statusName: string; count: bigint }[]>`
      WITH latest AS (
        SELECT DISTINCT ON (sp."memoId")
          sp."memoId" AS "memoId",
          s."name"     AS "statusName"
        FROM "MemoStatusPivot" sp
        JOIN "Status" s ON sp."statusId" = s."id"
        WHERE sp."memoId" = ANY(${visibleMemoIds})
        ORDER BY sp."memoId", sp."createdAt" DESC, sp."id" DESC
      )
      SELECT "statusName", COUNT(*)::int AS count
      FROM latest
      GROUP BY "statusName"
    `,
    prisma.masterMemo.count({
      where: { id: { in: visibleMemoIds }, userId },
    }),
    prisma.masterMemo.count({
      where: {
        id: { in: visibleMemoIds },
        ccRecipients: { some: { userId } },
      },
    }),
    resolveAwaitingMemoIds(userId),
    resolveMemoIdsByStatus(["Processing"]),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.statusName] = Number(row.count);
  }

  const visibleSet = new Set(visibleMemoIds);
  const processingSet = new Set(processingIds);
  const myApproval = awaitingIds.filter(
    (id) => visibleSet.has(id) && processingSet.has(id)
  ).length;

  return {
    total: visibleMemoIds.length,
    Draft: byStatus.Draft ?? 0,
    Processing: byStatus.Processing ?? 0,
    Approved: byStatus.Approved ?? 0,
    Rejected: byStatus.Rejected ?? 0,
    Terminated: byStatus.Terminated ?? 0,
    Published: byStatus.Published ?? 0,
    Recalled: byStatus.Recalled ?? 0,
    myApproval,
    myCreated,
    myCC,
  };
}

async function computeVisibleStatCounts(
  userId: number,
  preResolvedHiddenIds?: number[]
): Promise<StatCounts> {
  const visibility = buildVisibilityClause(userId);
  const hiddenIds = preResolvedHiddenIds ?? await resolveHiddenMemoIds(userId);
  const visibleRows = await prisma.masterMemo.findMany({
    where: {
      AND: [
        visibility,
        ...(hiddenIds.length ? [{ id: { notIn: hiddenIds } }] : []),
      ],
    },
    select: { id: true },
  });

  return computeStatCounts(
    userId,
    visibleRows.map((r) => r.id)
  );
}

// Step 1.11
export async function getFacets(userId: number): Promise<Facets> {
  const key = `facets:userId=${userId}`;
  const cached = facetCache.get(key);
  if (cached) return cached;
  const fresh = await computeFacets(userId);
  facetCache.set(key, fresh);
  return fresh;
}

// Step 1.11 — distinct values for filter dropdowns
//
// Facets are computed against the full visible set (no search/filter),
// so applying a filter does NOT shrink dropdown options. Cached 60s
// per user via getFacets().
async function computeFacets(userId: number): Promise<Facets> {
  // 1. Resolve visible memo IDs (visibility OR + exclude hidden)
  const visibility = buildVisibilityClause(userId);
  const hiddenIds = await resolveHiddenMemoIds(userId);
  const visibleMemos = await prisma.masterMemo.findMany({
    where: {
      AND: [
        visibility,
        hiddenIds.length ? { id: { notIn: hiddenIds } } : {},
      ],
    },
    select: { id: true },
  });
  const visibleIds = visibleMemos.map((m) => m.id);

  if (!visibleIds.length) {
    return {
      currentApprovers: [],
      extraApprovers: [],
      businessUnits: [],
      departments: [],
      ccUsers: [],
    };
  }

  // 2. Compute facets in parallel
  const [
    currentApproverRows,
    extraApproverRows,
    businessUnits,
    departments,
    ccUserRows,
  ] = await Promise.all([
    // currentApprovers: distinct users who are CURRENTLY waiting at the
    // lowest waiting level of the latest version
    prisma.$queryRaw<
      { id: number; name: string; lastname: string | null; nickname: string | null }[]
    >`
      WITH latest_version AS (
        SELECT "memoId", MAX("version") AS v
        FROM "MemoApproverAction"
        WHERE "memoId" = ANY(${visibleIds})
        GROUP BY "memoId"
      ),
      latest_rows AS (
        SELECT
          a."memoId" AS "memoId",
          lou."level" AS "level",
          lou."userId" AS "userId",
          lou."approvalRequirement" AS "approvalRequirement",
          s."code" AS "code"
        FROM "MemoApproverAction" a
        JOIN latest_version lv
          ON a."memoId" = lv."memoId" AND a."version" = lv.v
        JOIN "ApprovalActionStatus" s ON a."statusId" = s."id"
        JOIN "LineOfApprovalUserPivotForUse" lou ON a."loaUserId" = lou."id"
      ),
      level_state AS (
        SELECT
          "memoId",
          "level",
          BOOL_OR("approvalRequirement" = 'ANY') AS "isAny",
          BOOL_OR("code" = 'approved') AS "hasApproved"
        FROM latest_rows
        GROUP BY "memoId", "level"
      ),
      waiting_rows AS (
        SELECT lr."memoId", lr."level", lr."userId"
        FROM latest_rows lr
        JOIN level_state ls
          ON lr."memoId" = ls."memoId" AND lr."level" = ls."level"
        WHERE lr."code" = 'waiting'
          AND NOT (ls."isAny" AND ls."hasApproved")
      ),
      min_level AS (
        SELECT "memoId", MIN("level") AS "minLevel"
        FROM waiting_rows GROUP BY "memoId"
      )
      SELECT DISTINCT
        u."id"        AS "id",
        u."name"      AS "name",
        u."lastname"  AS "lastname",
        u."nickname"  AS "nickname"
      FROM waiting_rows wr
      JOIN min_level ml
        ON wr."memoId" = ml."memoId" AND wr."level" = ml."minLevel"
      JOIN "User" u ON u."id" = wr."userId"
      WHERE u."deletedAt" IS NULL
    `,

    // extraApprovers: distinct users in any extra line of visible memos
    prisma.$queryRaw<
      { id: number; name: string; lastname: string | null; nickname: string | null }[]
    >`
      SELECT DISTINCT
        u."id"        AS "id",
        u."name"      AS "name",
        u."lastname"  AS "lastname",
        u."nickname"  AS "nickname"
      FROM "ExtraApprovalLine" eal
      JOIN "ExtraApprover" ea ON ea."extraId" = eal."id"
      JOIN "User" u           ON u."id" = ea."userId"
      WHERE eal."memoId" = ANY(${visibleIds})
        AND u."deletedAt" IS NULL
    `,

    prisma.businessUnit.findMany({
      where: { memos: { some: { id: { in: visibleIds } } } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),

    prisma.department.findMany({
      where: { memos: { some: { id: { in: visibleIds } } } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),

    // ccUsers: distinct users in MemoCc
    prisma.$queryRaw<
      { id: number; name: string; lastname: string | null; nickname: string | null }[]
    >`
      SELECT DISTINCT
        u."id"        AS "id",
        u."name"      AS "name",
        u."lastname"  AS "lastname",
        u."nickname"  AS "nickname"
      FROM "MemoCc" cc
      JOIN "User" u ON u."id" = cc."userId"
      WHERE cc."memoId" = ANY(${visibleIds})
        AND u."deletedAt" IS NULL
    `,
  ]);

  const toFacetUser = (rows: typeof currentApproverRows): FacetUser[] => {
    return rows
      .map((r) => ({
        id: r.id,
        name: toDisplayName(r, { includeNickname: true }) || `User#${r.id}`,
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name, ["th", "en"], { sensitivity: "base" })
      );
  };

  const toFacetEntity = (rows: { id: number; name: string }[]): FacetEntity[] =>
    rows.map((r) => ({ id: r.id, name: r.name }));

  return {
    currentApprovers: toFacetUser(currentApproverRows),
    extraApprovers: toFacetUser(extraApproverRows),
    businessUnits: toFacetEntity(businessUnits),
    departments: toFacetEntity(departments),
    ccUsers: toFacetUser(ccUserRows),
  };
}

// Re-export type
export type { MemoListItem };
