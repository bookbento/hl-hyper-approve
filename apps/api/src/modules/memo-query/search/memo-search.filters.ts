/**
 * Pure request → Prisma where/orderBy builders for the memo search pipeline.
 * Ported from backend/src/services/memoSearch.service.ts.
 */
import { Prisma } from '@prisma/client';
import type { SearchMemosRequest } from './memo-search.types';

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
export function buildVisibilityClause(userId: number): Prisma.MasterMemoWhereInput {
  return {
    OR: [
      { userId },
      { approverActions: { some: { loaUser: { userId } } } },
      { ccRecipients: { some: { userId } } },
      { extraApprovalLines: { some: { approvers: { some: { userId } } } } },
      { commentTags: { some: { userId } } },
    ],
  };
}

function nameContains(q: string): Prisma.UserWhereInput[] {
  const insensitive = 'insensitive' as const;
  return [
    { name: { contains: q, mode: insensitive } },
    { lastname: { contains: q, mode: insensitive } },
    { nickname: { contains: q, mode: insensitive } },
  ];
}

// Step 1.5 — request → Prisma where (excluding visibility + filters that need raw SQL)
//
// Filters that need raw SQL are NOT handled here, they go through resolvers:
//   - statuses[]                  → resolveMemoIdsByStatus (Step 1.6)
//   - currentApproverIds/Names    → resolveMemoIdsByCurrentApprover (Step 1.7)
//   - view = MY_APPROVAL          → resolveAwaitingMemoIds (Step 1.8)
//   - sortBy = latestAction       → resolveLatestActionOrder (Step 1.9)
//   - status (single, top-bar)    → folded into statuses[]
//   - view = MY_CREATED           → userId filter added in main pipeline
export function buildFilterClause(req: SearchMemosRequest): Prisma.MasterMemoWhereInput {
  const and: Prisma.MasterMemoWhereInput[] = [];
  const insensitive = 'insensitive' as const;

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
          { user: { OR: nameContains(searchText) } },
        ],
      });
    }
  }

  // ── Column text filters ─────────────────────────────────────────────
  if (req.memonumberContains?.trim()) {
    and.push({ memonumber: { contains: req.memonumberContains.trim(), mode: insensitive } });
  }
  if (req.subjectContains?.trim()) {
    and.push({ subject: { contains: req.subjectContains.trim(), mode: insensitive } });
  }
  if (req.authorContains?.trim()) {
    and.push({ user: { OR: nameContains(req.authorContains.trim()) } });
  }

  // ── Top-bar filters ─────────────────────────────────────────────────
  if (req.businessUnitId !== undefined && req.businessUnitId !== 'All') {
    const buId = Number(req.businessUnitId);
    if (!Number.isNaN(buId)) and.push({ businessUnitId: buId });
  }
  if (req.departmentId !== undefined && req.departmentId !== 'All') {
    const deptId = Number(req.departmentId);
    if (!Number.isNaN(deptId)) and.push({ departmentId: deptId });
  }

  // ── CC user filter (multi) ──────────────────────────────────────────
  if (req.ccUserIds?.length) {
    and.push({ ccRecipients: { some: { userId: { in: req.ccUserIds } } } });
  }

  // ── CC status filter (multi names from header dropdown) ─────────────
  // Matches by user name fragment, mirroring FE's ccUserLabel comparison.
  if (req.ccStatuses?.length) {
    const nameClauses = req.ccStatuses.flatMap((n) => {
      const trimmed = n.trim();
      return trimmed ? nameContains(trimmed) : [];
    });
    if (nameClauses.length) {
      and.push({ ccRecipients: { some: { user: { OR: nameClauses } } } });
    }
  }

  // ── Extra approver name filter (multi) ──────────────────────────────
  // Match by name fragment in name/lastname/nickname.
  if (req.extraApproverIds?.length || req.extraApproverNames?.length) {
    const approverClauses: Prisma.ExtraApproverWhereInput[] = [];
    if (req.extraApproverIds?.length) {
      approverClauses.push({ userId: { in: req.extraApproverIds } });
    }

    const nameClauses = (req.extraApproverNames ?? []).flatMap((n) => {
      const trimmed = n.trim();
      return trimmed ? nameContains(trimmed) : [];
    });
    if (nameClauses.length) {
      approverClauses.push({ user: { OR: nameClauses } });
    }

    if (approverClauses.length) {
      and.push({
        extraApprovalLines: { some: { approvers: { some: { OR: approverClauses } } } },
      });
    }
  }

  // ── Extra approver text filter (single contains) ────────────────────
  if (req.extraApproverContains?.trim()) {
    const q = req.extraApproverContains.trim();
    and.push({
      extraApprovalLines: {
        some: { approvers: { some: { user: { OR: nameContains(q) } } } },
      },
    });
  }

  // ── Date ranges ─────────────────────────────────────────────────────
  if (req.expiresFrom || req.expiresTo) {
    const range: Prisma.DateTimeNullableFilter = {};
    if (req.expiresFrom) range.gte = new Date(req.expiresFrom);
    if (req.expiresTo) {
      // Include the whole "to" day
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

// Single top-bar status + header multi-select, "All" dropped, deduped.
export function collectStatuses(req: SearchMemosRequest): string[] {
  const set = new Set<string>();
  if (req.status && req.status !== 'All') set.add(req.status);
  if (req.statuses?.length) {
    for (const s of req.statuses) {
      if (s && s !== 'All') set.add(s);
    }
  }
  return Array.from(set);
}

export function resolveOrderBy(
  req: SearchMemosRequest,
): Prisma.MasterMemoOrderByWithRelationInput[] {
  const dir = req.sortDir ?? 'desc';
  switch (req.sortBy) {
    case 'memonumber':
      return [{ memonumber: dir }, { id: 'desc' }];
    case 'subject':
      return [{ subject: dir }, { id: 'desc' }];
    case 'expires':
      return [{ expiresAt: dir }, { id: 'desc' }];
    case 'createdAt':
      return [{ createdAt: dir }, { id: 'desc' }];
    default:
      // status / current / extra / latest / ccStatus / author / latestAction
      // are handled elsewhere or not directly mappable. Fall back to id.
      return [{ id: dir }];
  }
}
