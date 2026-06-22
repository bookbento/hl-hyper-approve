/**
 * Centralized memo Status ID map.
 *
 * Source of truth: prisma/seed.ts (Status.createMany) + DB runtime (memo-expiry.ts creates Expired).
 *
 * | id | name        | description |
 * |----|-------------|-------------|
 * |  1 | Draft       | Draft       |
 * |  3 | Approved    | Approved    |
 * |  4 | Rejected    | Rejected    |
 * |  5 | Processing  | Pending     |
 * |  6 | Recalled    | Recalled    |
 * |  7 | Terminated  | Terminate   |
 * |  8 | Expired     | (inserted by cron via memo-expiry.ts, not in static seed) |
 *
 * Note: id=2 is skipped in the seed; the schema never assigns it.
 */
export const MEMO_STATUS = {
  DRAFT: 1,
  APPROVED: 3,
  REJECTED: 4,
  PROCESSING: 5,
  RECALLED: 6,
  TERMINATED: 7,
  EXPIRED: 8,
} as const;

export type MemoStatusId = (typeof MEMO_STATUS)[keyof typeof MEMO_STATUS];

/** Status IDs that represent a terminal state — the memo can no longer be acted upon. */
export const TERMINAL_STATUS_IDS: ReadonlySet<MemoStatusId> = new Set([
  MEMO_STATUS.APPROVED,
  MEMO_STATUS.TERMINATED,
  MEMO_STATUS.EXPIRED,
]);

/** Status IDs that allow a memo to be edited (Draft only). */
export const EDITABLE_STATUS_IDS: ReadonlySet<MemoStatusId> = new Set([
  MEMO_STATUS.DRAFT,
]);

/** Status IDs blocked from further action in updateMemo (matches comment at memo.controller ~3747). */
export const BLOCKED_UPDATE_STATUS_IDS: ReadonlySet<MemoStatusId> = new Set([
  MEMO_STATUS.APPROVED,
  MEMO_STATUS.PROCESSING,
  MEMO_STATUS.TERMINATED,
  MEMO_STATUS.EXPIRED,
]);
