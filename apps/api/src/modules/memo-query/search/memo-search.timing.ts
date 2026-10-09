import { Logger } from '@nestjs/common';

/**
 * Per-phase timing log for the search pipeline.
 *
 * Env:
 *   MEMO_SEARCH_TIMING=1|true   always log
 *   MEMO_SEARCH_TIMING=0|false  never log
 *   MEMO_SEARCH_TIMING_THRESHOLD_MS  otherwise log only when total >= this (default 750)
 */
const MEMO_SEARCH_TIMING_THRESHOLD_MS = parseTimingThreshold(
  process.env['MEMO_SEARCH_TIMING_THRESHOLD_MS'],
);
const MEMO_SEARCH_TIMING_ALWAYS =
  process.env['MEMO_SEARCH_TIMING'] === '1' || process.env['MEMO_SEARCH_TIMING'] === 'true';
const MEMO_SEARCH_TIMING_DISABLED =
  process.env['MEMO_SEARCH_TIMING'] === '0' || process.env['MEMO_SEARCH_TIMING'] === 'false';

const logger = new Logger('MemoSearch');

type MemoSearchTimingPhase = {
  name: string;
  ms: number;
};

export type MemoSearchTimingMeta = {
  userId: number;
  page: number;
  pageSize: number | 'all';
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

export type MemoSearchTiming = ReturnType<typeof createMemoSearchTiming>;

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

export function createMemoSearchTiming() {
  const startedAt = nowMs();
  const phases: MemoSearchTimingPhase[] = [];

  return {
    async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const phaseStartedAt = nowMs();
      try {
        return await fn();
      } finally {
        phases.push({ name, ms: nowMs() - phaseStartedAt });
      }
    },

    log(meta: MemoSearchTimingMeta) {
      const totalMs = nowMs() - startedAt;
      if (!shouldLogMemoSearchTiming(totalMs)) return;

      const phaseText = phases.map((phase) => `${phase.name}=${formatMs(phase.ms)}`).join(' ');

      logger.log(
        [
          `total=${formatMs(totalMs)}`,
          phaseText,
          `userId=${meta.userId}`,
          `page=${meta.page}`,
          `pageSize=${meta.pageSize}`,
          `totalRows=${meta.total}`,
          `items=${meta.items}`,
          `hiddenIds=${meta.hiddenIds}`,
          `statusFilters=${meta.statusFilters}`,
          `searchLength=${meta.searchLength}`,
          `view=${meta.view ?? 'ALL'}`,
          `sortBy=${meta.sortBy ?? 'default'}`,
          `statCounts=${meta.includeStatCounts ? 'yes' : 'no'}`,
          `facets=${meta.includeFacets ? 'yes' : 'no'}`,
        ]
          .filter(Boolean)
          .join(' '),
      );
    },
  };
}
