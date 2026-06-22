/**
 * Unit tests for memoRecall.service (Wave 8)
 *
 * Covers:
 *  - recallMemo: validates input, creates pivot, delegates to recallClearCore
 *  - recallMemoPreserve: upserts pivot, creates history
 *  - handleRecall: resets only waiting/rejected actions, bumps pivot 6→1
 *  - recallPreserve: guards non-Processing/Rejected status, transitions pivot, writes history
 *  - recallClear: guards status, deletes extra lines, writes REVISE or RECALL history
 *  - recallClear vs recallPreserve differ correctly (clear deletes extra lines, preserve keeps them)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock prisma BEFORE importing the module under test ──────────────────────
vi.mock("../../prisma/client", () => ({
  prisma: {
    memoStatusPivot: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
      update: vi.fn(),
      upsert: vi.fn(),
    },
    memoHistory: {
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    memoApproverAction: {
      aggregate: vi.fn(),
      updateMany: vi.fn(),
    },
    approvalActionStatus: {
      findUnique: vi.fn(),
    },
    status: {
      findFirst: vi.fn(),
    },
    extraApprovalLine: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    extraApprover: {
      updateMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    comment: {
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    masterMemo: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("../controllers/memoStatus.controller", () => ({
  updateCurrentMemoStatus: vi.fn(() => Promise.resolve()),
  getUserDisplayName: vi.fn(() => Promise.resolve("Alice")),
}));

vi.mock("../services/memoApproveAction.service", () => ({
  getLatestVersion: vi.fn(() => Promise.resolve(1)),
}));

vi.mock("../services/memoNotification.service", () => ({
  notifyRecallUpdate: vi.fn(() => Promise.resolve()),
}));

import {
  recallMemo,
  recallMemoPreserve,
  handleRecall,
  recallPreserve,
  recallClear,
  recallClearCore,
} from "../services/memoRecall.service";
import { prisma } from "../../prisma/client";
import { updateCurrentMemoStatus } from "../controllers/memoStatus.controller";
import { notifyRecallUpdate } from "../services/memoNotification.service";

const mp = prisma as any;
const mockUpdateStatus = updateCurrentMemoStatus as ReturnType<typeof vi.fn>;
const mockNotify = notifyRecallUpdate as ReturnType<typeof vi.fn>;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    params: { id: "5" },
    body: { userId: 10 },
    user: { id: 10 },
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

function setupCommonMocks() {
  mp.approvalActionStatus.findUnique.mockResolvedValue({ id: 1 });
  mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 2 } });
  mp.memoApproverAction.updateMany.mockResolvedValue({ count: 0 });
  mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
  mp.memoStatusPivot.create.mockResolvedValue({});
  mp.memoStatusPivot.deleteMany.mockResolvedValue({ count: 0 });
  mp.memoStatusPivot.upsert.mockResolvedValue({});
  mp.memoHistory.create.mockResolvedValue({});
  mp.memoHistory.deleteMany.mockResolvedValue({ count: 0 });
  mp.extraApprovalLine.findMany.mockResolvedValue([]);
  mp.extraApprovalLine.updateMany.mockResolvedValue({ count: 0 });
  mp.extraApprovalLine.deleteMany.mockResolvedValue({ count: 0 });
  mp.extraApprovalLine.count.mockResolvedValue(0);
  mp.extraApprover.updateMany.mockResolvedValue({ count: 0 });
  mp.extraApprover.deleteMany.mockResolvedValue({ count: 0 });
  mp.extraApprover.count.mockResolvedValue(0);
  mp.comment.updateMany.mockResolvedValue({ count: 0 });
  mp.user.findUnique.mockResolvedValue({ name: "Alice" });
  mp.masterMemo.findUnique.mockResolvedValue({ userId: 10 });
  mp.status.findFirst.mockResolvedValue({ id: 4, name: "Rejected" });
  mp.$transaction.mockImplementation((cb: any) => {
    if (typeof cb === "function") {
      return cb(mp);
    }
    return Promise.all(cb);
  });
}

// ── recallMemo ────────────────────────────────────────────────────────────

describe("recallMemo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
  });

  it("returns 400 when memoId is NaN", async () => {
    const req = makeReq({ params: { id: "abc" } });
    const res = makeRes();
    await recallMemo(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it("returns 400 when userId is missing / NaN", async () => {
    const req = makeReq({ body: { userId: "notanumber" } });
    const res = makeRes();
    await recallMemo(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("creates Recall(6) pivot then responds 201", async () => {
    const req = makeReq();
    const res = makeRes();
    await recallMemo(req, res, vi.fn());
    expect(mp.memoStatusPivot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ statusId: 6 }),
      })
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("deletes Processing(5) pivot and history rows (legacy behaviour)", async () => {
    const req = makeReq();
    const res = makeRes();
    await recallMemo(req, res, vi.fn());
    expect(mp.memoStatusPivot.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ statusId: 5 }) })
    );
    expect(mp.memoHistory.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ statusId: 5 }) })
    );
  });

  it("resets approver actions to waiting", async () => {
    const req = makeReq();
    const res = makeRes();
    await recallMemo(req, res, vi.fn());
    expect(mp.memoApproverAction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actedAt: null,
          signatureImageId: null,
          signatureText: null,
        }),
      })
    );
  });

  it("soft-resets active extra lines (PENDING/IN_PROGRESS) back to PENDING", async () => {
    mp.extraApprovalLine.findMany.mockResolvedValue([{ id: 7 }, { id: 8 }]);
    const req = makeReq();
    const res = makeRes();
    await recallMemo(req, res, vi.fn());
    expect(mp.extraApprovalLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING", closedAt: null }),
      })
    );
    expect(mp.extraApprover.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ statusId: null, actedAt: null }),
      })
    );
  });

  it("returns 500 when prisma throws", async () => {
    mp.memoStatusPivot.create.mockRejectedValue(new Error("db fail"));
    const req = makeReq();
    const res = makeRes();
    await recallMemo(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── recallMemoPreserve ────────────────────────────────────────────────────

describe("recallMemoPreserve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
  });

  it("upserts Recall(6) pivot without deleting anything", async () => {
    const req = makeReq();
    const res = makeRes();
    await recallMemoPreserve(req, res, vi.fn());
    expect(mp.memoStatusPivot.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          memoId_userId_statusId: expect.objectContaining({ statusId: 6 }),
        }),
      })
    );
    expect(mp.memoStatusPivot.deleteMany).not.toHaveBeenCalled();
  });

  it("creates memoHistory with RECALL actiontype", async () => {
    const req = makeReq();
    const res = makeRes();
    await recallMemoPreserve(req, res, vi.fn());
    expect(mp.memoHistory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          actiontype: "RECALL",
          statusId: 6,
        }),
      })
    );
  });

  it("responds 201 on success", async () => {
    const req = makeReq();
    const res = makeRes();
    await recallMemoPreserve(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("preserve") })
    );
  });

  it("does NOT reset approver actions (preserve keeps history)", async () => {
    const req = makeReq();
    const res = makeRes();
    await recallMemoPreserve(req, res, vi.fn());
    expect(mp.memoApproverAction.updateMany).not.toHaveBeenCalled();
  });

  it("returns 500 on DB error", async () => {
    mp.memoStatusPivot.upsert.mockRejectedValue(new Error("db fail"));
    const req = makeReq();
    const res = makeRes();
    await recallMemoPreserve(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── handleRecall ──────────────────────────────────────────────────────────

describe("handleRecall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
    mp.memoStatusPivot.findFirst.mockResolvedValue({ id: 1 });
  });

  it("resets only waiting/rejected actions (approved rows preserved)", async () => {
    await handleRecall({ memoId: 5, loaUserId: 10, latestVersion: 2 });
    expect(mp.memoApproverAction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { code: { in: ["waiting", "rejected"] } },
        }),
      })
    );
  });

  it("transitions pivot through Recall(6) then Draft(1)", async () => {
    await handleRecall({ memoId: 5, loaUserId: 10, latestVersion: 2 });
    // deleteMany called twice for the two bump() calls
    expect(mp.memoStatusPivot.deleteMany).toHaveBeenCalledTimes(2);
    // update or create called for each transition
    const updateCalls = mp.memoStatusPivot.update.mock.calls;
    const newStatusIds = updateCalls.map((c: any) => c[0].data.statusId);
    expect(newStatusIds).toContain(6);
    expect(newStatusIds).toContain(1);
  });

  it("creates pivot row when no existing row found", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue(null);
    await handleRecall({ memoId: 5, loaUserId: 10, latestVersion: 2 });
    expect(mp.memoStatusPivot.create).toHaveBeenCalled();
  });
});

// ── recallPreserve ────────────────────────────────────────────────────────

describe("recallPreserve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
    mp.memoApproverAction.findMany = vi.fn().mockResolvedValue([]);
  });

  it("returns 409 when status is Draft(1) — not recallable", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 1 });
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MEMO_STATUS_CHANGED" })
    );
  });

  it("returns 409 when status is Approved(3)", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 3 });
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("proceeds when status is Processing(5)", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("preserve") })
    );
  });

  it("proceeds when status is Rejected(4)", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 4 });
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) })
    );
  });

  it("deletes Processing/Approved/Rejected pivots before transitioning", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    expect(mp.memoStatusPivot.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ statusId: { in: [3, 4, 5] } }),
      })
    );
  });

  it("calls updateCurrentMemoStatus for Recall(6) then Draft(1)", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    const calls = mockUpdateStatus.mock.calls;
    const statusIds = calls.map((c: any) => c[2]);
    expect(statusIds).toContain(6);
    expect(statusIds).toContain(1);
  });

  it("writes exactly two history entries", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    expect(mp.memoHistory.create).toHaveBeenCalledTimes(2);
  });

  it("does NOT delete extra approval lines (preserve keeps them)", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    mp.extraApprovalLine.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    expect(mp.extraApprovalLine.deleteMany).not.toHaveBeenCalled();
  });

  it("fires notifyRecallUpdate async after response", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    await new Promise((r) => setImmediate(r));
    expect(mockNotify).toHaveBeenCalledWith(5, 10, expect.any(String));
  });
});

// ── recallClear ───────────────────────────────────────────────────────────

describe("recallClear", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
    // The handler reads req.user.id — memoId is via params
    mp.memoStatusPivot.findFirst
      .mockResolvedValueOnce({ statusId: 5 }) // guard check
      .mockResolvedValue({ statusId: 5, id: 1 }); // owner prev status inside tx
  });

  it("returns 400 when memoId is not finite", async () => {
    const req = makeReq({ params: { id: "abc" } });
    const res = makeRes();
    await recallClear(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 409 when memo is Approved(3)", async () => {
    // Override the guard-check mock to return Approved(3)
    mp.memoStatusPivot.findFirst.mockReset();
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 3 });
    const req = makeReq();
    const res = makeRes();
    await recallClear(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: "APPROVED" })
    );
  });

  it("proceeds when status is Processing(5)", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    const req = makeReq();
    const res = makeRes();
    await recallClear(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("version") })
    );
  });

  it("deletes all extra approval lines (clear behaviour)", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    mp.$transaction.mockImplementation(async (cb: any) => {
      const txMock = {
        ...mp,
        memoStatusPivot: { ...mp.memoStatusPivot, findFirst: vi.fn().mockResolvedValue({ statusId: 5 }) },
        extraApprovalLine: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([{ id: 11 }, { id: 12 }]),
          deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
        },
        extraApprover: {
          count: vi.fn().mockResolvedValue(0),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        comment: { updateMany: vi.fn().mockResolvedValue({}) },
        memoHistory: { create: vi.fn().mockResolvedValue({}) },
      };
      const result = await cb(txMock);
      expect(txMock.extraApprovalLine.deleteMany).toHaveBeenCalled();
      return result;
    });
    const req = makeReq();
    const res = makeRes();
    await recallClear(req, res, vi.fn());
  });

  it("writes RECALL history when no rejection exists", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    let historyData: any = null;
    mp.$transaction.mockImplementation(async (cb: any) => {
      const txMock = {
        ...mp,
        memoStatusPivot: {
          findFirst: vi.fn().mockResolvedValue({ statusId: 5 }),
          upsert: vi.fn().mockResolvedValue({}),
        },
        extraApprovalLine: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        extraApprover: {
          count: vi.fn().mockResolvedValue(0),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        comment: { updateMany: vi.fn().mockResolvedValue({}) },
        memoHistory: {
          create: vi.fn().mockImplementation((args: any) => {
            historyData = args.data;
            return Promise.resolve({});
          }),
        },
      };
      return cb(txMock);
    });
    const req = makeReq();
    const res = makeRes();
    await recallClear(req, res, vi.fn());
    expect(historyData?.actiontype).toBe("RECALL");
  });

  it("writes REVISE history when owner was previously rejected", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 4 }); // guard passes (4=Rejected)
    let historyData: any = null;
    mp.$transaction.mockImplementation(async (cb: any) => {
      const txMock = {
        ...mp,
        memoStatusPivot: {
          findFirst: vi.fn().mockResolvedValue({ statusId: 4 }), // owner was rejected
          upsert: vi.fn().mockResolvedValue({}),
        },
        extraApprovalLine: {
          count: vi.fn().mockResolvedValue(0),
          findMany: vi.fn().mockResolvedValue([]),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        extraApprover: {
          count: vi.fn().mockResolvedValue(0),
          deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
        comment: { updateMany: vi.fn().mockResolvedValue({}) },
        memoHistory: {
          create: vi.fn().mockImplementation((args: any) => {
            historyData = args.data;
            return Promise.resolve({});
          }),
        },
      };
      return cb(txMock);
    });
    const req = makeReq();
    const res = makeRes();
    await recallClear(req, res, vi.fn());
    expect(historyData?.actiontype).toBe("REVISE");
  });

  it("fires notifyRecallUpdate async after response", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    const req = makeReq();
    const res = makeRes();
    await recallClear(req, res, vi.fn());
    await new Promise((r) => setImmediate(r));
    expect(mockNotify).toHaveBeenCalled();
  });

  it("returns 500 on DB error inside transaction", async () => {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    mp.$transaction.mockRejectedValue(new Error("tx fail"));
    const req = makeReq();
    const res = makeRes();
    await recallClear(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ── recallClear vs recallPreserve: key behavioural difference ─────────────

describe("recallClear vs recallPreserve — behavioural difference", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    mp.memoApproverAction.findMany = vi.fn().mockResolvedValue([]);
    mp.$transaction.mockImplementation(async (cb: any) => {
      const txMock = {
        memoStatusPivot: { findFirst: vi.fn().mockResolvedValue({ statusId: 5 }), upsert: vi.fn().mockResolvedValue({}) },
        extraApprovalLine: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([{ id: 99 }]), deleteMany: vi.fn().mockResolvedValue({}) },
        extraApprover: { count: vi.fn().mockResolvedValue(0), deleteMany: vi.fn().mockResolvedValue({}) },
        comment: { updateMany: vi.fn().mockResolvedValue({}) },
        memoHistory: { create: vi.fn().mockResolvedValue({}) },
      };
      return cb(txMock);
    });
  });

  it("recallClear deletes extra approval lines", async () => {
    const deleteSpy = vi.fn().mockResolvedValue({});
    mp.$transaction.mockImplementation(async (cb: any) => {
      const txMock = {
        memoStatusPivot: { findFirst: vi.fn().mockResolvedValue({ statusId: 5 }), upsert: vi.fn().mockResolvedValue({}) },
        extraApprovalLine: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([{ id: 99 }]), deleteMany: deleteSpy },
        extraApprover: { count: vi.fn().mockResolvedValue(0), deleteMany: vi.fn().mockResolvedValue({}) },
        comment: { updateMany: vi.fn().mockResolvedValue({}) },
        memoHistory: { create: vi.fn().mockResolvedValue({}) },
      };
      return cb(txMock);
    });
    const req = makeReq();
    const res = makeRes();
    await recallClear(req, res, vi.fn());
    expect(deleteSpy).toHaveBeenCalled();
  });

  it("recallPreserve does NOT delete extra approval lines", async () => {
    const req = makeReq();
    const res = makeRes();
    await recallPreserve(req, res, vi.fn());
    expect(mp.extraApprovalLine.deleteMany).not.toHaveBeenCalled();
  });
});

// ── recallClearCore ───────────────────────────────────────────────────────

describe("recallClearCore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupCommonMocks();
  });

  it("resets approver actions in current version", async () => {
    await recallClearCore(5, 10, {});
    expect(mp.memoApproverAction.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actedAt: null }),
      })
    );
  });

  it("deleteProcessingHistory=true deletes pivot + history with statusId=5", async () => {
    await recallClearCore(5, 10, { deleteProcessingHistory: true });
    expect(mp.memoStatusPivot.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ statusId: 5 }) })
    );
    expect(mp.memoHistory.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ statusId: 5 }) })
    );
  });

  it("deleteProcessingHistory=false (default) does not delete history", async () => {
    await recallClearCore(5, 10, {});
    expect(mp.memoHistory.deleteMany).not.toHaveBeenCalled();
  });

  it("deleteExtraLines=true deletes extra approval lines", async () => {
    mp.extraApprovalLine.findMany.mockResolvedValue([{ id: 1 }]);
    await recallClearCore(5, 10, { deleteExtraLines: true });
    expect(mp.extraApprovalLine.deleteMany).toHaveBeenCalled();
    expect(mp.extraApprover.deleteMany).toHaveBeenCalled();
  });

  it("deleteExtraLines=false (default) soft-resets active extra lines", async () => {
    mp.extraApprovalLine.findMany.mockResolvedValue([{ id: 1 }]);
    await recallClearCore(5, 10, { deleteExtraLines: false });
    expect(mp.extraApprovalLine.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "PENDING" }),
      })
    );
    expect(mp.extraApprovalLine.deleteMany).not.toHaveBeenCalled();
  });

  it("returns currentVersion and removedExtraLines count", async () => {
    mp.extraApprovalLine.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const result = await recallClearCore(5, 10, { deleteExtraLines: true });
    expect(result).toEqual({ currentVersion: 2, removedExtraLines: 2 });
  });
});
