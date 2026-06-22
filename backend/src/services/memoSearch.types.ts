// Types for POST /api/memos/search
// Mirror this file in frontend/src/lib/api/memoSearch.types.ts

export type SortDir = "asc" | "desc";

export type SortKey =
  | "memonumber"
  | "subject"
  | "author"
  | "status"
  | "current"
  | "extra"
  | "latest"
  | "expires"
  | "createdAt"
  | "ccStatus"
  | "latestAction";

export type ExpiryKey =
  | "expired"
  | "soon"
  | "active"
  | "none"
  | "closed";

export type ViewKey = "ALL" | "MY_APPROVAL" | "MY_CREATED";

export type StatusName =
  | "All"
  | "Draft"
  | "Processing"
  | "Approved"
  | "Rejected"
  | "Terminated"
  | "Recalled"
  | "Published";

export interface SearchMemosRequest {
  // pagination
  page?: number;
  pageSize?: number | "all";

  // free-text search (top search box)
  search?: string;

  // top-bar filters
  status?: StatusName;
  view?: ViewKey;
  businessUnitId?: number | "All";
  departmentId?: number | "All";

  // header column filters (multi-select)
  statuses?: string[];
  currentApproverIds?: number[];
  currentApproverNames?: string[];
  extraApproverIds?: number[];
  extraApproverNames?: string[];
  ccUserIds?: number[];
  ccStatuses?: string[];

  // header column text filters
  subjectContains?: string;
  memonumberContains?: string;
  authorContains?: string;
  latestCommentContains?: string;
  extraApproverContains?: string;

  // date range
  expiresFrom?: string; // ISO date YYYY-MM-DD
  expiresTo?: string;
  createdFrom?: string;
  createdTo?: string;

  // expiry status (multi)
  expiryStates?: ExpiryKey[];

  // sort
  sortBy?: SortKey;
  sortDir?: SortDir;

  // heavy aggregates (opt-in)
  includeStatCounts?: boolean;
  includeFacets?: boolean;
}

export interface ApproverStatusRow {
  userId: number;
  loaUserId: number;
  level: number;
  name: string;
  statusCode: "waiting" | "approved" | "rejected" | "skipped" | string;
  actedAt: string | null;
  since: string | null;
  approvalRequirement?: "ALL" | "ANY";
}

export interface ExtraApproverRow {
  id: number;
  actedAt: string | null;
  statusId: number | null;
  status: { id: number; name: string } | null;
  user: {
    id: number;
    name: string;
    lastname: string | null;
    nickname: string | null;
    profileImagePath: string | null;
  };
}

export interface ExtraApprovalSummary {
  id: number;
  status: string; // PENDING | IN_PROGRESS | COMPLETED | REJECTED
  createdAt: string;
  approvers: ExtraApproverRow[];
}

export interface MemoListItem {
  // base fields (mirror current /api/memos response)
  id: number;
  subject: string;
  documentCode: string; // "MEMO-{id}"
  memonumber: string | null;
  user: {
    id: number;
    name: string;
    lastname: string | null;
    nickname: string | null;
    department: { id: number; name: string } | null;
  };
  department: { id: number; name: string } | null;
  businessUnit: { id: number; name: string } | null;
  type: string | null;
  status: string;
  latestApprovedDate: string | null;
  createdAt: string | null;
  expiresAt: string | null;
  currentApprover: { names: string[]; level: number } | null;
  canSeeComments: boolean;
  latestComment: {
    id: number;
    userId: number;
    userName: string;
    nickname: string | null;
    comment: string;
    snippet: string;
    createdAt: string;
    attachments: Array<{
      url: string;
      fileName: string;
      mimeType: string | null;
      isImage: boolean;
    }>;
  } | null;
  lastHistory: {
    action: string;
    actiontype: string | null;
    timestamp: string;
    userName: string;
    statusName: string | null;
  } | null;

  // inline (replaces approverMap / extraMap / memosCCData fetches)
  approverStatus: ApproverStatusRow[];
  extraApproval: ExtraApprovalSummary | null;
  ccUsers: Array<{
    id: number;
    name: string;
    lastname: string | null;
    nickname: string | null;
  }>;

  // derived for FE filter/sort
  isMyTurnMain: boolean;
  isMyTurnExtra: boolean;
  latestActionAt: string | null;
}

export interface StatCounts {
  total: number;
  Draft: number;
  Processing: number;
  Approved: number;
  Rejected: number;
  Terminated: number;
  Published: number;
  Recalled: number;
  myApproval: number;
  myCreated: number;
  myCC: number;
}

export interface FacetUser {
  id: number;
  name: string;
}

export interface FacetEntity {
  id: number;
  name: string;
}

export interface Facets {
  currentApprovers: FacetUser[];
  extraApprovers: FacetUser[];
  businessUnits: FacetEntity[];
  departments: FacetEntity[];
  ccUsers: FacetUser[];
}

export interface SearchMemosResponse {
  items: MemoListItem[];
  page: number;
  pageSize: number | "all";
  total: number;
  totalPages: number;
  statCounts?: StatCounts;
  facets?: Facets;
}
