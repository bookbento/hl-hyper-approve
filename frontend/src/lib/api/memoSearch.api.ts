import axios from "axios";
import { api } from "../api";
import type {
  SearchMemosRequest,
  SearchMemosResponse,
  StatCounts,
} from "./memoSearch.types";

// ─────────────────────────────────────────────────────────────────────
// API call
// ─────────────────────────────────────────────────────────────────────

export async function searchMemos(
  body: SearchMemosRequest,
  signal?: AbortSignal
): Promise<SearchMemosResponse> {
  const res = await api.post<SearchMemosResponse>(
    "/api/memos/search",
    body,
    { signal }
  );
  return res.data;
}

export async function searchMemoStats(
  signal?: AbortSignal,
  options: { forceRefresh?: boolean } = {}
): Promise<StatCounts> {
  const res = await api.post<{ statCounts: StatCounts }>(
    "/api/memos/search/stats",
    options.forceRefresh ? { forceRefresh: true } : {},
    { signal }
  );
  return res.data.statCounts;
}

export function isAbortError(err: unknown): boolean {
  if (axios.isCancel(err)) return true;
  const e = err as { name?: string; code?: string };
  return e?.name === "AbortError" || e?.name === "CanceledError" || e?.code === "ERR_CANCELED";
}

// ─────────────────────────────────────────────────────────────────────
// colFilters → SearchMemosRequest mapper
//
// dashboard.tsx keeps its existing colFilters/sortState state shape
// untouched. This mapper translates it into the new search-endpoint
// request body. Adjust here when the endpoint contract evolves.
// ─────────────────────────────────────────────────────────────────────

export type ColKey =
  | "memonumber"
  | "subject"
  | "author"
  | "status"
  | "current"
  | "extra"
  | "latest"
  | "expires"
  | "createdAt"
  | "ccStatus";

export type ExpiryKeyLocal = "expired" | "soon" | "active" | "none" | "closed";

export interface ColumnFilterStateLike {
  search?: string;
  values?: string[] | null;
  expiry?: ExpiryKeyLocal[] | null;
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface SortStateLike {
  key: ColKey;
  dir: "asc" | "desc";
}

export interface MapInput {
  colFilters: Record<ColKey, ColumnFilterStateLike>;
  sortState: SortStateLike | null;
  page: number;
  pageSize: number | "all";

  // top-bar
  searchText?: string;
  view?: "ALL" | "MY_APPROVAL" | "MY_CREATED";
  businessUnitId?: number | "All";
  departmentId?: number | "All";
  status?: string;

  // aggregates
  includeStatCounts?: boolean;
  includeFacets?: boolean;
}

export function colFiltersToSearchRequest(input: MapInput): SearchMemosRequest {
  const { colFilters, sortState } = input;

  const trim = (s?: string | null): string | undefined => {
    const v = s?.trim();
    return v ? v : undefined;
  };

  // Split mixed id/name values for current-approver dropdown:
  // numeric strings → ids, otherwise → names
  const currentValues = colFilters.current.values ?? [];
  const currentApproverIds: number[] = [];
  const currentApproverNames: string[] = [];
  for (const v of currentValues) {
    const asNum = Number(v);
    if (!Number.isNaN(asNum) && Number.isInteger(asNum) && asNum > 0) {
      currentApproverIds.push(asNum);
    } else {
      currentApproverNames.push(v);
    }
  }
  const extraValues = colFilters.extra.values ?? [];
  const extraApproverIds: number[] = [];
  const extraApproverNames: string[] = [];
  for (const v of extraValues) {
    const asNum = Number(v);
    if (!Number.isNaN(asNum) && Number.isInteger(asNum) && asNum > 0) {
      extraApproverIds.push(asNum);
    } else {
      extraApproverNames.push(v);
    }
  }
  const ccValues = colFilters.ccStatus.values ?? [];
  const ccUserIds: number[] = [];
  const ccUserNames: string[] = [];
  for (const v of ccValues) {
    const asNum = Number(v);
    if (!Number.isNaN(asNum) && Number.isInteger(asNum) && asNum > 0) {
      ccUserIds.push(asNum);
    } else {
      ccUserNames.push(v);
    }
  }

  const sortKeyRemap: Partial<Record<ColKey, SearchMemosRequest["sortBy"]>> = {
    memonumber: "memonumber",
    subject: "subject",
    author: "author",
    status: "status",
    current: "current",
    extra: "extra",
    latest: "latest",
    expires: "expires",
    createdAt: "createdAt",
    ccStatus: "ccStatus",
  };

  return {
    page: input.page,
    pageSize: input.pageSize,

    search: trim(input.searchText),

    view: input.view,
    status:
      input.status && input.status !== "All"
        ? (input.status as SearchMemosRequest["status"])
        : undefined,
    businessUnitId: input.businessUnitId,
    departmentId: input.departmentId,

    // text filters (column header)
    memonumberContains: trim(colFilters.memonumber.search),
    subjectContains: trim(colFilters.subject.search),
    authorContains: trim(colFilters.author.search),
    latestCommentContains: trim(colFilters.latest.search),
    extraApproverContains: trim(colFilters.extra.search),

    // list filters (multi-select)
    statuses: colFilters.status.values?.length
      ? colFilters.status.values
      : undefined,
    currentApproverIds: currentApproverIds.length ? currentApproverIds : undefined,
    currentApproverNames: currentApproverNames.length ? currentApproverNames : undefined,
    extraApproverIds: extraApproverIds.length ? extraApproverIds : undefined,
    extraApproverNames: extraApproverNames.length
      ? extraApproverNames
      : undefined,
    ccUserIds: ccUserIds.length ? ccUserIds : undefined,
    ccStatuses: ccUserNames.length
      ? ccUserNames
      : undefined,

    // date range
    expiresFrom: colFilters.expires.dateFrom ?? undefined,
    expiresTo: colFilters.expires.dateTo ?? undefined,
    createdFrom: colFilters.createdAt.dateFrom ?? undefined,
    createdTo: colFilters.createdAt.dateTo ?? undefined,

    // expiry states (multi)
    expiryStates: colFilters.expires.expiry?.length
      ? colFilters.expires.expiry
      : undefined,

    // sort
    sortBy: sortState ? sortKeyRemap[sortState.key] : undefined,
    sortDir: sortState?.dir,

    // aggregates
    includeStatCounts: input.includeStatCounts,
    includeFacets: input.includeFacets,
  };
}
