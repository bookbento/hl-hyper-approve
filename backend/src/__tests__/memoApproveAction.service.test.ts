/**
 * Unit tests for memoApproveAction.service
 *
 * Covers:
 *  - getLatestVersion: returns max version or 1 default
 *  - approveAction handler: guard clauses + delegation + history recording
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock prisma BEFORE importing the module under test ──
vi.mock("../../prisma/client", () => ({
  prisma: {
    memoStatusPivot: {
      findFirst: vi.fn(),
    },
    memoApproverAction: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      aggregate: vi.fn(),
      update: vi.fn(),
    },
    approvalActionStatus: {
      findUnique: vi.fn(),
    },
    status: {
      findFirst: vi.fn(),
    },
    memoHistory: {
      create: vi.fn(),
    },
  },
}));

vi.mock("../services/memoNotification.service", () => ({
  notifyStatusUpdate: vi.fn(() => Promise.resolve()),
}));
vi.mock("../controllers/memoStatus.controller", () => ({
  updateCurrentMemoStatus: vi.fn(() => Promise.resolve()),
  getUserDisplayName: vi.fn(() => Promise.resolve("Alice Smith")),
  toDisplayName: vi.fn(() => "Alice Smith"),
}));
vi.mock("../services/extraApproval.service", () => ({
  hasActiveExtraLine: vi.fn(() => Promise.resolve(false)),
}));
vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("../lib/notify", () => ({ pushNoti: vi.fn() }));
vi.mock("../lib/notificationPreferences", () => ({ filterUsersForEmail: vi.fn() }));

import { getLatestVersion, approveAction, evaluateAndUpdateMemoStatus } from "../services/memoApproveAction.service";
import { hasActiveExtraLine } from "../services/extraApproval.service";
import { prisma } from "../../prisma/client";

const mp = prisma as any;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    params: { id: "1" },
    body: {
      loaUserId: 10,
      statusCode: "approved",
    },
    user: { id: 100 },
    ...overrides,
  } as any;
}

function makeRes() {
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as any;
}

// ─── getLatestVersion ─────────────────────────────────────────────────────────

describe("getLatestVersion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns max version from DB", async () => {
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 3 } });
    const result = await getLatestVersion(1);
    expect(result).toBe(3);
  });

  it("returns 1 when no rows exist (null max)", async () => {
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: null } });
    const result = await getLatestVersion(1);
    expect(result).toBe(1);
  });
});

// ─── approveAction guard clauses ─────────────────────────────────────────────

describe("approveAction — guard clauses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 when hasActiveExtraLine is true", async () => {
    (hasActiveExtraLine as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const req = makeReq();
    const res = makeRes();

    await approveAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("อนุมัติพิเศษ") })
    );
  });

  it("returns 409 when memo status is not Processing (5) for approved action", async () => {
    (hasActiveExtraLine as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    // Current status = Approved (3), not Processing (5)
    mp.memoStatusPivot.findFirst.mockResolvedValue({
      status: { id: 3, name: "Approved" },
    });

    const req = makeReq({ body: { loaUserId: 10, statusCode: "approved" } });
    const res = makeRes();

    await approveAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MEMO_STATUS_CHANGED" })
    );
  });

  it("returns 409 with REJECTED code when memo status is Rejected (4)", async () => {
    (hasActiveExtraLine as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    mp.memoStatusPivot.findFirst.mockResolvedValue({
      status: { id: 4, name: "Rejected" },
    });

    const req = makeReq({ body: { loaUserId: 10, statusCode: "rejected" } });
    const res = makeRes();

    await approveAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: "REJECTED" })
    );
  });

  it("returns 404 when approver action row not found", async () => {
    (hasActiveExtraLine as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    // Memo is in Processing (5)
    mp.memoStatusPivot.findFirst.mockResolvedValue({
      status: { id: 5, name: "Processing" },
    });
    // No approver action
    mp.memoApproverAction.findMany.mockResolvedValue([{ version: 1 }]);
    mp.memoApproverAction.findFirst.mockResolvedValue(null);

    const req = makeReq();
    const res = makeRes();

    await approveAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Approver action not found" });
  });

  it("returns 403 when actor is not the assigned approver or their delegate", async () => {
    (hasActiveExtraLine as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    mp.memoStatusPivot.findFirst.mockResolvedValue({
      status: { id: 5, name: "Processing" },
    });
    mp.memoApproverAction.findMany.mockResolvedValue([{ version: 1 }]);
    // approverAction belongs to userId=999, actor is 100
    mp.memoApproverAction.findFirst.mockResolvedValue({
      assignedUserId: null,
      loaUser: {
        userId: 999,
        user: {
          delegatedToUserId: null,
          delegationStartDate: null,
          delegationEndDate: null,
          name: "Other",
          lastname: "User",
          delegatedToUser: null,
        },
      },
    });

    const req = makeReq();
    const res = makeRes();

    await approveAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "You are not authorized to approve this memo" });
  });
});

// ─── approveAction — happy path ───────────────────────────────────────────────

describe("approveAction — success path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (hasActiveExtraLine as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    mp.memoStatusPivot.findFirst.mockResolvedValue({
      status: { id: 5, name: "Processing" },
    });
    mp.memoApproverAction.findMany.mockResolvedValue([{ version: 1 }]);
    // Actor IS the assigned approver (userId=100, actorId=100)
    mp.memoApproverAction.findFirst.mockResolvedValue({
      assignedUserId: 100,
      loaUser: {
        userId: 100,
        user: {
          delegatedToUserId: null,
          delegationStartDate: null,
          delegationEndDate: null,
          name: "Alice",
          lastname: "Smith",
          delegatedToUser: null,
        },
      },
    });
    mp.approvalActionStatus.findUnique.mockResolvedValue({ id: 2 });
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mp.memoApproverAction.update.mockResolvedValue({ id: 1, statusId: 2 });
    mp.status.findFirst.mockResolvedValue({ id: 3 });
    mp.memoHistory.create.mockResolvedValue({});
  });

  it("returns 200 and records history when actor is the assigned approver", async () => {
    const req = makeReq();
    const res = makeRes();

    await approveAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(mp.memoHistory.create).toHaveBeenCalledTimes(1);
  });

  it("records delegation info when actor is an active delegate", async () => {
    const now = new Date();
    const start = new Date(now.getTime() - 86400000); // yesterday
    const end = new Date(now.getTime() + 86400000);   // tomorrow

    mp.memoApproverAction.findFirst.mockResolvedValue({
      assignedUserId: null,
      loaUser: {
        userId: 200, // original approver
        user: {
          delegatedToUserId: 100, // actor is the delegate
          delegationStartDate: start,
          delegationEndDate: end,
          name: "Bob",
          lastname: "Jones",
          delegatedToUser: { name: "Alice", lastname: "Smith" },
        },
      },
    });

    const req = makeReq();
    const res = makeRes();

    await approveAction(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const jsonArg = res.json.mock.calls[0][0];
    expect(jsonArg.isDelegatedApproval).toBe(true);
    expect(jsonArg.delegationInfo).not.toBeNull();
    expect(jsonArg.delegationInfo.originalUserId).toBe(200);
  });
});
