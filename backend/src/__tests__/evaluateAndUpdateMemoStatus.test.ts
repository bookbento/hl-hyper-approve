/**
 * Integration-style tests for evaluateAndUpdateMemoStatus (mock prisma).
 *
 * Core state machine: decides whether a memo becomes Approved (3), Rejected (4),
 * or Processing (5) after an approver acts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock prisma BEFORE importing the module under test ──
// NOTE: vi.mock factory is hoisted — no top-level variables allowed inside.
vi.mock("../../prisma/client", () => ({
  prisma: {
    lineOfApprovalUserPivotForUse: { findUnique: vi.fn() },
    masterMemo: { findUnique: vi.fn() },
    memoApproverAction: { findMany: vi.fn(), aggregate: vi.fn() },
    memoStatusPivot: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    $transaction: vi.fn(),
    // Models used only by notifyStatusUpdate (side-effect) — return safe defaults
    approvalActionStatus: { findUnique: vi.fn(() => Promise.resolve({ id: 1 })) },
    notification: {
      findMany: vi.fn(() => Promise.resolve([])),
      create: vi.fn(() => Promise.resolve({})),
    },
    memoCc: { findMany: vi.fn(() => Promise.resolve([])) },
    user: { findMany: vi.fn(() => Promise.resolve([])) },
    memoHistory: { findFirst: vi.fn(() => Promise.resolve(null)) },
    lineOfApprovalUserPivot: { findMany: vi.fn(() => Promise.resolve([])) },
    comment: { findMany: vi.fn(() => Promise.resolve([])) },
    status: { findFirst: vi.fn(() => Promise.resolve(null)) },
    attachedFile: { findMany: vi.fn(() => Promise.resolve([])) },
    extraApprover: { findMany: vi.fn(() => Promise.resolve([])) },
    extraApprovalLine: {
      findMany: vi.fn(() => Promise.resolve([])),
      update: vi.fn(() => Promise.resolve({})),
    },
  },
}));

vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("../lib/notify", () => ({ pushNoti: vi.fn() }));
vi.mock("../lib/token", () => ({ makeEmailToken: vi.fn(), verifyEmailToken: vi.fn() }));
vi.mock("../lib/notificationPreferences", () => ({ filterUsersForEmail: vi.fn() }));
vi.mock("../services/memoApproval.service", () => ({
  getPendingActions: vi.fn(),
  recordApproverAction: vi.fn(),
}));
vi.mock("../approverLine", () => ({ getApproverLineStatus: vi.fn() }));
vi.mock("../services/pdf.core", () => ({ createSignedPdfBuffer: vi.fn() }));
vi.mock("../lib/memoHistory", () => ({ logMemoHistory: vi.fn() }));

import { evaluateAndUpdateMemoStatus } from "../controllers/memoStatus.controller";
import { prisma } from "../../prisma/client";

const mp = prisma as any;

// ─── Helpers ────────────────────────────────────────────────────────────────

const ACTOR_PIVOT = {
  id: 10,
  userId: 100,
  level: 1,
  user: { id: 100, name: "Alice", lastname: "Smith", nickname: "alice" },
};

const MEMO_ROW = {
  userId: 200,
  subject: "Test Memo",
  id: 1,
  memonumber: "MEMO-001",
  memoNumberRecord: null,
  memoType: null,
  businessUnit: null,
  department: null,
  approvalLineId: null,
  expiresAt: null,
};

function makePivot(id: number, userId: number, level: number, req: "ALL" | "ANY" = "ALL") {
  return { id, userId, level, approvalRequirement: req, user: { id: userId, name: `User${userId}` } };
}

function makeAction(loaUserId: number, level: number, code: string, req: "ALL" | "ANY" = "ALL") {
  return {
    id: loaUserId * 100,
    loaUserId,
    status: { code },
    loaUser: { level, approvalRequirement: req },
  };
}

/**
 * Set up findMany call sequence:
 * call 1 = getClonePivots (loaUser-shaped rows)
 * call 2 = actions in evaluateAndUpdateMemoStatus
 * call 3+ = notifyStatusUpdate side-effects → return []
 */
function setupScenario(
  pivots: ReturnType<typeof makePivot>[],
  actions: ReturnType<typeof makeAction>[]
) {
  let callCount = 0;
  mp.memoApproverAction.findMany.mockImplementation((_args: unknown) => {
    callCount++;
    if (callCount === 1) {
      return Promise.resolve(
        pivots.map((p) => ({
          loaUser: {
            id: p.id,
            userId: p.userId,
            level: p.level,
            approvalRequirement: p.approvalRequirement,
            user: p.user,
          },
        }))
      );
    }
    if (callCount === 2) {
      return Promise.resolve(actions);
    }
    return Promise.resolve([]);
  });
}

/** All statusIds written to memoStatusPivot via create or update */
function capturedStatusIds(): number[] {
  const allCalls = [
    ...mp.memoStatusPivot.create.mock.calls,
    ...mp.memoStatusPivot.update.mock.calls,
  ] as Array<[{ data?: { statusId?: number } }]>;
  return allCalls.flatMap(([arg]) =>
    arg?.data?.statusId !== undefined ? [arg.data.statusId] : []
  );
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  mp.lineOfApprovalUserPivotForUse.findUnique.mockResolvedValue(ACTOR_PIVOT);
  mp.masterMemo.findUnique.mockResolvedValue(MEMO_ROW);
  mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });

  mp.$transaction.mockImplementation((fn: (tx: typeof mp) => Promise<unknown>) => fn(mp));

  mp.memoStatusPivot.findFirst.mockResolvedValue(null);
  mp.memoStatusPivot.create.mockResolvedValue({});
  mp.memoStatusPivot.update.mockResolvedValue({});
  mp.memoStatusPivot.deleteMany.mockResolvedValue({ count: 0 });

  // notifyStatusUpdate side-effects
  mp.approvalActionStatus.findUnique.mockResolvedValue({ id: 1 });
  mp.notification.findMany.mockResolvedValue([]);
  mp.notification.create.mockResolvedValue({});
  mp.memoCc.findMany.mockResolvedValue([]);
  mp.user.findMany.mockResolvedValue([]);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("evaluateAndUpdateMemoStatus — guard clauses", () => {
  it("throws when loaPivot not found", async () => {
    mp.lineOfApprovalUserPivotForUse.findUnique.mockResolvedValue(null);
    await expect(evaluateAndUpdateMemoStatus(1, 999)).rejects.toThrow("loaUserPivotId ไม่ถูกต้อง");
  });

  it("throws when memo not found", async () => {
    mp.masterMemo.findUnique.mockResolvedValue(null);
    setupScenario([], []);
    await expect(evaluateAndUpdateMemoStatus(1, 10)).rejects.toThrow("memo not found");
  });
});

describe("evaluateAndUpdateMemoStatus — ALL requirement", () => {
  it("sets PROCESSING (5) when not all approvers have acted", async () => {
    setupScenario(
      [makePivot(10, 100, 1), makePivot(11, 101, 1)],
      [makeAction(10, 1, "approved"), makeAction(11, 1, "waiting")]
    );

    await evaluateAndUpdateMemoStatus(1, 10);

    const ids = capturedStatusIds();
    expect(ids).toContain(5);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4);
  });

  it("sets APPROVED (3) when all approvers approve", async () => {
    setupScenario(
      [makePivot(10, 100, 1, "ALL"), makePivot(11, 101, 1, "ALL")],
      [makeAction(10, 1, "approved", "ALL"), makeAction(11, 1, "approved", "ALL")]
    );

    await evaluateAndUpdateMemoStatus(1, 10);

    const ids = capturedStatusIds();
    expect(ids).toContain(3);
    expect(ids).not.toContain(4);
    expect(ids).not.toContain(5);
  });

  it("sets REJECTED (4) when any approver rejects, even with other approvals", async () => {
    setupScenario(
      [makePivot(10, 100, 1), makePivot(11, 101, 1)],
      [makeAction(10, 1, "approved"), makeAction(11, 1, "rejected")]
    );

    await evaluateAndUpdateMemoStatus(1, 10);

    const ids = capturedStatusIds();
    expect(ids).toContain(4);
    expect(ids).not.toContain(3);
  });

  it("sets PROCESSING when level 1 complete but level 2 still waiting", async () => {
    setupScenario(
      [makePivot(10, 100, 1, "ALL"), makePivot(20, 200, 2, "ALL")],
      [makeAction(10, 1, "approved", "ALL"), makeAction(20, 2, "waiting", "ALL")]
    );

    await evaluateAndUpdateMemoStatus(1, 10);

    const ids = capturedStatusIds();
    expect(ids).toContain(5);
    expect(ids).not.toContain(3);
  });

  it("sets APPROVED when all levels fully approved (multi-level)", async () => {
    setupScenario(
      [makePivot(10, 100, 1, "ALL"), makePivot(20, 200, 2, "ALL")],
      [makeAction(10, 1, "approved", "ALL"), makeAction(20, 2, "approved", "ALL")]
    );

    await evaluateAndUpdateMemoStatus(1, 10);

    const ids = capturedStatusIds();
    expect(ids).toContain(3);
    expect(ids).not.toContain(5);
  });
});

describe("evaluateAndUpdateMemoStatus — ANY requirement", () => {
  it("sets APPROVED when ANY: one approver approved (other still waiting)", async () => {
    setupScenario(
      [makePivot(10, 100, 1, "ANY"), makePivot(11, 101, 1, "ANY")],
      [makeAction(10, 1, "approved", "ANY"), makeAction(11, 1, "waiting", "ANY")]
    );

    await evaluateAndUpdateMemoStatus(1, 10);

    const ids = capturedStatusIds();
    expect(ids).toContain(3);
    expect(ids).not.toContain(5);
  });

  it("sets REJECTED when all members at ANY level reject", async () => {
    setupScenario(
      [makePivot(10, 100, 1, "ANY"), makePivot(11, 101, 1, "ANY")],
      [makeAction(10, 1, "rejected", "ANY"), makeAction(11, 1, "rejected", "ANY")]
    );

    await evaluateAndUpdateMemoStatus(1, 10);

    const ids = capturedStatusIds();
    expect(ids).toContain(4);
    expect(ids).not.toContain(3);
  });
});
