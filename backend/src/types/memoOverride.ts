/**
 * Shared OverrideItem type for approver override arrays.
 *
 * Two usage sites in memo.controller.ts were defining this type inline:
 *   - createMemo  (~line 3017): userId is `number | null` to support FLEXIBLE_SLOT
 *   - updateMemo  (~line 3770): userId is `number` (no null)
 *
 * This shared type uses `number | null` (the broader contract from createMemo)
 * so both call sites can import from one place without narrowing breakage.
 * updateMemo callers should validate that userId is non-null before use.
 */
export type OverrideItem = {
  /** Null is allowed for FLEXIBLE_SLOT entries (createMemo). updateMemo should always provide a value. */
  userId: number | null;
  level: number;
  isSigReq?: boolean;
  roleDescription?: string | null;
  slotType?:
    | "FIXED_USER"
    | "MEMO_REQUESTER"
    | "DEPARTMENT_HEAD"
    | "FLEXIBLE_SLOT"
    | null;
  loaUserPivotId?: number | null;
  /** Approval requirement for this level: ALL requires every approver; ANY requires at least one. */
  approvalRequirement?: "ALL" | "ANY";
};
