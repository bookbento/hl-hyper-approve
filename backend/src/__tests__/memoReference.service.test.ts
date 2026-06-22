/**
 * Unit tests for memoReference.service.ts
 *
 * Strategy: vi.mock all external I/O (prisma, memoAccess.service) — no real DB calls.
 *
 * Coverage scenarios:
 *   searchMemosForReference — filters Draft/Cancelled/Deleted from results,
 *                             query length < 2 skips OR condition,
 *                             respects limit cap (max 50),
 *                             returns 500 on DB error
 *
 *   getMemoReferences       — returns 400 for invalid memoId,
 *                             skips Deleted references,
 *                             D-6: access check — user without permission is excluded,
 *                             D-6: user WITH permission sees the reference,
 *                             returns 500 on DB error
 *
 *   updateMemoReferences    — returns 400 for invalid memoId,
 *                             returns 400 when referenceIds is not array,
 *                             returns 404 when user does not own memo,
 *                             skips self-reference,
 *                             calls $transaction and returns count,
 *                             returns 500 on DB error
 *
 *   getReferenceMemoContent — returns 400 for invalid IDs,
 *                             returns 404 when reference relation absent,
 *                             returns 404 when referenceMemo not found,
 *                             D-6: returns 403 when canViewMemo = false,
 *                             returns 404 when memo is Deleted,
 *                             returns full content when access granted,
 *                             returns 500 on DB error
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks BEFORE imports (vi.mock hoisting) ────────────────────────────────────

vi.mock("../../prisma/client", () => {
  const mockFn = () => vi.fn();
  return {
    prisma: {
      masterMemo: {
        findMany: mockFn(),
        findFirst: mockFn(),
      },
      memoReference: {
        findMany: mockFn(),
        findFirst: mockFn(),
        deleteMany: mockFn(),
        createMany: mockFn(),
      },
      $transaction: mockFn(),
    },
  };
});

vi.mock("../services/memoAccess.service", () => ({
  canViewMemo: vi.fn(),
}));

process.env.FRONTEND_URL = "https://app.example.com";

import {
  searchMemosForReference,
  getMemoReferences,
  updateMemoReferences,
  getReferenceMemoContent,
} from "../services/memoReference.service";
import { prisma } from "../../prisma/client";
import { canViewMemo } from "../services/memoAccess.service";

// ── Type helpers ──────────────────────────────────────────────────────────────

type MP = typeof prisma & {
  masterMemo: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
  };
  memoReference: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
    createMany: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

const mp = prisma as unknown as MP;
const mockCanViewMemo = canViewMemo as ReturnType<typeof vi.fn>;

// ── Request/Response factory helpers ─────────────────────────────────────────

function makeReq(overrides: Record<string, any> = {}) {
  return {
    params: {},
    body: {},
    query: {},
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

// ── Shared stubs ──────────────────────────────────────────────────────────────

const fakeMemo = (overrides: Record<string, any> = {}) => ({
  id: 10,
  subject: "Test Memo",
  createdAt: new Date("2024-01-01"),
  memoNumberRecord: { memonumber: "M-001" },
  statuses: [{ status: { name: "Processing" } }],
  user: { id: 1, name: "Alice", lastname: "Smith" },
  ...overrides,
});

const fakeReference = (statusName = "Processing") => ({
  referenceMemo: {
    id: 20,
    subject: "Ref Memo",
    createdAt: new Date("2024-02-01"),
    userId: 2,
    memoNumberRecord: { memonumber: "M-002" },
    statuses: [{ status: { name: statusName } }],
    user: { id: 2, name: "Bob", lastname: "Jones", profileImagePath: null },
    mainFiles: [],
    attachedFiles: [],
    comments: [],
  },
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════════
// searchMemosForReference
// ═══════════════════════════════════════════════════════════════════════════════

describe("searchMemosForReference", () => {
  it("filters out Draft memos from results", async () => {
    // Arrange
    const draftMemo = fakeMemo({ statuses: [{ status: { name: "Draft" } }] });
    mp.masterMemo.findMany.mockResolvedValue([draftMemo]);
    const req = makeReq({ query: { q: "" } });
    const res = makeRes();

    // Act
    await searchMemosForReference(req, res, vi.fn());

    // Assert — Draft is filtered out
    const [payload] = res.json.mock.calls[0];
    expect(payload).toHaveLength(0);
  });

  it("filters out Cancelled memos from results", async () => {
    // Arrange
    const cancelledMemo = fakeMemo({ statuses: [{ status: { name: "Cancelled" } }] });
    mp.masterMemo.findMany.mockResolvedValue([cancelledMemo]);
    const req = makeReq({ query: {} });
    const res = makeRes();

    // Act
    await searchMemosForReference(req, res, vi.fn());

    // Assert
    const [payload] = res.json.mock.calls[0];
    expect(payload).toHaveLength(0);
  });

  it("filters out Deleted memos from results", async () => {
    // Arrange
    const deletedMemo = fakeMemo({ statuses: [{ status: { name: "Deleted" } }] });
    mp.masterMemo.findMany.mockResolvedValue([deletedMemo]);
    const req = makeReq({ query: {} });
    const res = makeRes();

    // Act
    await searchMemosForReference(req, res, vi.fn());

    // Assert
    const [payload] = res.json.mock.calls[0];
    expect(payload).toHaveLength(0);
  });

  it("includes Processing memos and returns correct shape", async () => {
    // Arrange
    const processingMemo = fakeMemo();
    mp.masterMemo.findMany.mockResolvedValue([processingMemo]);
    const req = makeReq({ query: {} });
    const res = makeRes();

    // Act
    await searchMemosForReference(req, res, vi.fn());

    // Assert
    const [payload] = res.json.mock.calls[0];
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      id: 10,
      subject: "Test Memo",
      memoNumber: "M-001",
      status: "Processing",
    });
  });

  it("adds OR search condition when query >= 2 chars", async () => {
    // Arrange
    mp.masterMemo.findMany.mockResolvedValue([]);
    const req = makeReq({ query: { q: "ab" } });
    const res = makeRes();

    // Act
    await searchMemosForReference(req, res, vi.fn());

    // Assert — findMany called with OR condition
    const [callArgs] = mp.masterMemo.findMany.mock.calls[0];
    expect(callArgs.where.OR).toBeDefined();
    expect(callArgs.where.OR[0]).toMatchObject({ subject: { contains: "ab" } });
  });

  it("does NOT add OR condition when query < 2 chars", async () => {
    // Arrange
    mp.masterMemo.findMany.mockResolvedValue([]);
    const req = makeReq({ query: { q: "a" } });
    const res = makeRes();

    // Act
    await searchMemosForReference(req, res, vi.fn());

    // Assert — no OR condition
    const [callArgs] = mp.masterMemo.findMany.mock.calls[0];
    expect(callArgs.where.OR).toBeUndefined();
  });

  it("caps limit at 50 even if larger value is requested", async () => {
    // Arrange
    mp.masterMemo.findMany.mockResolvedValue([]);
    const req = makeReq({ query: { limit: "100" } });
    const res = makeRes();

    // Act
    await searchMemosForReference(req, res, vi.fn());

    // Assert — take should be 50
    const [callArgs] = mp.masterMemo.findMany.mock.calls[0];
    expect(callArgs.take).toBe(50);
  });

  it("returns 500 on DB error", async () => {
    // Arrange
    mp.masterMemo.findMany.mockRejectedValue(new Error("db error"));
    const req = makeReq({ query: {} });
    const res = makeRes();

    // Act
    await searchMemosForReference(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Search failed" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getMemoReferences
// ═══════════════════════════════════════════════════════════════════════════════

describe("getMemoReferences", () => {
  it("returns 400 when memoId is not a number", async () => {
    // Arrange
    const req = makeReq({ params: { id: "abc" } });
    const res = makeRes();

    // Act
    await getMemoReferences(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid memo ID" });
  });

  it("skips Deleted references regardless of canViewMemo", async () => {
    // Arrange
    mp.memoReference.findMany.mockResolvedValue([fakeReference("Deleted")]);
    const req = makeReq({ params: { id: "5" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getMemoReferences(req, res, vi.fn());

    // Assert — canViewMemo should NOT be called for deleted memo
    expect(mockCanViewMemo).not.toHaveBeenCalled();
    const [payload] = res.json.mock.calls[0];
    expect(payload).toHaveLength(0);
  });

  it("D-6: excludes reference when canViewMemo returns false", async () => {
    // Arrange — reference exists but user has no access
    mp.memoReference.findMany.mockResolvedValue([fakeReference("Processing")]);
    mockCanViewMemo.mockResolvedValue(false);
    const req = makeReq({ params: { id: "5" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getMemoReferences(req, res, vi.fn());

    // Assert — access denied: reference must NOT appear in result
    expect(mockCanViewMemo).toHaveBeenCalledWith(1, 20);
    const [payload] = res.json.mock.calls[0];
    expect(payload).toHaveLength(0);
  });

  it("D-6: includes reference when canViewMemo returns true", async () => {
    // Arrange — user has access
    mp.memoReference.findMany.mockResolvedValue([fakeReference("Processing")]);
    mockCanViewMemo.mockResolvedValue(true);
    const req = makeReq({ params: { id: "5" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getMemoReferences(req, res, vi.fn());

    // Assert — reference appears with hasAccess: true
    expect(mockCanViewMemo).toHaveBeenCalledWith(1, 20);
    const [payload] = res.json.mock.calls[0];
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ id: 20, hasAccess: true });
  });

  it("returns 500 on DB error", async () => {
    // Arrange
    mp.memoReference.findMany.mockRejectedValue(new Error("db error"));
    const req = makeReq({ params: { id: "5" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getMemoReferences(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to get references" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// updateMemoReferences
// ═══════════════════════════════════════════════════════════════════════════════

describe("updateMemoReferences", () => {
  it("returns 400 when memoId is not a number", async () => {
    // Arrange
    const req = makeReq({ params: { id: "abc" }, body: { referenceIds: [] } });
    const res = makeRes();

    // Act
    await updateMemoReferences(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid memo ID" });
  });

  it("returns 400 when referenceIds is not an array", async () => {
    // Arrange
    const req = makeReq({ params: { id: "5" }, body: { referenceIds: "not-array" } });
    const res = makeRes();

    // Act
    await updateMemoReferences(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "referenceIds must be an array" });
  });

  it("returns 404 when user does not own the memo", async () => {
    // Arrange
    mp.masterMemo.findFirst.mockResolvedValue(null);
    const req = makeReq({ params: { id: "5" }, body: { referenceIds: [] }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await updateMemoReferences(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Memo not found or access denied" });
  });

  it("skips self-reference (refMemo.id === memoId)", async () => {
    // Arrange — main memo found; reference lookup returns same id
    mp.masterMemo.findFirst
      .mockResolvedValueOnce({ id: 5 }) // main memo
      .mockResolvedValueOnce({ id: 5 }); // refMemo same id → should be skipped

    mp.$transaction.mockImplementation(async (fn: any) => fn({
      memoReference: { deleteMany: vi.fn(), createMany: vi.fn() },
    }));

    const req = makeReq({ params: { id: "5" }, body: { referenceIds: [5] }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await updateMemoReferences(req, res, vi.fn());

    // Assert — success but referencesCount = 0 (self-reference skipped)
    expect(res.json).toHaveBeenCalledWith({ success: true, referencesCount: 0 });
  });

  it("calls $transaction and returns correct referencesCount", async () => {
    // Arrange
    mp.masterMemo.findFirst
      .mockResolvedValueOnce({ id: 5 }) // main memo
      .mockResolvedValueOnce({ id: 20 }); // valid reference

    const mockDeleteMany = vi.fn().mockResolvedValue({});
    const mockCreateMany = vi.fn().mockResolvedValue({});
    mp.$transaction.mockImplementation(async (fn: any) =>
      fn({ memoReference: { deleteMany: mockDeleteMany, createMany: mockCreateMany } })
    );

    const req = makeReq({ params: { id: "5" }, body: { referenceIds: [20] }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await updateMemoReferences(req, res, vi.fn());

    // Assert
    expect(mp.$transaction).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ success: true, referencesCount: 1 });
  });

  it("returns 500 on DB error", async () => {
    // Arrange
    mp.masterMemo.findFirst.mockRejectedValue(new Error("db error"));
    const req = makeReq({ params: { id: "5" }, body: { referenceIds: [] }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await updateMemoReferences(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to update references" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getReferenceMemoContent
// ═══════════════════════════════════════════════════════════════════════════════

describe("getReferenceMemoContent", () => {
  it("returns 400 when memoId is not a number", async () => {
    // Arrange
    const req = makeReq({ params: { id: "abc", referenceId: "20" } });
    const res = makeRes();

    // Act
    await getReferenceMemoContent(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid memo or reference ID" });
  });

  it("returns 400 when referenceId is not a number", async () => {
    // Arrange
    const req = makeReq({ params: { id: "5", referenceId: "xyz" } });
    const res = makeRes();

    // Act
    await getReferenceMemoContent(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid memo or reference ID" });
  });

  it("returns 404 when reference relationship does not exist", async () => {
    // Arrange
    mp.memoReference.findFirst.mockResolvedValue(null);
    const req = makeReq({ params: { id: "5", referenceId: "20" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getReferenceMemoContent(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Reference not found" });
  });

  it("returns 404 when referenceMemo record is missing", async () => {
    // Arrange
    mp.memoReference.findFirst.mockResolvedValue({ id: 99 });
    mp.masterMemo.findFirst.mockResolvedValue(null);
    const req = makeReq({ params: { id: "5", referenceId: "20" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getReferenceMemoContent(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Reference memo not found" });
  });

  it("D-6: returns 403 when canViewMemo returns false", async () => {
    // Arrange — reference exists but user has no permission
    mp.memoReference.findFirst.mockResolvedValue({ id: 99 });
    mp.masterMemo.findFirst.mockResolvedValue({
      id: 20,
      subject: "Secret Memo",
      createdAt: new Date(),
      userId: 2,
      memoNumberRecord: { memonumber: "M-002" },
      statuses: [{ status: { name: "Processing" } }],
      user: { id: 2, name: "Bob", lastname: "Jones", profileImagePath: null },
      mainFiles: [],
      attachedFiles: [],
      comments: [],
    });
    mockCanViewMemo.mockResolvedValue(false);
    const req = makeReq({ params: { id: "5", referenceId: "20" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getReferenceMemoContent(req, res, vi.fn());

    // Assert — access check enforced; must return 403
    expect(mockCanViewMemo).toHaveBeenCalledWith(1, 20);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Access denied" });
  });

  it("returns 404 when reference memo status is Deleted", async () => {
    // Arrange
    mp.memoReference.findFirst.mockResolvedValue({ id: 99 });
    mp.masterMemo.findFirst.mockResolvedValue({
      id: 20,
      subject: "Deleted Memo",
      createdAt: new Date(),
      userId: 2,
      memoNumberRecord: { memonumber: "M-002" },
      statuses: [{ status: { name: "Deleted" } }],
      user: { id: 2, name: "Bob", lastname: "Jones", profileImagePath: null },
      mainFiles: [],
      attachedFiles: [],
      comments: [],
    });
    mockCanViewMemo.mockResolvedValue(true);
    const req = makeReq({ params: { id: "5", referenceId: "20" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getReferenceMemoContent(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Reference not found (deleted)" });
  });

  it("returns full content when user has access", async () => {
    // Arrange
    mp.memoReference.findFirst.mockResolvedValue({ id: 99 });
    const fullMemo = {
      id: 20,
      subject: "Ref Memo",
      createdAt: new Date("2024-02-01"),
      userId: 2,
      memoNumberRecord: { memonumber: "M-002" },
      statuses: [{ status: { name: "Processing" } }],
      user: { id: 2, name: "Bob", lastname: "Jones", profileImagePath: "bob.jpg" },
      mainFiles: [{ id: 1, fileName: "doc.pdf", filePath: "/path", size: 1024 }],
      attachedFiles: [],
      comments: [],
    };
    mp.masterMemo.findFirst.mockResolvedValue(fullMemo);
    mockCanViewMemo.mockResolvedValue(true);
    const req = makeReq({ params: { id: "5", referenceId: "20" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getReferenceMemoContent(req, res, vi.fn());

    // Assert
    expect(res.json).toHaveBeenCalledTimes(1);
    const [payload] = res.json.mock.calls[0];
    expect(payload).toMatchObject({
      id: 20,
      subject: "Ref Memo",
      memoNumber: "M-002",
      status: "Processing",
      hasAccess: true,
      mainFiles: [{ id: 1, fileName: "doc.pdf" }],
    });
    expect(payload.createdBy.profileImagePath).toBe("bob.jpg");
  });

  it("returns 500 on DB error", async () => {
    // Arrange
    mp.memoReference.findFirst.mockRejectedValue(new Error("db error"));
    const req = makeReq({ params: { id: "5", referenceId: "20" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await getReferenceMemoContent(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to get reference content" });
  });
});
