/**
 * Unit tests for memoAccess.service
 *
 * canViewMemo and canViewMemoSimple are pure access-control functions.
 * We mock prisma so these tests never touch a real DB.
 *
 * Scenarios covered:
 *  - memo not found
 *  - owner always has access
 *  - Draft blocks non-owners
 *  - extra-approver has access
 *  - comment-tagged user has access
 *  - approver in latest version has access
 *  - CC recipient has access
 *  - reference traversal grants access (canViewMemo only)
 *  - circular references are stopped by visited set (canViewMemo only)
 *  - canViewMemoSimple never follows references
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../prisma/client", () => ({
  prisma: {
    masterMemo: { findUnique: vi.fn() },
    memoStatusPivot: { findFirst: vi.fn() },
    extraApprover: { findFirst: vi.fn() },
    commentTag: { findFirst: vi.fn() },
    memoApproverAction: { findFirst: vi.fn(), aggregate: vi.fn() },
    memoCc: { findFirst: vi.fn() },
    memoReference: { findMany: vi.fn() },
  },
}));

import { canViewMemo, canViewMemoSimple } from "../services/memoAccess.service";
import { prisma } from "../../prisma/client";

const mp = prisma as any;

// ─── Shared stubs ────────────────────────────────────────────────────────────

const USER_ID = 10;
const OWNER_ID = 99;
const MEMO_ID = 1;

/** A memo owned by OWNER_ID */
const MEMO = { id: MEMO_ID, userId: OWNER_ID };

/** Non-draft pivot */
const PROCESSING_PIVOT = { status: { name: "Processing" } };
/** Draft pivot */
const DRAFT_PIVOT = { status: { name: "Draft" } };

beforeEach(() => {
  vi.clearAllMocks();

  // Default: memo exists
  mp.masterMemo.findUnique.mockResolvedValue(MEMO);
  // Default: non-draft status
  mp.memoStatusPivot.findFirst.mockResolvedValue(PROCESSING_PIVOT);
  // Default: user is NOT any of the roles
  mp.extraApprover.findFirst.mockResolvedValue(null);
  mp.commentTag.findFirst.mockResolvedValue(null);
  mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
  mp.memoApproverAction.findFirst.mockResolvedValue(null);
  mp.memoCc.findFirst.mockResolvedValue(null);
  mp.memoReference.findMany.mockResolvedValue([]);
});

// ─── canViewMemo tests ────────────────────────────────────────────────────────

describe("canViewMemo", () => {
  it("returns false when memo does not exist", async () => {
    mp.masterMemo.findUnique.mockResolvedValue(null);
    expect(await canViewMemo(USER_ID, MEMO_ID)).toBe(false);
  });

  it("returns true for the memo owner", async () => {
    expect(await canViewMemo(OWNER_ID, MEMO_ID)).toBe(true);
    // Should short-circuit before hitting status check
    expect(mp.memoStatusPivot.findFirst).not.toHaveBeenCalled();
  });

  it("returns false for non-owner on a Draft memo", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue(DRAFT_PIVOT);
    expect(await canViewMemo(USER_ID, MEMO_ID)).toBe(false);
  });

  it("returns true when user is a current/past extra-approver", async () => {
    mp.extraApprover.findFirst.mockResolvedValue({ id: 5 });
    expect(await canViewMemo(USER_ID, MEMO_ID)).toBe(true);
  });

  it("returns true when user is tagged in a comment", async () => {
    mp.commentTag.findFirst.mockResolvedValue({ id: 7 });
    expect(await canViewMemo(USER_ID, MEMO_ID)).toBe(true);
  });

  it("returns true when user is an approver in the latest version", async () => {
    mp.memoApproverAction.findFirst.mockResolvedValue({ id: 42 });
    expect(await canViewMemo(USER_ID, MEMO_ID)).toBe(true);
  });

  it("returns true when user is a CC recipient", async () => {
    mp.memoCc.findFirst.mockResolvedValue({ id: 3 });
    expect(await canViewMemo(USER_ID, MEMO_ID)).toBe(true);
  });

  it("returns false when user has none of the access roles", async () => {
    expect(await canViewMemo(USER_ID, MEMO_ID)).toBe(false);
  });

  // ── Reference traversal ──────────────────────────────────────────────────

  it("returns true when user owns a memo that references this memo", async () => {
    // Arrange — memo 1 is referenced by memo 2 (which USER_ID owns)
    mp.memoReference.findMany.mockResolvedValue([{ mainMemoId: 2 }]);

    // Second memo lookup: USER_ID owns memo 2
    mp.masterMemo.findUnique
      .mockResolvedValueOnce(MEMO) // first call: memo 1 (not owner)
      .mockResolvedValueOnce({ id: 2, userId: USER_ID }); // recursive: memo 2 (owner)

    expect(await canViewMemo(USER_ID, MEMO_ID)).toBe(true);
  });

  it("returns false when reference chain leads to no accessible memo", async () => {
    // Arrange — memo 1 is referenced by memo 2, but USER_ID has no access to memo 2
    mp.memoReference.findMany.mockResolvedValue([{ mainMemoId: 2 }]);

    mp.masterMemo.findUnique
      .mockResolvedValueOnce(MEMO)                       // memo 1
      .mockResolvedValueOnce({ id: 2, userId: 999 }); // memo 2 owned by someone else

    mp.memoStatusPivot.findFirst.mockResolvedValue(PROCESSING_PIVOT);
    mp.memoReference.findMany
      .mockResolvedValueOnce([{ mainMemoId: 2 }]) // memo 1 refs
      .mockResolvedValueOnce([]);                 // memo 2 refs (none)

    expect(await canViewMemo(USER_ID, MEMO_ID)).toBe(false);
  });

  it("stops infinite recursion on circular references (visited set)", async () => {
    // Arrange — memo 1 references memo 2, memo 2 references memo 1
    let findManyCallCount = 0;
    mp.memoReference.findMany.mockImplementation(({ where }: { where: { referenceMemoId: number } }) => {
      findManyCallCount++;
      if (where.referenceMemoId === MEMO_ID) return Promise.resolve([{ mainMemoId: 2 }]);
      if (where.referenceMemoId === 2) return Promise.resolve([{ mainMemoId: MEMO_ID }]);
      return Promise.resolve([]);
    });

    mp.masterMemo.findUnique.mockImplementation(({ where }: { where: { id: number } }) => {
      if (where.id === MEMO_ID) return Promise.resolve({ id: MEMO_ID, userId: OWNER_ID });
      if (where.id === 2) return Promise.resolve({ id: 2, userId: OWNER_ID }); // neither owned by USER_ID
      return Promise.resolve(null);
    });

    const result = await canViewMemo(USER_ID, MEMO_ID);

    // Should not throw or loop forever
    expect(result).toBe(false);
    // visited set should have stopped after both memos were visited
    expect(findManyCallCount).toBeLessThanOrEqual(4);
  });
});

// ─── canViewMemoSimple tests ──────────────────────────────────────────────────

describe("canViewMemoSimple", () => {
  it("returns false when memo does not exist", async () => {
    mp.masterMemo.findUnique.mockResolvedValue(null);
    expect(await canViewMemoSimple(USER_ID, MEMO_ID)).toBe(false);
  });

  it("returns true for the memo owner", async () => {
    expect(await canViewMemoSimple(OWNER_ID, MEMO_ID)).toBe(true);
    expect(mp.memoStatusPivot.findFirst).not.toHaveBeenCalled();
  });

  it("returns false for non-owner on a Draft memo", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue(DRAFT_PIVOT);
    expect(await canViewMemoSimple(USER_ID, MEMO_ID)).toBe(false);
  });

  it("returns true when user is an extra-approver", async () => {
    mp.extraApprover.findFirst.mockResolvedValue({ id: 5 });
    expect(await canViewMemoSimple(USER_ID, MEMO_ID)).toBe(true);
  });

  it("returns true when user is tagged in a comment", async () => {
    mp.commentTag.findFirst.mockResolvedValue({ id: 7 });
    expect(await canViewMemoSimple(USER_ID, MEMO_ID)).toBe(true);
  });

  it("returns true when user is an approver in the latest version", async () => {
    mp.memoApproverAction.findFirst.mockResolvedValue({ id: 42 });
    expect(await canViewMemoSimple(USER_ID, MEMO_ID)).toBe(true);
  });

  it("returns true when user is a CC recipient", async () => {
    mp.memoCc.findFirst.mockResolvedValue({ id: 3 });
    expect(await canViewMemoSimple(USER_ID, MEMO_ID)).toBe(true);
  });

  it("returns false when user has no access roles", async () => {
    expect(await canViewMemoSimple(USER_ID, MEMO_ID)).toBe(false);
  });

  it("does NOT follow references (unlike canViewMemo)", async () => {
    // Arrange — memo 2 references memo 1, USER_ID owns memo 2
    // canViewMemoSimple should NOT traverse this
    mp.memoReference.findMany.mockResolvedValue([{ mainMemoId: 2 }]);

    expect(await canViewMemoSimple(USER_ID, MEMO_ID)).toBe(false);
    // memoReference.findMany should never be called by canViewMemoSimple
    expect(mp.memoReference.findMany).not.toHaveBeenCalled();
  });
});
