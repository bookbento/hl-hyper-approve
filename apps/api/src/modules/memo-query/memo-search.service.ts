/**
 * MemoSearchNestService (Nest)
 *
 * POST /api/memos/search pipeline + cached stat counts / facets.
 * Ported from backend/src/services/memoSearch.service.ts; the pieces live
 * in ./search/ (filters, raw-SQL resolvers, row formatting, aggregates).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LRUCache } from 'lru-cache';
import { PrismaService } from '../../prisma/prisma.service';
import { computeFacets, computeVisibleStatCounts } from './search/memo-search.aggregates';
import {
  buildFilterClause,
  buildVisibilityClause,
  collectStatuses,
} from './search/memo-search.filters';
import { fetchItemsByIds, fetchItemsForPage } from './search/memo-search.items';
import {
  collectCurrentApproverIds,
  resolveAwaitingMemoIds,
  resolveHiddenMemoIds,
  resolveLatestActionOrder,
  resolveLatestCommentOrder,
  resolveMemoIdsByCurrentApprover,
  resolveMemoIdsByLatestComment,
  resolveMemoIdsByStatus,
} from './search/memo-search.resolvers';
import { createMemoSearchTiming } from './search/memo-search.timing';
import type {
  Facets,
  MemoListItem,
  SearchMemosRequest,
  SearchMemosResponse,
  StatCounts,
} from './search/memo-search.types';

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const STAT_COUNTS_CACHE_TTL_MS = 60 * 1000;
const STAT_COUNTS_CACHE_MAX = 500;
const FACET_CACHE_TTL_MS = 60 * 1000;
const FACET_CACHE_MAX = 500;

@Injectable()
export class MemoSearchNestService {
  // Per-user metadata caches. Expire by TTL, and are dropped whenever a memo
  // status changes (invalidateAll — MIGRATION-STATUS C2).
  private readonly statCountsCache = new LRUCache<string, StatCounts>({
    max: STAT_COUNTS_CACHE_MAX,
    ttl: STAT_COUNTS_CACHE_TTL_MS,
  });

  private readonly facetCache = new LRUCache<string, Facets>({
    max: FACET_CACHE_MAX,
    ttl: FACET_CACHE_TTL_MS,
  });

  constructor(private readonly prisma: PrismaService) {}

  // Step 1.12 — main pipeline
  //
  // Pipeline:
  //   1. parse pagination
  //   2. build base where (visibility + hidden filter)
  //   3. apply column / search filters
  //   4. apply view (MY_CREATED, MY_APPROVAL)
  //   5. apply status filter (latest pivot)
  //   6. apply current approver filter (raw SQL resolver)
  //   7. count + fetch items (optional latestAction / latest comment sort)
  //   8. compute statCounts + facets (opt-in)
  async searchMemos(
    req: SearchMemosRequest,
    userId: number,
    hostUrl: string,
  ): Promise<SearchMemosResponse> {
    const db = this.prisma;
    const timing = createMemoSearchTiming();

    // ── 1. pagination ─────────────────────────────────────────────────
    const requestedPageSize = req.pageSize ?? DEFAULT_PAGE_SIZE;
    const isAll = requestedPageSize === 'all';
    const pageSizeNum = isAll
      ? null
      : Math.min(MAX_PAGE_SIZE, Math.max(1, Number(requestedPageSize)));
    const page = Math.max(1, Number(req.page) || 1);
    const skip = isAll || pageSizeNum === null ? 0 : (page - 1) * pageSizeNum;
    const take = isAll ? null : pageSizeNum;

    // ── 2. base where (visibility + exclude hidden) ───────────────────
    const visibility = buildVisibilityClause(userId);
    const hiddenIds = await timing.measure('hiddenIds', () => resolveHiddenMemoIds(db, userId));
    const filters = buildFilterClause(req);

    const baseAnd: Prisma.MasterMemoWhereInput[] = [visibility, filters];
    if (hiddenIds.length) baseAnd.push({ id: { notIn: hiddenIds } });

    // ── 3. view filter ────────────────────────────────────────────────
    if (req.view === 'MY_CREATED') {
      baseAnd.push({ userId });
    }

    // ── 4. status filter (single + multi) ─────────────────────────────
    const statusList = collectStatuses(req);
    if (statusList.length) {
      const ids = await timing.measure('statusIds', () => resolveMemoIdsByStatus(db, statusList));
      baseAnd.push(ids.length ? { id: { in: ids } } : { id: -1 });
    }

    // ── 5. current approver filter (ids + names) ──────────────────────
    const approverIds = await timing.measure('currentApproverIds', () =>
      collectCurrentApproverIds(db, req),
    );
    if (approverIds !== null) {
      if (!approverIds.length) {
        baseAnd.push({ id: -1 });
      } else {
        const ids = await timing.measure('currentApproverMemoIds', () =>
          resolveMemoIdsByCurrentApprover(db, approverIds),
        );
        baseAnd.push(ids.length ? { id: { in: ids } } : { id: -1 });
      }
    }

    // ── 5b. latest comment filter ────────────────────────────────────
    const latestCommentQuery = req.latestCommentContains?.trim();
    if (latestCommentQuery) {
      const ids = await timing.measure('latestCommentMemoIds', () =>
        resolveMemoIdsByLatestComment(db, latestCommentQuery),
      );
      baseAnd.push(ids.length ? { id: { in: ids } } : { id: -1 });
    }

    // ── 6. MY_APPROVAL view (after status/etc. baseline so it can refine) ─
    if (req.view === 'MY_APPROVAL') {
      const [awaitingIds, processingIds] = await timing.measure('myApprovalIds', () =>
        Promise.all([
          resolveAwaitingMemoIds(db, userId),
          resolveMemoIdsByStatus(db, ['Processing']),
        ]),
      );
      const processingSet = new Set(processingIds);
      const intersect = awaitingIds.filter((id) => processingSet.has(id));
      baseAnd.push(intersect.length ? { id: { in: intersect } } : { id: -1 });
    }

    const where: Prisma.MasterMemoWhereInput = { AND: baseAnd };

    // ── 7. count + fetch items ────────────────────────────────────────
    let items: MemoListItem[];
    let total: number;

    if (req.sortBy === 'latestAction' || req.sortBy === 'latest') {
      // Sort keys that need raw SQL: resolve the full candidate set, order
      // + page it in SQL, then fetch just that page by id.
      const label = req.sortBy === 'latestAction' ? 'latestAction' : 'latestComment';
      const matching = await timing.measure(`${label}Candidates`, () =>
        db.masterMemo.findMany({ where, select: { id: true } }),
      );
      total = matching.length;
      const resolveOrder =
        req.sortBy === 'latestAction' ? resolveLatestActionOrder : resolveLatestCommentOrder;
      const orderedIds = await timing.measure(`${label}Order`, () =>
        resolveOrder(
          db,
          matching.map((m) => m.id),
          req.sortDir ?? 'desc',
          skip,
          take,
        ),
      );
      items = await timing.measure('fetchItemsByIds', () =>
        fetchItemsByIds(db, orderedIds, userId, hostUrl),
      );
    } else {
      const [count, fetched] = await Promise.all([
        timing.measure('count', () => db.masterMemo.count({ where })),
        timing.measure('fetchItems', () =>
          fetchItemsForPage(db, where, req, userId, hostUrl, skip, take),
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

    if (wantStat) {
      statCounts = await timing.measure('statCounts', () =>
        this.getCachedStatCounts(userId, false, hiddenIds),
      );
    }
    if (wantFacets) {
      facets = await timing.measure('facets', () => this.getFacets(userId));
    }

    timing.log({
      userId,
      page,
      pageSize: isAll ? 'all' : pageSizeNum!,
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
      pageSize: isAll ? 'all' : pageSizeNum!,
      total,
      totalPages: isAll ? 1 : pageSizeNum ? Math.max(1, Math.ceil(total / pageSizeNum)) : 1,
      statCounts,
      facets,
    };
  }

  async getCachedStatCounts(
    userId: number,
    forceRefresh?: boolean,
    preResolvedHiddenIds?: number[],
  ): Promise<StatCounts> {
    const key = `statCounts:userId=${userId}`;
    if (!forceRefresh) {
      const cached = this.statCountsCache.get(key);
      if (cached) return cached;
    }

    const fresh = await computeVisibleStatCounts(this.prisma, userId, preResolvedHiddenIds);
    this.statCountsCache.set(key, fresh);
    return fresh;
  }

  /**
   * Drop every user's cached stats/facets. Called after a memo status write:
   * one change moves counts for the owner, approvers and CCs alike, so
   * clearing only the actor's entry would leave the others stale.
   */
  invalidateAll(): void {
    this.statCountsCache.clear();
    this.facetCache.clear();
  }

  // Step 1.11 — cached 60s per user
  async getFacets(userId: number): Promise<Facets> {
    const key = `facets:userId=${userId}`;
    const cached = this.facetCache.get(key);
    if (cached) return cached;
    const fresh = await computeFacets(this.prisma, userId);
    this.facetCache.set(key, fresh);
    return fresh;
  }
}
