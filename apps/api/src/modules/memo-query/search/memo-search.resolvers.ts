/**
 * Raw-SQL resolvers for the memo search pipeline: filters and sorts that
 * Prisma's query builder can't express (latest status per memo, current
 * waiting level, latest action / comment ordering).
 *
 * Ported from backend/src/services/memoSearch.service.ts. All queries are
 * Postgres-only (DISTINCT ON, LATERAL, ANY(array)).
 */
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import type { SearchMemosRequest } from './memo-search.types';

// Resolve memoIds whose LATEST status pivot is "Deleted",
// or "Draft" while the current user is NOT the owner.
// Returned ids must be excluded from the result set.
export async function resolveHiddenMemoIds(db: PrismaService, userId: number): Promise<number[]> {
  const rows = await db.$queryRaw<{ memoId: number }[]>`
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

// Step 1.6 — find memoIds whose LATEST status name is in the given set
//
// "latest" means the MemoStatusPivot row with the most recent createdAt
// (ties broken by id). Returns empty array if statuses is empty.
export async function resolveMemoIdsByStatus(
  db: PrismaService,
  statuses: string[],
): Promise<number[]> {
  if (!statuses.length) return [];
  const rows = await db.$queryRaw<{ memoId: number }[]>`
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
//      (levels with requirement ANY that already have an approval don't count)
//   3. return memos where ANY user at that level is in the filter list
export async function resolveMemoIdsByCurrentApprover(
  db: PrismaService,
  userIds: number[],
): Promise<number[]> {
  if (!userIds.length) return [];
  const rows = await db.$queryRaw<{ memoId: number }[]>`
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
  db: PrismaService,
  names: string[],
): Promise<number[]> {
  const trimmed = names.map((n) => n.trim()).filter(Boolean);
  if (!trimmed.length) return [];
  const insensitive = 'insensitive' as const;
  const users = await db.user.findMany({
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

// Returns null if no current-approver filter; [] if filter requested but
// no matching users found (caller should treat as "match nothing"); else
// an array of user ids to filter by.
export async function collectCurrentApproverIds(
  db: PrismaService,
  req: SearchMemosRequest,
): Promise<number[] | null> {
  const ids = new Set<number>();
  if (req.currentApproverIds?.length) {
    for (const id of req.currentApproverIds) {
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
  }
  if (req.currentApproverNames?.length) {
    const namedIds = await resolveUserIdsByNames(db, req.currentApproverNames);
    for (const id of namedIds) ids.add(id);
  }
  if (!req.currentApproverIds?.length && !req.currentApproverNames?.length) {
    return null;
  }
  return Array.from(ids);
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
export async function resolveAwaitingMemoIds(db: PrismaService, userId: number): Promise<number[]> {
  const [mainIds, extraRows] = await Promise.all([
    resolveMemoIdsByCurrentApprover(db, [userId]),
    db.$queryRaw<{ memoId: number }[]>`
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
  db: PrismaService,
  candidateIds: number[],
  dir: 'asc' | 'desc',
  skip: number,
  take: number | null,
): Promise<number[]> {
  if (!candidateIds.length) return [];

  // Use Prisma.sql for safe ORDER BY direction injection
  const orderSql = dir === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const limitSql = take === null ? Prisma.sql`` : Prisma.sql`LIMIT ${take} OFFSET ${skip}`;

  const rows = await db.$queryRaw<{ memoId: number }[]>`
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
  db: PrismaService,
  query: string,
): Promise<number[]> {
  const q = query.trim();
  if (!q) return [];

  const rows = await db.$queryRaw<{ memoId: number }[]>`
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
  db: PrismaService,
  candidateIds: number[],
  dir: 'asc' | 'desc',
  skip: number,
  take: number | null,
): Promise<number[]> {
  if (!candidateIds.length) return [];

  const orderSql = dir === 'asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
  const limitSql = take === null ? Prisma.sql`` : Prisma.sql`LIMIT ${take} OFFSET ${skip}`;

  const rows = await db.$queryRaw<{ memoId: number }[]>`
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
