/**
 * Dashboard aggregates for memo search: stat-card counts and filter-dropdown
 * facets. Both are computed over the user's full visible set (ignoring the
 * current search/filters) and are cached per user by MemoSearchNestService.
 *
 * Ported from backend/src/services/memoSearch.service.ts.
 */
import { PrismaService } from '../../../prisma/prisma.service';
import { toDisplayName } from './display-name';
import { buildVisibilityClause } from './memo-search.filters';
import {
  resolveAwaitingMemoIds,
  resolveHiddenMemoIds,
  resolveMemoIdsByStatus,
} from './memo-search.resolvers';
import type { FacetEntity, FacetUser, Facets, StatCounts } from './memo-search.types';

type FacetUserRow = { id: number; name: string; lastname: string | null; nickname: string | null };

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
  db: PrismaService,
  userId: number,
  visibleMemoIds: number[],
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
    db.$queryRaw<{ statusName: string; count: bigint }[]>`
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
    db.masterMemo.count({ where: { id: { in: visibleMemoIds }, userId } }),
    db.masterMemo.count({
      where: { id: { in: visibleMemoIds }, ccRecipients: { some: { userId } } },
    }),
    resolveAwaitingMemoIds(db, userId),
    resolveMemoIdsByStatus(db, ['Processing']),
  ]);

  const byStatus: Record<string, number> = {};
  for (const row of statusRows) {
    byStatus[row.statusName] = Number(row.count);
  }

  const visibleSet = new Set(visibleMemoIds);
  const processingSet = new Set(processingIds);
  const myApproval = awaitingIds.filter((id) => visibleSet.has(id) && processingSet.has(id)).length;

  return {
    total: visibleMemoIds.length,
    Draft: byStatus['Draft'] ?? 0,
    Processing: byStatus['Processing'] ?? 0,
    Approved: byStatus['Approved'] ?? 0,
    Rejected: byStatus['Rejected'] ?? 0,
    Terminated: byStatus['Terminated'] ?? 0,
    Published: byStatus['Published'] ?? 0,
    Recalled: byStatus['Recalled'] ?? 0,
    myApproval,
    myCreated,
    myCC,
  };
}

export async function computeVisibleStatCounts(
  db: PrismaService,
  userId: number,
  preResolvedHiddenIds?: number[],
): Promise<StatCounts> {
  const visibility = buildVisibilityClause(userId);
  const hiddenIds = preResolvedHiddenIds ?? (await resolveHiddenMemoIds(db, userId));
  const visibleRows = await db.masterMemo.findMany({
    where: {
      AND: [visibility, ...(hiddenIds.length ? [{ id: { notIn: hiddenIds } }] : [])],
    },
    select: { id: true },
  });

  return computeStatCounts(
    db,
    userId,
    visibleRows.map((r) => r.id),
  );
}

// Step 1.11 — distinct values for filter dropdowns
//
// Facets are computed against the full visible set (no search/filter),
// so applying a filter does NOT shrink dropdown options.
export async function computeFacets(db: PrismaService, userId: number): Promise<Facets> {
  // 1. Resolve visible memo IDs (visibility OR + exclude hidden)
  const visibility = buildVisibilityClause(userId);
  const hiddenIds = await resolveHiddenMemoIds(db, userId);
  const visibleMemos = await db.masterMemo.findMany({
    where: {
      AND: [visibility, hiddenIds.length ? { id: { notIn: hiddenIds } } : {}],
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
  const [currentApproverRows, extraApproverRows, businessUnits, departments, ccUserRows] =
    await Promise.all([
      // currentApprovers: distinct users who are CURRENTLY waiting at the
      // lowest waiting level of the latest version
      db.$queryRaw<FacetUserRow[]>`
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
      db.$queryRaw<FacetUserRow[]>`
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

      db.businessUnit.findMany({
        where: { memos: { some: { id: { in: visibleIds } } } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),

      db.department.findMany({
        where: { memos: { some: { id: { in: visibleIds } } } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),

      // ccUsers: distinct users in MemoCc
      db.$queryRaw<FacetUserRow[]>`
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

  const toFacetUser = (rows: FacetUserRow[]): FacetUser[] =>
    rows
      .map((r) => ({
        id: r.id,
        name: toDisplayName(r, { includeNickname: true }) || `User#${r.id}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, ['th', 'en'], { sensitivity: 'base' }));

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
