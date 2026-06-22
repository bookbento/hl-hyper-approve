/**
 * Unit tests for extraApproval.service.ts
 *
 * Strategy: vi.mock all external dependencies (prisma, mailer, notificationPreferences,
 * memoStatus.controller) and exercise the RequestHandler logic by constructing fake
 * req/res objects. No real DB or network calls.
 *
 * Coverage targets (HIGH priority per blueprint):
 *   createExtraApprovalLine  — status≠5 → 409, ไม่มีสิทธิ์ → 403, pre-approved path, normal 201
 *   appendExtraApprovers     — status≠5 → 409, pending block, skip duplicate LoA user, normal
 *   actOnExtraApprovalLine   — COMPLETED/REJECTED line → 409, line gated recompute
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtraStatus, ActionType } from "@prisma/client";

// ── Mocks must be declared BEFORE any import of the module under test ──────

vi.mock("../../prisma/client", () => {
  // Using factory pattern — no top-level variables in factory (vi.mock hoisting rule)
  const mockFn = () => vi.fn();
  return {
    prisma: {
      status: { findFirst: mockFn() },
      masterMemo: { findUnique: mockFn() },
      memoStatusPivot: { findFirst: mockFn(), deleteMany: mockFn(), update: mockFn(), create: mockFn() },
      lineOfApprovalUserPivotForUse: { findFirst: mockFn() },
      memoCc: { findFirst: mockFn(), findMany: mockFn() },
      commentTag: { findFirst: mockFn(), findMany: mockFn() },
      extraApprover: { findFirst: mockFn(), findMany: mockFn(), createMany: mockFn(), update: mockFn() },
      extraApprovalLine: {
        findFirst: mockFn(),
        findUnique: mockFn(),
        create: mockFn(),
        update: mockFn(),
        delete: mockFn(),
        findMany: mockFn(),
      },
      comment: { createMany: mockFn(), findMany: mockFn(), updateMany: mockFn(), delete: mockFn() },
      memoApproverAction: { aggregate: mockFn(), findMany: mockFn() },
      user: { findUnique: mockFn(), findMany: mockFn() },
      notification: { createMany: mockFn() },
      memoHistory: { create: mockFn() },
    },
  };
});

vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("../lib/token", () => ({ makeEmailToken: vi.fn(), verifyEmailToken: vi.fn() }));
vi.mock("../lib/notificationPreferences", () => ({
  filterUsersForEmail: vi.fn().mockResolvedValue([]),
}));
vi.mock("../controllers/memoStatus.controller", () => ({
  evaluateAndUpdateMemoStatus: vi.fn(),
  getUserDisplayName: vi.fn().mockResolvedValue("Actor Name"),
  toDisplayName: vi.fn(),
  notifyStatusUpdate: vi.fn().mockResolvedValue(undefined),
}));

import {
  createExtraApprovalLine,
  appendExtraApprovers,
  actOnExtraApprovalLine,
} from "../services/extraApproval.service";
import { prisma } from "../../prisma/client";
import { filterUsersForEmail } from "../lib/notificationPreferences";
import { getUserDisplayName } from "../controllers/memoStatus.controller";

// ── Typed helpers ────────────────────────────────────────────────────────────

type MockPrisma = {
  status: { findFirst: ReturnType<typeof vi.fn> };
  masterMemo: { findUnique: ReturnType<typeof vi.fn> };
  memoStatusPivot: {
    findFirst: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
  };
  lineOfApprovalUserPivotForUse: { findFirst: ReturnType<typeof vi.fn> };
  memoCc: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  commentTag: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  extraApprover: {
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  extraApprovalLine: {
    findFirst: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  comment: {
    createMany: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  memoApproverAction: {
    aggregate: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  user: { findUnique: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  notification: { createMany: ReturnType<typeof vi.fn> };
  memoHistory: { create: ReturnType<typeof vi.fn> };
};

const mp = prisma as unknown as MockPrisma;

// ── Express req/res builder ──────────────────────────────────────────────────

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    body: {},
    user: { id: 1 },
    ...overrides,
  } as any;
}

function makeRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.sendStatus = vi.fn().mockReturnValue(res);
  return res;
}

// ── Status ID constants ──────────────────────────────────────────────────────
const APPROVED_STATUS_ID = 3;
const REJECTED_STATUS_ID = 4;

// ── Default setup helpers ────────────────────────────────────────────────────

function setupStatusMock() {
  mp.status.findFirst.mockImplementation(({ where }: { where: { name: string } }) => {
    if (where.name === "Approved") return Promise.resolve({ id: APPROVED_STATUS_ID });
    if (where.name === "Rejected") return Promise.resolve({ id: REJECTED_STATUS_ID });
    return Promise.resolve(null);
  });
}

function setupMemoInProcessing(memoId = 10, ownerId = 99) {
  mp.masterMemo.findUnique.mockResolvedValue({
    id: memoId,
    userId: ownerId,
    subject: "Test Memo",
    memonumber: "M001",
  });
  mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
}

beforeEach(() => {
  vi.clearAllMocks();
  setupStatusMock();
  // Default notification filter: return empty (no emails)
  (filterUsersForEmail as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // Default getUserDisplayName
  (getUserDisplayName as ReturnType<typeof vi.fn>).mockResolvedValue("Actor Name");
  // Default memoHistory.create
  mp.memoHistory.create.mockResolvedValue({});
  // Default notification.createMany
  mp.notification.createMany.mockResolvedValue({ count: 0 });
  // Default comment mocks
  mp.comment.createMany.mockResolvedValue({ count: 0 });
  mp.comment.findMany.mockResolvedValue([]);
  mp.comment.updateMany.mockResolvedValue({ count: 0 });
});

// ─────────────────────────────────────────────────────────────────────────────
// createExtraApprovalLine
// ─────────────────────────────────────────────────────────────────────────────

describe("createExtraApprovalLine", () => {
  it("returns 409 when memo status is not Processing (5)", async () => {
    // Arrange
    mp.masterMemo.findUnique.mockResolvedValue({
      id: 10,
      userId: 99,
      subject: "Test",
      memonumber: "M001",
    });
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 3 }); // APPROVED

    const req = makeReq({ params: { id: "10" }, body: { userIds: [2, 3] } });
    const res = makeRes();

    // Act
    await createExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MEMO_STATUS_CHANGED" }),
    );
  });

  it("returns 409 with statusCode=RECALLED when memo is recalled (6)", async () => {
    // Arrange
    mp.masterMemo.findUnique.mockResolvedValue({ id: 10, userId: 99, subject: "T", memonumber: "M" });
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 6 });

    const req = makeReq({ params: { id: "10" }, body: { userIds: [2] } });
    const res = makeRes();

    // Act
    await createExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: "RECALLED" }),
    );
  });

  it("returns 403 when actor is not owner/approver/CC/mentioned/extraApprover", async () => {
    // Arrange
    setupMemoInProcessing(10, 99); // owner=99, actor=1 (different)
    mp.lineOfApprovalUserPivotForUse.findFirst.mockResolvedValue(null);
    mp.memoCc.findFirst.mockResolvedValue(null);
    mp.commentTag.findFirst.mockResolvedValue(null);
    mp.extraApprover.findFirst.mockResolvedValue(null);

    const req = makeReq({ params: { id: "10" }, body: { userIds: [2, 3] } });
    const res = makeRes();

    // Act
    await createExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("ไม่มีสิทธิ์") }),
    );
  });

  it("returns 201 when actor is owner", async () => {
    // Arrange — actor=99 is also owner
    const req = makeReq({ params: { id: "10" }, body: { userIds: [2, 3] }, user: { id: 99 } });
    setupMemoInProcessing(10, 99);

    const createdLine = {
      id: 100,
      memoId: 10,
      status: ExtraStatus.PENDING,
      approvers: [],
      comment: [],
    };
    mp.extraApprovalLine.create.mockResolvedValue(createdLine);
    mp.user.findUnique.mockResolvedValue({ id: 99, name: "Owner", lastname: "User", nickname: null });
    mp.user.findMany.mockResolvedValue([]);

    const res = makeRes();

    // Act
    await createExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ id: 100 }));
  });

  it("handles preApprovedUsers by setting statusId to Approved on create", async () => {
    // Arrange
    const req = makeReq({
      params: { id: "10" },
      user: { id: 99 },
      body: {
        userIds: [2, 3],
        preApprovedUsers: [{ userId: 2, actedAt: "2025-01-01T00:00:00.000Z" }],
      },
    });
    setupMemoInProcessing(10, 99);

    const createdLine = { id: 100, memoId: 10, status: ExtraStatus.PENDING, approvers: [], comment: [] };
    mp.extraApprovalLine.create.mockResolvedValue(createdLine);
    mp.user.findUnique.mockResolvedValue({ id: 99, name: "O", lastname: "U", nickname: null });
    mp.user.findMany.mockResolvedValue([]);

    const res = makeRes();

    // Act
    await createExtraApprovalLine(req, res, vi.fn());

    // Assert — create called with approversData containing preApproved entry
    expect(mp.extraApprovalLine.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          approvers: {
            create: expect.arrayContaining([
              expect.objectContaining({ userId: 2, statusId: APPROVED_STATUS_ID }),
              expect.objectContaining({ userId: 3, statusId: null }),
            ]),
          },
        }),
      }),
    );
  });

  it("returns 400 when userIds is empty", async () => {
    // Arrange
    const req = makeReq({ params: { id: "10" }, body: { userIds: [] } });
    const res = makeRes();

    // Act
    await createExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 404 when memo not found", async () => {
    // Arrange
    mp.masterMemo.findUnique.mockResolvedValue(null);

    const req = makeReq({ params: { id: "999" }, body: { userIds: [2] } });
    const res = makeRes();

    // Act
    await createExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// appendExtraApprovers
// ─────────────────────────────────────────────────────────────────────────────

describe("appendExtraApprovers", () => {
  function setupParticipants(memoId = 10, ownerId = 99, actorId = 99) {
    // Reset findUnique to clear any leftover mockResolvedValueOnce chains
    mp.extraApprovalLine.findUnique.mockReset();
    // Actor IS the owner
    mp.masterMemo.findUnique.mockResolvedValue({
      id: memoId,
      userId: ownerId,
      subject: "Test Memo",
      memonumber: "M001",
    });
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    // Return actor as part of LoA so participants includes them
    mp.memoApproverAction.findMany.mockResolvedValue([
      { loaUser: { userId: actorId } },
    ]);
    mp.memoCc.findMany.mockResolvedValue([]);
    mp.extraApprover.findMany.mockResolvedValue([]);
    mp.extraApprovalLine.findMany.mockResolvedValue([]);
    mp.commentTag.findMany.mockResolvedValue([]);
  }

  it("returns 409 when memo status is not Processing (5)", async () => {
    // Arrange
    mp.masterMemo.findUnique.mockResolvedValue({ id: 10, userId: 99, subject: "T", memonumber: "M" });
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 3 }); // APPROVED

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { userIds: [5] },
    });
    const res = makeRes();

    // Act
    await appendExtraApprovers(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MEMO_STATUS_CHANGED" }),
    );
  });

  it("returns 403 when actor is not a participant", async () => {
    // Arrange — actor=7 is NOT in any participant group
    setupParticipants(10, 99, 99); // LoA has userId=99, actor will be 7
    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { userIds: [5] },
      user: { id: 7 }, // outsider
    });
    const res = makeRes();

    // Act
    await appendExtraApprovers(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 409 when line has pending approvals (blocking append)", async () => {
    // Arrange — actor=99 is the owner (participant)
    setupParticipants(10, 99, 99);
    mp.extraApprovalLine.findUnique.mockResolvedValue({
      id: 1,
      memoId: 10,
      status: ExtraStatus.PENDING,
      approvers: [{ userId: 5, statusId: null }], // pending approval!
    });

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { userIds: [6] },
      user: { id: 99 }, // actor is participant (owner)
    });
    const res = makeRes();

    // Act
    await appendExtraApprovers(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining("กรุณารอให้ผู้อนุมัติปัจจุบัน"),
      }),
    );
  });

  it("skips duplicate LoA users when appending", async () => {
    // Arrange — user 5 is a LoA approver, should be skipped
    setupParticipants(10, 99, 99);
    // approverUserIds includes userId=5 (LoA)
    mp.memoApproverAction.findMany.mockResolvedValue([
      { loaUser: { userId: 99 } }, // actor
      { loaUser: { userId: 5 } },  // LoA approver to be skipped
    ]);
    mp.extraApprovalLine.findUnique.mockResolvedValue({
      id: 1,
      memoId: 10,
      status: ExtraStatus.IN_PROGRESS,
      approvers: [], // no pending
    });

    // recomputeExtraLineStatus chain
    mp.extraApprover.findMany.mockResolvedValue([{ statusId: null }]);
    mp.extraApprovalLine.update.mockResolvedValue({});
    mp.comment.updateMany.mockResolvedValue({ count: 0 });
    mp.extraApprover.createMany.mockResolvedValue({ count: 0 });

    const updatedLine = { id: 1, memoId: 10, status: ExtraStatus.PENDING, approvers: [] };
    mp.extraApprovalLine.findUnique
      .mockResolvedValueOnce({
        id: 1, memoId: 10, status: ExtraStatus.IN_PROGRESS, approvers: [],
      })
      .mockResolvedValueOnce(updatedLine);

    mp.user.findMany.mockResolvedValue([]);
    mp.user.findUnique.mockResolvedValue(null);

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { userIds: [5] }, // user 5 is LoA — should be skipped
    });
    const res = makeRes();

    // Act
    await appendExtraApprovers(req, res, vi.fn());

    // Assert — createMany was NOT called because toAdd is empty
    expect(mp.extraApprover.createMany).not.toHaveBeenCalled();
    // Returns unchanged line
    expect(res.json).toHaveBeenCalled();
  });

  it("returns 409 when line is REJECTED", async () => {
    // Arrange — actor=99 is the owner (participant)
    setupParticipants(10, 99, 99);
    mp.extraApprovalLine.findUnique.mockResolvedValue({
      id: 1,
      memoId: 10,
      status: ExtraStatus.REJECTED,
      approvers: [],
    });

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { userIds: [6] },
      user: { id: 99 }, // actor is participant (owner)
    });
    const res = makeRes();

    // Act
    await appendExtraApprovers(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("Reject แล้ว") }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// actOnExtraApprovalLine
// ─────────────────────────────────────────────────────────────────────────────

describe("actOnExtraApprovalLine", () => {
  function setupActorInLine(memoId = 10, lineId = 1, actorId = 5) {
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    mp.extraApprover.findFirst.mockResolvedValue({
      id: 50,
      extraId: lineId,
      userId: actorId,
      statusId: null, // not yet acted
      extra: { memoId },
    });
    mp.extraApprovalLine.findUnique.mockResolvedValue({
      id: lineId,
      memoId,
      status: ExtraStatus.PENDING,
    });
    mp.extraApprover.update.mockResolvedValue({});
    mp.extraApprovalLine.update.mockResolvedValue({});
    mp.comment.updateMany.mockResolvedValue({ count: 0 });
    mp.user.findUnique.mockResolvedValue({
      id: actorId,
      name: "Approver",
      lastname: "User",
      nickname: null,
    });
    mp.memoHistory.create.mockResolvedValue({});
  }

  it("returns 409 when memo status is not Processing (5)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 3 }); // APPROVED

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { statusCode: "approved" },
    });
    const res = makeRes();

    // Act
    await actOnExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MEMO_STATUS_CHANGED" }),
    );
  });

  it("returns 400 when statusCode is invalid", async () => {
    // Arrange
    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { statusCode: "invalid" },
    });
    const res = makeRes();

    // Act
    await actOnExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 409 when line is COMPLETED (no longer active)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    mp.extraApprover.findFirst.mockResolvedValue({
      id: 50,
      extraId: 1,
      userId: 1,
      statusId: null,
      extra: { memoId: 10 },
    });
    mp.extraApprovalLine.findUnique.mockResolvedValue({
      id: 1,
      memoId: 10,
      status: ExtraStatus.COMPLETED, // already done
    });

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { statusCode: "approved" },
    });
    const res = makeRes();

    // Act
    await actOnExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("ไม่อยู่ในสถานะรอ") }),
    );
  });

  it("returns 409 when line is REJECTED (no longer active)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    mp.extraApprover.findFirst.mockResolvedValue({
      id: 50,
      extraId: 1,
      userId: 1,
      statusId: null,
      extra: { memoId: 10 },
    });
    mp.extraApprovalLine.findUnique.mockResolvedValue({
      id: 1,
      memoId: 10,
      status: ExtraStatus.REJECTED,
    });

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { statusCode: "rejected" },
    });
    const res = makeRes();

    // Act
    await actOnExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("returns 409 when actor already acted", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
    mp.extraApprover.findFirst.mockResolvedValue({
      id: 50,
      extraId: 1,
      userId: 1,
      statusId: APPROVED_STATUS_ID, // already acted!
      extra: { memoId: 10 },
    });
    mp.extraApprovalLine.findUnique.mockResolvedValue({
      id: 1,
      memoId: 10,
      status: ExtraStatus.IN_PROGRESS,
    });

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { statusCode: "approved" },
    });
    const res = makeRes();

    // Act
    await actOnExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("ดำเนินการไปแล้ว") }),
    );
  });

  it("sets line to REJECTED and closes when actor rejects", async () => {
    // Arrange
    setupActorInLine(10, 1, 5);
    mp.masterMemo.findUnique.mockResolvedValue({ id: 10, userId: 99 });
    mp.memoStatusPivot.deleteMany.mockResolvedValue({ count: 0 });
    mp.memoStatusPivot.update.mockResolvedValue({});
    mp.memoStatusPivot.findFirst
      .mockResolvedValueOnce({ statusId: 5 }) // first call: memo status check
      .mockResolvedValueOnce({ id: 200 }); // second call: ownerPivot

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { statusCode: "rejected" },
      user: { id: 5 },
    });
    const res = makeRes();

    // Act
    await actOnExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(mp.extraApprovalLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ status: ExtraStatus.REJECTED }),
      }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, closed: "rejected" }),
    );
  });

  it("marks line COMPLETED when last approver approves", async () => {
    // Arrange
    setupActorInLine(10, 1, 5);
    // After approval, all approvers have statusId set
    mp.extraApprover.findMany.mockResolvedValue([
      { statusId: APPROVED_STATUS_ID }, // the one who just approved
    ]);

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { statusCode: "approved" },
      user: { id: 5 },
    });
    const res = makeRes();

    // Act
    await actOnExtraApprovalLine(req, res, vi.fn());

    // Assert
    expect(mp.extraApprovalLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ExtraStatus.COMPLETED }),
      }),
    );
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, closed: "approved" }),
    );
  });

  it("returns ok: true, closed: null when approval is partial", async () => {
    // Arrange — 2 approvers, only 1 approved
    setupActorInLine(10, 1, 5);
    mp.extraApprover.findMany.mockResolvedValue([
      { statusId: APPROVED_STATUS_ID },
      { statusId: null }, // still waiting
    ]);

    const req = makeReq({
      params: { memoId: "10", lineId: "1" },
      body: { statusCode: "approved" },
      user: { id: 5 },
    });
    const res = makeRes();

    // Act
    await actOnExtraApprovalLine(req, res, vi.fn());

    // Assert — partial approval, line stays active
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ ok: true, closed: null }),
    );
  });
});
