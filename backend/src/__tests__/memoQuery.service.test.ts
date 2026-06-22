/**
 * Unit tests for memoQuery.service.ts  (Wave 6)
 *
 * Strategy: vi.mock all external dependencies (prisma, memoAccess.service,
 * memoSearch.service, memoStatus.controller, token, filename, upload).
 * Fake req/res objects exercise each RequestHandler without DB or network.
 *
 * Coverage targets:
 *   getWaitingStatusId       — happy path + missing status code
 *   getAllMemos               — unauthorised, empty list, deleted filter, draft filter,
 *                              happy path (comment map, history map, currentApprover)
 *   getMemoById              — bad id, invalid token, not found, deleted, access denied,
 *                              happy path (approverRows mapped, PDF file enriched)
 *   getCurrentApprovers      — unauthorised, no visible memos, happy path (main + extra)
 *   getApprovers             — bad id, memo not found, happy path
 *   getMemoApprovalLine      — bad id, access denied, happy path (ANY requirement)
 *   getBusinessUnits         — happy path
 *   getApprovalLines         — happy path
 *   getAwaitingApproval      — missing status codes, no waiting → empty, happy path
 *   searchMemosHandler       — unauthorised, bad pageSize, happy path delegates service
 *   searchMemoStatsHandler   — unauthorised, happy path delegates service
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.mock calls are hoisted — no top-level variables allowed inside ────────

vi.mock("../../prisma/client", () => {
  const mockFn = () => vi.fn();
  return {
    prisma: {
      masterMemo: { findMany: mockFn(), findUnique: mockFn() },
      memoHistory: { findMany: mockFn() },
      memoApproverAction: {
        findMany: mockFn(),
        groupBy: mockFn(),
        aggregate: mockFn(),
      },
      comment: { findMany: mockFn() },
      approvalActionStatus: { findMany: mockFn(), findFirst: mockFn() },
      extraApprovalLine: { groupBy: mockFn() },
      extraApprover: { findMany: mockFn() },
      businessUnit: { findMany: mockFn() },
      lineOfApproval: { findMany: mockFn() },
      memoStatusPivot: { findMany: mockFn() },
    },
  };
});

vi.mock("../services/memoAccess.service", () => ({
  canViewMemo: vi.fn(),
}));

vi.mock("../services/memoSearch.service", () => ({
  searchMemos: vi.fn(),
  getCachedStatCounts: vi.fn(),
}));

vi.mock("../controllers/memoStatus.controller", () => ({
  toDisplayName: vi.fn((u: any) => (u ? `${u.name}` : ""),),
}));

vi.mock("../lib/token", () => ({
  verifyEmailToken: vi.fn(),
  makeEmailToken: vi.fn(),
}));

vi.mock("../lib/filename", () => ({
  decodeFilename: vi.fn((s: string) => s),
}));

vi.mock("../middlewares/upload", () => ({
  UPLOADS_DIR: "/tmp/uploads",
  toPublicUploadPath: vi.fn((p: string) => p),
}));

// fs mock — default no file on disk (getMemoById path)
vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => Buffer.from("")),
  },
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => Buffer.from("")),
}));

// pdf-lib mock — return a PDFDocument with 3 pages
vi.mock("pdf-lib", () => ({
  PDFDocument: {
    load: vi.fn(async () => ({ getPageCount: () => 3 })),
  },
}));

// ── Import module under test AFTER all vi.mock calls ────────────────────────

import {
  getWaitingStatusId,
  getAllMemos,
  getMemoById,
  getCurrentApprovers,
  getApprovers,
  getMemoApprovalLine,
  getBusinessUnits,
  getApprovalLines,
  getAwaitingApproval,
  searchMemosHandler,
  searchMemoStatsHandler,
} from "../services/memoQuery.service";

import { prisma } from "../../prisma/client";
import { canViewMemo } from "../services/memoAccess.service";
import { searchMemos, getCachedStatCounts } from "../services/memoSearch.service";
import { verifyEmailToken } from "../lib/token";
import fs from "fs";

const mp = prisma as any;
const mockCanView = canViewMemo as ReturnType<typeof vi.fn>;
const mockSearchMemos = searchMemos as ReturnType<typeof vi.fn>;
const mockGetCachedStatCounts = getCachedStatCounts as ReturnType<typeof vi.fn>;
const mockVerifyToken = verifyEmailToken as ReturnType<typeof vi.fn>;
const mockFs = fs as any;

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(overrides: Record<string, any> = {}): any {
  return {
    user: { id: 1 },
    params: {},
    query: {},
    body: {},
    protocol: "http",
    get: (h: string) => (h === "host" ? "localhost" : ""),
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = {};
  res.status = vi.fn(() => res);
  res.json = vi.fn(() => res);
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// getWaitingStatusId
// ─────────────────────────────────────────────────────────────────────────────

describe("getWaitingStatusId", () => {
  it("returns the waiting status id", async () => {
    mp.approvalActionStatus.findFirst.mockResolvedValue({ id: 7 });
    const id = await getWaitingStatusId();
    expect(id).toBe(7);
  });

  it("throws when waiting status is not found", async () => {
    mp.approvalActionStatus.findFirst.mockResolvedValue(null);
    await expect(getWaitingStatusId()).rejects.toThrow("waiting");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAllMemos
// ─────────────────────────────────────────────────────────────────────────────

describe("getAllMemos", () => {
  it("returns 401 when no user on request", async () => {
    const req = makeReq({ user: undefined });
    const res = makeRes();
    await getAllMemos(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Unauthorized" });
  });

  it("returns empty array when prisma returns no memos", async () => {
    mp.masterMemo.findMany.mockResolvedValue([]);
    const req = makeReq();
    const res = makeRes();
    await getAllMemos(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("filters out Deleted memos", async () => {
    const memo = {
      id: 1,
      userId: 1,
      subject: "test",
      memonumber: "M-001",
      memoType: { name: "X" },
      user: { id: 1, name: "Alice", lastname: null, nickname: null },
      department: null,
      businessUnit: null,
      statuses: [{ status: { name: "Deleted" }, createdAt: new Date() }],
      approverActions: [],
      ccRecipients: [],
      extraApprovalLines: [],
      commentTags: [],
      expiresAt: null,
      createdAt: new Date(),
    };
    mp.masterMemo.findMany.mockResolvedValue([memo]);
    const req = makeReq();
    const res = makeRes();
    await getAllMemos(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("filters out Draft memos owned by others", async () => {
    const memo = {
      id: 2,
      userId: 99,  // different owner
      subject: "draft memo",
      memonumber: "M-002",
      memoType: { name: "X" },
      user: { id: 99, name: "Bob", lastname: null, nickname: null },
      department: null,
      businessUnit: null,
      statuses: [{ status: { name: "Draft" }, createdAt: new Date() }],
      approverActions: [],
      ccRecipients: [],
      extraApprovalLines: [],
      commentTags: [],
      expiresAt: null,
      createdAt: new Date(),
    };
    mp.masterMemo.findMany.mockResolvedValue([memo]);
    const req = makeReq({ user: { id: 1 } }); // current user is 1, owner is 99
    const res = makeRes();
    await getAllMemos(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("returns memo list with currentApprover and lastHistory", async () => {
    const now = new Date("2025-01-01");
    const memo = {
      id: 3,
      userId: 1,
      subject: "visible memo",
      memonumber: "M-003",
      memoType: { name: "Memo" },
      user: { id: 1, name: "Alice", lastname: null, nickname: null, department: null },
      department: { id: 1, name: "IT" },
      businessUnit: { id: 1, name: "Corp" },
      statuses: [{ status: { name: "Processing" }, createdAt: now }],
      approverActions: [{ id: 10 }],
      ccRecipients: [],
      extraApprovalLines: [],
      commentTags: [],
      expiresAt: null,
      createdAt: now,
    };
    mp.masterMemo.findMany.mockResolvedValue([memo]);
    mp.memoHistory.findMany.mockResolvedValue([
      {
        id: 1, memoId: 3, action: "Submitted", actiontype: "SUBMIT",
        timestamp: now, status: { name: "Processing" },
        user: { id: 1, name: "Alice", lastname: null, nickname: null },
      },
    ]);
    // waiting approver: needs getWaitingStatusId via memoApproverAction.groupBy+findMany
    mp.approvalActionStatus.findFirst.mockResolvedValue({ id: 7 });
    mp.memoApproverAction.groupBy.mockResolvedValue([{ memoId: 3, _max: { version: 1 } }]);
    mp.memoApproverAction.findMany.mockResolvedValue([]);
    mp.comment.findMany.mockResolvedValue([]);

    const req = makeReq();
    const res = makeRes();
    await getAllMemos(req, res, vi.fn());

    expect(res.json).toHaveBeenCalledTimes(1);
    const result = res.json.mock.calls[0][0];
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].id).toBe(3);
    expect(result[0].status).toBe("Processing");
    expect(result[0].lastHistory?.action).toBe("Submitted");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getMemoById
// ─────────────────────────────────────────────────────────────────────────────

describe("getMemoById", () => {
  it("returns 400 for non-numeric id", async () => {
    const req = makeReq({ params: { id: "abc" } });
    const res = makeRes();
    await getMemoById(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 401 for invalid view token", async () => {
    mockVerifyToken.mockReturnValue(null);
    const req = makeReq({ params: { id: "5" }, query: { token: "bad" } });
    const res = makeRes();
    await getMemoById(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 404 when memo not found", async () => {
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mp.masterMemo.findUnique.mockResolvedValue(null);
    mockCanView.mockResolvedValue(true);
    const req = makeReq({ params: { id: "5" } });
    const res = makeRes();
    await getMemoById(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 403 when user has no access", async () => {
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mp.masterMemo.findUnique.mockResolvedValue({
      id: 5,
      statuses: [{ status: { name: "Processing" } }],
      mainFiles: [],
      attachedFiles: [],
      approverActions: [],
    });
    mockCanView.mockResolvedValue(false);
    const req = makeReq({ params: { id: "5" } });
    const res = makeRes();
    await getMemoById(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 404 for deleted memo", async () => {
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mp.masterMemo.findUnique.mockResolvedValue({
      id: 5,
      statuses: [{ status: { name: "Deleted" } }],
      mainFiles: [],
      attachedFiles: [],
      approverActions: [],
    });
    mockCanView.mockResolvedValue(true);
    const req = makeReq({ params: { id: "5" } });
    const res = makeRes();
    await getMemoById(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Memo not found (deleted)" });
  });

  it("returns memo with approverRows mapped correctly", async () => {
    const now = new Date("2025-02-01");
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mp.masterMemo.findUnique.mockResolvedValue({
      id: 5,
      statuses: [{ status: { name: "Processing" } }],
      mainFiles: [],
      attachedFiles: [],
      approverActions: [
        {
          status: { id: 1, code: "approved", label: "Approved" },
          actedAt: now,
          createdAt: now,
          updatedAt: now,
          loaUser: {
            level: 1,
            isSigReq: false,
            userId: 10,
            user: { id: 10, name: "Bob", lastname: null, profileImagePath: null },
          },
        },
      ],
    });
    mockCanView.mockResolvedValue(true);
    const req = makeReq({ params: { id: "5" } });
    const res = makeRes();
    await getMemoById(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledTimes(1);
    const body = res.json.mock.calls[0][0];
    expect(body.approverActions[0].statusCode).toBe("approved");
    expect(body.approverActions[0].since).toEqual(now); // approved → actedAt
  });

  it("marks mainFile as missing when not on disk", async () => {
    mockFs.existsSync.mockReturnValue(false);
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mp.masterMemo.findUnique.mockResolvedValue({
      id: 5,
      statuses: [{ status: { name: "Processing" } }],
      mainFiles: [{ id: 1, filePath: "/uploads/test.pdf", fileName: "test.pdf", orderNo: 1 }],
      attachedFiles: [],
      approverActions: [],
    });
    mockCanView.mockResolvedValue(true);
    const req = makeReq({ params: { id: "5" } });
    const res = makeRes();
    await getMemoById(req, res, vi.fn());
    const body = res.json.mock.calls[0][0];
    expect(body.mainFiles[0].missing).toBe(true);
    expect(body.mainFiles[0].pageCount).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getCurrentApprovers
// ─────────────────────────────────────────────────────────────────────────────

describe("getCurrentApprovers", () => {
  it("returns 401 when no user", async () => {
    const req = makeReq({ user: undefined });
    const res = makeRes();
    await getCurrentApprovers(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns empty array when no visible memos", async () => {
    mp.masterMemo.findMany.mockResolvedValue([]);
    const req = makeReq();
    const res = makeRes();
    await getCurrentApprovers(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("returns distinct approvers from main and extra approval lines", async () => {
    mp.masterMemo.findMany.mockResolvedValue([
      { id: 1, userId: 1, statuses: [{ status: { name: "Processing" } }] },
    ]);
    mp.memoApproverAction.groupBy.mockResolvedValue([
      { memoId: 1, _max: { version: 1 } },
    ]);
    mp.memoApproverAction.findMany.mockResolvedValue([
      {
        loaUser: {
          user: { id: 10, name: "Alice", lastname: null, nickname: null },
        },
      },
    ]);
    mp.extraApprovalLine.groupBy.mockResolvedValue([
      { memoId: 1, _max: { id: 5 } },
    ]);
    mp.extraApprover.findMany.mockResolvedValue([
      { user: { id: 20, name: "Bob", lastname: null, nickname: null } },
    ]);

    const req = makeReq();
    const res = makeRes();
    await getCurrentApprovers(req, res, vi.fn());
    const result = res.json.mock.calls[0][0];
    expect(result).toHaveLength(2);
    const ids = result.map((u: any) => u.id);
    expect(ids).toContain(10);
    expect(ids).toContain(20);
  });

  it("deduplicates users that appear in both main and extra lines", async () => {
    mp.masterMemo.findMany.mockResolvedValue([
      { id: 1, userId: 1, statuses: [{ status: { name: "Processing" } }] },
    ]);
    mp.memoApproverAction.groupBy.mockResolvedValue([
      { memoId: 1, _max: { version: 1 } },
    ]);
    mp.memoApproverAction.findMany.mockResolvedValue([
      { loaUser: { user: { id: 10, name: "Alice", lastname: null, nickname: null } } },
    ]);
    mp.extraApprovalLine.groupBy.mockResolvedValue([
      { memoId: 1, _max: { id: 5 } },
    ]);
    // Same user id=10 appears in extra line too
    mp.extraApprover.findMany.mockResolvedValue([
      { user: { id: 10, name: "Alice", lastname: null, nickname: null } },
    ]);

    const req = makeReq();
    const res = makeRes();
    await getCurrentApprovers(req, res, vi.fn());
    const result = res.json.mock.calls[0][0];
    expect(result).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getApprovers
// ─────────────────────────────────────────────────────────────────────────────

describe("getApprovers", () => {
  it("returns 400 for invalid memo id", async () => {
    const req = makeReq({ params: { id: "xyz" } });
    const res = makeRes();
    await getApprovers(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 404 when memo not found", async () => {
    mp.masterMemo.findUnique.mockResolvedValue(null);
    const req = makeReq({ params: { id: "1" } });
    const res = makeRes();
    await getApprovers(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns list of approver names", async () => {
    mp.masterMemo.findUnique.mockResolvedValue({ id: 1 });
    mp.memoApproverAction.findMany.mockResolvedValue([
      {
        loaUser: {
          user: { id: 10, name: "Alice", lastname: "Smith", nickname: null },
        },
      },
      {
        loaUser: { user: null },
      },
    ]);
    const req = makeReq({ params: { id: "1" } });
    const res = makeRes();
    await getApprovers(req, res, vi.fn());
    const result = res.json.mock.calls[0][0];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(10);
    expect(result[0].name).toBe("Alice");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getMemoApprovalLine
// ─────────────────────────────────────────────────────────────────────────────

describe("getMemoApprovalLine", () => {
  it("returns 400 for non-numeric memo id", async () => {
    const req = makeReq({ params: { id: "bad" } });
    const res = makeRes();
    await getMemoApprovalLine(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns 403 when user lacks access", async () => {
    mockCanView.mockResolvedValue(false);
    const req = makeReq({ params: { id: "1" } });
    const res = makeRes();
    await getMemoApprovalLine(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns levels array with not_required status for ANY level already satisfied", async () => {
    mockCanView.mockResolvedValue(true);
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });

    const now = new Date("2025-03-01");
    mp.memoApproverAction.findMany.mockResolvedValue([
      {
        loaUserId: 1,
        actedAt: now,
        createdAt: now,
        status: { code: "approved" },
        actualActorId: null,
        actualActor: null,
        loaUser: {
          level: 1,
          userId: 10,
          isSigReq: false,
          approvalRequirement: "ANY",
          user: {
            id: 10, name: "Alice", lastname: null, nickname: null,
            delegatedToUserId: null, delegationStartDate: null,
            delegationEndDate: null, delegatedToUser: null,
          },
        },
      },
      {
        loaUserId: 2,
        actedAt: null,
        createdAt: now,
        status: { code: "waiting" },
        actualActorId: null,
        actualActor: null,
        loaUser: {
          level: 1,
          userId: 20,
          isSigReq: false,
          approvalRequirement: "ANY",
          user: {
            id: 20, name: "Bob", lastname: null, nickname: null,
            delegatedToUserId: null, delegationStartDate: null,
            delegationEndDate: null, delegatedToUser: null,
          },
        },
      },
    ]);

    mp.masterMemo.findUnique.mockResolvedValue({ approvalLineId: 42 });

    const req = makeReq({ params: { id: "1" } });
    const res = makeRes();
    await getMemoApprovalLine(req, res, vi.fn());

    const body = res.json.mock.calls[0][0];
    expect(body.id).toBe(42);
    expect(body.levels).toHaveLength(1);
    const level1Users = body.levels[0].users;
    const waitingUser = level1Users.find((u: any) => u.id === 20);
    expect(waitingUser?.status).toBe("not_required");
    const approvedUser = level1Users.find((u: any) => u.id === 10);
    expect(approvedUser?.status).toBe("approved");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getBusinessUnits
// ─────────────────────────────────────────────────────────────────────────────

describe("getBusinessUnits", () => {
  it("returns business units list", async () => {
    const units = [{ id: 1, name: "HQ", departments: [] }];
    mp.businessUnit.findMany.mockResolvedValue(units);
    const req = makeReq();
    const res = makeRes();
    await getBusinessUnits(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith(units);
  });

  it("returns 500 on db error", async () => {
    mp.businessUnit.findMany.mockRejectedValue(new Error("db error"));
    const req = makeReq();
    const res = makeRes();
    await getBusinessUnits(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getApprovalLines
// ─────────────────────────────────────────────────────────────────────────────

describe("getApprovalLines", () => {
  it("returns approval lines list", async () => {
    const lines = [{ id: 1, approvalUsers: [], businessUnit: { id: 1, name: "HQ" } }];
    mp.lineOfApproval.findMany.mockResolvedValue(lines);
    const req = makeReq();
    const res = makeRes();
    await getApprovalLines(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith(lines);
  });

  it("returns 500 on db error", async () => {
    mp.lineOfApproval.findMany.mockRejectedValue(new Error("db error"));
    const req = makeReq();
    const res = makeRes();
    await getApprovalLines(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getAwaitingApproval
// ─────────────────────────────────────────────────────────────────────────────

describe("getAwaitingApproval", () => {
  it("returns 500 when status codes are missing", async () => {
    mp.approvalActionStatus.findMany.mockResolvedValue([]);
    const req = makeReq();
    const res = makeRes();
    await getAwaitingApproval(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Missing status codes" });
  });

  it("returns empty array when user has no waiting actions", async () => {
    mp.approvalActionStatus.findMany.mockResolvedValue([
      { id: 1, code: "waiting" },
      { id: 2, code: "approved" },
    ]);
    mp.memoApproverAction.findMany.mockResolvedValue([]);
    mp.memoStatusPivot.findMany.mockResolvedValue([]);
    const req = makeReq();
    const res = makeRes();
    await getAwaitingApproval(req, res, vi.fn());
    expect(res.json).toHaveBeenCalledWith([]);
  });

  it("returns memo when user is first approver (no prev levels)", async () => {
    mp.approvalActionStatus.findMany.mockResolvedValue([
      { id: 1, code: "waiting" },
      { id: 2, code: "approved" },
    ]);
    mp.memoApproverAction.findMany
      // myLatestActions (distinct memoId)
      .mockResolvedValueOnce([
        {
          memoId: 10,
          statusId: 1,  // waiting
          version: 1,
          loaUser: { level: 1 },
          memo: { subject: "Budget Approval", user: { name: "Carol" } },
        },
      ])
      // prevActions (level < 1 = none)
      .mockResolvedValueOnce([]);

    // memoStatusPivot check
    mp.memoStatusPivot.findMany.mockResolvedValue([
      { memoId: 10, status: { id: 5, name: "Processing" } },
    ]);

    const req = makeReq();
    const res = makeRes();
    await getAwaitingApproval(req, res, vi.fn());
    const result = res.json.mock.calls[0][0];
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(10);
    expect(result[0].subject).toBe("Budget Approval");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// searchMemosHandler
// ─────────────────────────────────────────────────────────────────────────────

describe("searchMemosHandler", () => {
  it("returns 401 when no user", async () => {
    const req = makeReq({ user: undefined });
    const res = makeRes();
    await searchMemosHandler(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 400 for invalid pageSize", async () => {
    const req = makeReq({ body: { pageSize: 200 } });
    const res = makeRes();
    await searchMemosHandler(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "pageSize must be 1-100 or 'all'" });
  });

  it("accepts pageSize='all'", async () => {
    mockSearchMemos.mockResolvedValue({ data: [], total: 0 });
    const req = makeReq({ body: { pageSize: "all" } });
    const res = makeRes();
    await searchMemosHandler(req, res, vi.fn());
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ data: [], total: 0 });
  });

  it("delegates to searchMemos service and returns result", async () => {
    const mockResult = { data: [{ id: 1 }], total: 1 };
    mockSearchMemos.mockResolvedValue(mockResult);
    const req = makeReq({ body: { pageSize: 10 } });
    const res = makeRes();
    await searchMemosHandler(req, res, vi.fn());
    expect(mockSearchMemos).toHaveBeenCalledWith(
      { pageSize: 10 },
      1,
      "http://localhost",
    );
    expect(res.json).toHaveBeenCalledWith(mockResult);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// searchMemoStatsHandler
// ─────────────────────────────────────────────────────────────────────────────

describe("searchMemoStatsHandler", () => {
  it("returns 401 when no user", async () => {
    const req = makeReq({ user: undefined });
    const res = makeRes();
    await searchMemoStatsHandler(req, res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("delegates to getCachedStatCounts and wraps in statCounts", async () => {
    const counts = { draft: 2, processing: 5 };
    mockGetCachedStatCounts.mockResolvedValue(counts);
    const req = makeReq({ body: {} });
    const res = makeRes();
    await searchMemoStatsHandler(req, res, vi.fn());
    expect(mockGetCachedStatCounts).toHaveBeenCalledWith(1, undefined, { forceRefresh: false });
    expect(res.json).toHaveBeenCalledWith({ statCounts: counts });
  });

  it("passes forceRefresh=true when body contains forceRefresh", async () => {
    mockGetCachedStatCounts.mockResolvedValue({});
    const req = makeReq({ body: { forceRefresh: true } });
    const res = makeRes();
    await searchMemoStatsHandler(req, res, vi.fn());
    expect(mockGetCachedStatCounts).toHaveBeenCalledWith(1, undefined, { forceRefresh: true });
  });
});
