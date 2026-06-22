/**
 * memoLifecycle.service.test.ts (Wave 9)
 *
 * Unit tests for parseExpiresAt, getStatusIdByName, absFromDbPath (pure/near-pure helpers)
 * and critical paths of createMemo, updateMemo, deleteMemo via mock prisma.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock prisma ──────────────────────────────────────────────────────────────
vi.mock("../../prisma/client", () => ({
  prisma: {
    status: {
      findFirst: vi.fn(),
      aggregate: vi.fn(),
      create: vi.fn(),
    },
    masterMemo: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      delete: vi.fn(),
    },
    memoType: { findUnique: vi.fn() },
    mainFile: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    attachedFile: { create: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
    signaturePosition: { create: vi.fn(), deleteMany: vi.fn() },
    datePosition: { create: vi.fn(), deleteMany: vi.fn() },
    notePosition: { create: vi.fn(), deleteMany: vi.fn() },
    memoNumberPosition: { create: vi.fn(), deleteMany: vi.fn() },
    memoCc: { createMany: vi.fn() },
    lineOfApprovalUserPivotForUse: {
      create: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      deleteMany: vi.fn(),
    },
    lineOfApprovalUserPivot: { findMany: vi.fn() },
    memoApproverAction: {
      create: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      aggregate: vi.fn(),
      deleteMany: vi.fn(),
      updateMany: vi.fn(),
    },
    memoStatusPivot: {
      findFirst: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    memoHistory: { create: vi.fn(), deleteMany: vi.fn() },
    comment: { findMany: vi.fn() },
    commentAttachment: { findMany: vi.fn(), deleteMany: vi.fn() },
    approvalActionStatus: { findUnique: vi.fn() },
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    notification: { deleteMany: vi.fn() },
    ccGroupMember: { findMany: vi.fn() },
    extraApprovalLine: { findMany: vi.fn(), updateMany: vi.fn() },
    extraApprover: { updateMany: vi.fn() },
    $transaction: vi.fn(),
    $executeRaw: vi.fn(),
  },
}));

vi.mock("../lib/memoNumber", () => ({
  reserveMemoNumber: vi.fn(),
}));

vi.mock("../middlewares/upload", () => ({
  toPublicUploadPath: vi.fn((p: string) => p),
  UPLOADS_DIR: "/uploads",
}));

vi.mock("../lib/filename", () => ({
  decodeFilename: vi.fn((name: string) => name),
}));

vi.mock("../services/memoQuery.service", () => ({
  getWaitingStatusId: vi.fn(),
}));

// ── Import after mocks ────────────────────────────────────────────────────────
import {
  parseExpiresAt,
  getStatusIdByName,
  absFromDbPath,
  createMemo,
  updateMemo,
  deleteMemo,
} from "../services/memoLifecycle.service";
import { prisma } from "../../prisma/client";
import { reserveMemoNumber } from "../lib/memoNumber";
import { getWaitingStatusId } from "../services/memoQuery.service";

// ── Helper to build a fake req/res ────────────────────────────────────────────
function makeReqRes(overrides: Partial<Record<string, any>> = {}) {
  const req: any = {
    params: { id: "1" },
    body: {},
    files: {},
    headers: {},
    user: { id: 42 },
    ...overrides,
  };
  const res: any = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    sendStatus: vi.fn().mockReturnThis(),
  };
  const next = vi.fn();
  return { req, res, next };
}

// ─────────────────────────────────────────────────────────────────────────────
// parseExpiresAt
// ─────────────────────────────────────────────────────────────────────────────
describe("parseExpiresAt", () => {
  it("returns undefined when raw is undefined", () => {
    expect(parseExpiresAt(undefined)).toBeUndefined();
  });

  it("returns null for empty string", () => {
    expect(parseExpiresAt("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseExpiresAt("   ")).toBeNull();
  });

  it("parses YYYY-MM-DD as end-of-day UTC", () => {
    const result = parseExpiresAt("2025-12-31");
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2025-12-31T23:59:59.999Z");
  });

  it("parses an ISO datetime string", () => {
    const result = parseExpiresAt("2025-06-15T12:00:00.000Z");
    expect(result).toBeInstanceOf(Date);
    expect(result!.toISOString()).toBe("2025-06-15T12:00:00.000Z");
  });

  it("returns null for an invalid date string", () => {
    expect(parseExpiresAt("not-a-date")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getStatusIdByName
// ─────────────────────────────────────────────────────────────────────────────
describe("getStatusIdByName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the status id when found", async () => {
    vi.mocked(prisma.status.findFirst).mockResolvedValueOnce({ id: 5 } as any);
    await expect(getStatusIdByName("Processing")).resolves.toBe(5);
  });

  it("throws when status is not found", async () => {
    vi.mocked(prisma.status.findFirst).mockResolvedValueOnce(null);
    await expect(getStatusIdByName("NonExistent")).rejects.toThrow(
      'ต้องมี Status.name = "NonExistent" ในตาราง Status',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// absFromDbPath
// ─────────────────────────────────────────────────────────────────────────────
describe("absFromDbPath", () => {
  it("returns empty string for empty input", () => {
    expect(absFromDbPath("")).toBe("");
  });

  it("returns absolute path as-is", () => {
    const abs = "/absolute/path/to/file.pdf";
    expect(absFromDbPath(abs)).toBe(abs);
  });

  it("strips 'uploads/' prefix and joins with UPLOADS_DIR", () => {
    const result = absFromDbPath("uploads/attached/file.pdf");
    expect(result).toContain("attached/file.pdf");
  });

  it("handles URL with pathname extraction", () => {
    const result = absFromDbPath(
      "http://example.com/uploads/attached/doc.pdf",
    );
    expect(result).toContain("attached/doc.pdf");
  });

  it("strips leading slashes", () => {
    const result = absFromDbPath("/attached/file.pdf");
    expect(result).toContain("attached/file.pdf");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createMemo — critical paths
// ─────────────────────────────────────────────────────────────────────────────
describe("createMemo — critical paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when MemoType not found", async () => {
    const { req, res, next } = makeReqRes({
      body: { memotypeId: "999", userId: "1", businessUnitId: "1", statusId: "1" },
      files: { files: [{ path: "/tmp/a.pdf", originalname: "a.pdf", size: 100, mimetype: "application/pdf" }] },
    });

    vi.mocked(prisma.memoType.findUnique).mockResolvedValueOnce(null);

    await createMemo(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "MemoType not found" });
  });

  it("returns 400 when MemoType has no BusinessUnit", async () => {
    const { req, res, next } = makeReqRes({
      body: { memotypeId: "1", userId: "1", businessUnitId: "1", statusId: "1" },
      files: { files: [{ path: "/tmp/a.pdf", originalname: "a.pdf", size: 100, mimetype: "application/pdf" }] },
    });

    vi.mocked(prisma.memoType.findUnique).mockResolvedValueOnce({
      id: 1,
      abbreviation: "T",
      businessUnitId: null,
      departmentId: null,
      businessUnit: null,
      department: null,
    } as any);

    await createMemo(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "MemoType must have a Business Unit",
    });
  });

  it("returns 400 when no PDF files uploaded", async () => {
    const { req, res, next } = makeReqRes({
      body: { memotypeId: "1", userId: "1", businessUnitId: "1", statusId: "1" },
      files: { files: [] }, // no files
    });

    vi.mocked(prisma.memoType.findUnique).mockResolvedValueOnce({
      id: 1,
      abbreviation: "T",
      businessUnitId: 1,
      departmentId: null,
      businessUnit: { abbreviation: "BU" },
      department: null,
    } as any);

    vi.mocked(reserveMemoNumber).mockResolvedValueOnce({
      id: 1,
      memonumber: "BU-001",
    } as any);

    vi.mocked(prisma.masterMemo.create).mockResolvedValueOnce({ id: 100 } as any);

    await createMemo(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "No PDF files uploaded" });
  });

  it("creates memo and returns 201 on success (no override, no line)", async () => {
    const { req, res, next } = makeReqRes({
      body: {
        memotypeId: "1",
        userId: "1",
        businessUnitId: "1",
        statusId: "1",
        sigPositions: "[]",
        datePositions: "[]",
        memoNumberPositions: "[]",
        notePositions: "[]",
        fileOrderTokens: "[]",
        urlLinks: "[]",
      },
      files: {
        files: [
          {
            path: "/tmp/a.pdf",
            originalname: "a.pdf",
            size: 100,
            mimetype: "application/pdf",
          },
        ],
        attachedFiles: [],
      },
    });

    vi.mocked(prisma.memoType.findUnique).mockResolvedValueOnce({
      id: 1,
      abbreviation: "T",
      businessUnitId: 1,
      departmentId: null,
      businessUnit: { abbreviation: "BU" },
      department: null,
    } as any);

    vi.mocked(reserveMemoNumber).mockResolvedValueOnce({
      id: 1,
      memonumber: "BU-001",
    } as any);

    vi.mocked(prisma.masterMemo.create).mockResolvedValueOnce({ id: 100 } as any);

    vi.mocked(prisma.mainFile.create).mockResolvedValueOnce({
      id: 10,
    } as any);

    // $transaction for reorder (returns array)
    vi.mocked(prisma.$transaction).mockResolvedValue([]);

    // findUnique for view at end
    vi.mocked(prisma.masterMemo.findUnique).mockResolvedValueOnce({
      id: 100,
      memonumber: "BU-001",
      subject: "Test",
    } as any);

    await createMemo(req, res, next);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: 100 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// updateMemo — critical paths
// ─────────────────────────────────────────────────────────────────────────────
describe("updateMemo — critical paths", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 409 when memo is not in editable status", async () => {
    const { req, res, next } = makeReqRes({
      params: { id: "1" },
      body: { userId: "42" },
      headers: {},
    });

    vi.mocked(prisma.memoStatusPivot.findFirst).mockResolvedValueOnce({
      statusId: 3, // APPROVED — not editable
    } as any);

    await updateMemo(req, res, next);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "MEMO_STATUS_CHANGED" }),
    );
  });

  it("returns 200 on successful update (no override, line unchanged)", async () => {
    const { req, res, next } = makeReqRes({
      params: { id: "5" },
      body: {
        userId: "42",
        subject: "Updated Subject",
        businessUnitId: "1",
        sigPositions: "[]",
        datePositions: "[]",
        memoNumberPositions: "[]",
        notePositions: "[]",
        fileOrderTokens: "[]",
        urlLinks: "[]",
        removedFileIds: "[]",
        removedAttachedFileIds: "[]",
      },
      files: { files: [], attachedFiles: [] },
      headers: {},
    });

    // Status check: statusId = 1 (Draft) — editable
    vi.mocked(prisma.memoStatusPivot.findFirst).mockResolvedValueOnce({
      statusId: 1,
    } as any);

    // Old approvalLineId
    vi.mocked(prisma.masterMemo.findUnique).mockResolvedValueOnce({
      approvalLineId: null,
    } as any);

    // Update returns memo with same approvalLineId (line NOT changed)
    vi.mocked(prisma.masterMemo.update).mockResolvedValueOnce({
      id: 5,
      approvalLineId: null,
      subject: "Updated Subject",
    } as any);

    // Clone version actions
    vi.mocked(prisma.memoApproverAction.aggregate).mockResolvedValueOnce({
      _max: { version: 1 },
    } as any);
    vi.mocked(prisma.memoApproverAction.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.memoApproverAction.createMany).mockResolvedValueOnce({
      count: 0,
    } as any);

    // status upsert
    vi.mocked(prisma.memoStatusPivot.upsert).mockResolvedValueOnce({} as any);

    // File queries
    vi.mocked(prisma.mainFile.findMany).mockResolvedValue([]);

    // $transaction for positions
    vi.mocked(prisma.$transaction).mockResolvedValue([]);

    await updateMemo(req, res, next);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: 5 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// deleteMemo — soft delete
// ─────────────────────────────────────────────────────────────────────────────
describe("deleteMemo — soft delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 400 when memo has approved actions in latest version", async () => {
    const { req, res, next } = makeReqRes({ params: { id: "1" } });

    // hasAnyApprovedInLatestVersion = true
    vi.mocked(prisma.approvalActionStatus.findUnique).mockResolvedValueOnce({
      id: 2,
    } as any);
    vi.mocked(prisma.memoApproverAction.aggregate).mockResolvedValueOnce({
      _max: { version: 1 },
    } as any);
    vi.mocked(prisma.memoApproverAction.findFirst).mockResolvedValueOnce({
      id: 99,
    } as any);

    await deleteMemo(req, res, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("ลบไม่ได้") }),
    );
  });

  it("performs soft delete and returns 204 when no approved actions", async () => {
    const { req, res, next } = makeReqRes({
      params: { id: "7" },
      user: { id: 99 },
    });

    // hasAnyApprovedInLatestVersion = false (approved status not found)
    vi.mocked(prisma.approvalActionStatus.findUnique).mockResolvedValueOnce(
      null,
    );

    vi.mocked(prisma.comment.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.mainFile.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.attachedFile.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.commentAttachment.findMany).mockResolvedValueOnce([]);

    // Deleted status found
    vi.mocked(prisma.status.findFirst).mockResolvedValueOnce({
      id: 9,
      name: "Deleted",
    } as any);

    vi.mocked(prisma.$transaction).mockResolvedValueOnce([]);

    await deleteMemo(req, res, next);

    expect(res.sendStatus).toHaveBeenCalledWith(204);
  });

  it("creates Deleted status when it does not exist yet", async () => {
    const { req, res, next } = makeReqRes({
      params: { id: "8" },
      user: { id: 99 },
    });

    // hasAnyApprovedInLatestVersion = false
    vi.mocked(prisma.approvalActionStatus.findUnique).mockResolvedValueOnce(
      null,
    );

    vi.mocked(prisma.comment.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.mainFile.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.attachedFile.findMany).mockResolvedValueOnce([]);
    vi.mocked(prisma.commentAttachment.findMany).mockResolvedValueOnce([]);

    // Deleted status NOT found
    vi.mocked(prisma.status.findFirst).mockResolvedValueOnce(null);

    // Create Deleted status
    vi.mocked(prisma.status.aggregate).mockResolvedValueOnce({
      _max: { id: 8 },
    } as any);
    vi.mocked(prisma.status.create).mockResolvedValueOnce({
      id: 9,
      name: "Deleted",
    } as any);

    vi.mocked(prisma.$transaction).mockResolvedValueOnce([]);

    await deleteMemo(req, res, next);

    expect(prisma.status.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: "Deleted" }) }),
    );
    expect(res.sendStatus).toHaveBeenCalledWith(204);
  });
});
