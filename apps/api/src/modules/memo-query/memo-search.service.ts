/**
 * MemoSearchNestService (Nest)
 *
 * Delegates to the pure-logic functions from backend memoSearch.service.
 * Uses dynamic require at runtime to bridge the TypeScript compilation
 * boundary between apps/api and backend workspaces.
 *
 * The backend functions (searchMemos, getCachedStatCounts) are stateless
 * and use the shared Prisma client — safe to call from Nest context.
 */
import { Injectable } from '@nestjs/common';

// Type-only imports for editor support — resolved by tsconfig path or ignored
type SearchMemosRequest = Record<string, unknown>;
type SearchMemosResponse = unknown;
type StatCounts = unknown;

type SearchMemosCore = (
  req: SearchMemosRequest,
  userId: number,
  hostUrl: string,
) => Promise<SearchMemosResponse>;

type GetCachedStatCountsCore = (
  userId: number,
  preResolvedHiddenIds?: number[],
  options?: { forceRefresh?: boolean },
) => Promise<StatCounts>;

function loadMemoSearchService(): {
  searchMemos: SearchMemosCore;
  getCachedStatCounts: GetCachedStatCountsCore;
} {
  // At runtime the backend is a CommonJS package in the same monorepo.
  // We resolve relative to the process cwd which is the project root.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const svc = require('../../../../backend/src/services/memoSearch.service') as {
    searchMemos: SearchMemosCore;
    getCachedStatCounts: GetCachedStatCountsCore;
  };
  return svc;
}

@Injectable()
export class MemoSearchNestService {
  async searchMemos(
    req: SearchMemosRequest,
    userId: number,
    hostUrl: string,
  ): Promise<SearchMemosResponse> {
    const { searchMemos } = loadMemoSearchService();
    return searchMemos(req, userId, hostUrl);
  }

  async getCachedStatCounts(
    userId: number,
    forceRefresh?: boolean,
  ): Promise<StatCounts> {
    const { getCachedStatCounts } = loadMemoSearchService();
    return getCachedStatCounts(userId, undefined, { forceRefresh: forceRefresh ?? false });
  }
}
