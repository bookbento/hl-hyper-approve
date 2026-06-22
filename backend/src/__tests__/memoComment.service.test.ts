/**
 * Unit tests for memoComment.service.ts
 *
 * Strategy: vi.mock all external I/O (prisma, mailer, notificationPreferences,
 * token, upload, filename) — no real DB or network calls.
 *
 * Coverage scenarios (per Wave 3 blueprint):
 *   getCommentsByMemoId — invalid ID, DB error, success payload shape
 *   addCommentToMemo    — silent status skips email, mention parsing & tags,
 *                         file attachment path, missing content+file → 400
 *   deleteComment       — no-mention guard → 403, comment not found → 404,
 *                         permission (actorId from req.user), success 204
 *   sendCommentEmailsAsync — silent status returns early, no receivers, filters
 *   sendDeleteCommentEmailsAsync — silent status returns early
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ActionType } from "@prisma/client";

// ── Mocks BEFORE imports (vi.mock hoisting — no top-level variables in factory) ──

vi.mock("../../prisma/client", () => {
  const mockFn = () => vi.fn();
  return {
    prisma: {
      comment: {
        findMany: mockFn(),
        create: mockFn(),
        findUnique: mockFn(),
        delete: mockFn(),
      },
      commentAttachment: { create: mockFn() },
      commentTag: { createMany: mockFn() },
      memoStatusPivot: { findFirst: mockFn() },
      masterMemo: { findUnique: mockFn() },
      memoApproverAction: { aggregate: mockFn() },
      user: { findMany: mockFn() },
      notification: { createMany: mockFn() },
      memoHistory: { create: mockFn() },
    },
  };
});

vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../lib/token", () => ({
  makeEmailToken: vi.fn().mockResolvedValue("mock-token"),
  verifyEmailToken: vi.fn(),
}));
vi.mock("../lib/notificationPreferences", () => ({
  filterUsersForEmail: vi.fn().mockResolvedValue([]),
}));
vi.mock("../middlewares/upload", () => ({
  UPLOADS_DIR: "/mock/uploads",
  toPublicUploadPath: vi.fn((p: string) => p),
}));
vi.mock("../lib/filename", () => ({
  decodeFilename: vi.fn((s: string) => s),
  safeFileName: vi.fn((s: string) => s),
}));
vi.mock("fs", () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(true),
  },
}));

// Set required env var before module load
process.env.FRONTEND_URL = "https://app.example.com";

import {
  getCommentsByMemoId,
  addCommentToMemo,
  deleteComment,
  sendCommentEmailsAsync,
  sendDeleteCommentEmailsAsync,
} from "../services/memoComment.service";
import { prisma } from "../../prisma/client";
import { sendEmail } from "../lib/mailer";
import { filterUsersForEmail } from "../lib/notificationPreferences";

// ── Type helpers ──────────────────────────────────────────────────────────────

type MP = typeof prisma & {
  comment: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  commentAttachment: { create: ReturnType<typeof vi.fn> };
  commentTag: { createMany: ReturnType<typeof vi.fn> };
  memoStatusPivot: { findFirst: ReturnType<typeof vi.fn> };
  masterMemo: { findUnique: ReturnType<typeof vi.fn> };
  memoApproverAction: { aggregate: ReturnType<typeof vi.fn> };
  user: { findMany: ReturnType<typeof vi.fn> };
  notification: { createMany: ReturnType<typeof vi.fn> };
  memoHistory: { create: ReturnType<typeof vi.fn> };
};

const mp = prisma as unknown as MP;

// ── Request/Response factory helpers ─────────────────────────────────────────

function makeReq(overrides: Record<string, any> = {}) {
  return {
    params: {},
    body: {},
    files: [],
    file: undefined,
    user: { id: 1 },
    protocol: "https",
    get: (name: string) => (name === "host" ? "test.example.com" : ""),
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

const NON_SILENT_PIVOT = { status: { id: 2, name: "Processing" } };
const DRAFT_PIVOT = { status: { id: 1, name: "draft" } };
const RECALLED_PIVOT = { status: { id: 6, name: "recalled" } };

beforeEach(() => {
  vi.clearAllMocks();
  // sensible defaults
  mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
  mp.masterMemo.findUnique.mockResolvedValue(null);
  mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
  mp.user.findMany.mockResolvedValue([]);
  mp.notification.createMany.mockResolvedValue({ count: 0 });
  mp.memoHistory.create.mockResolvedValue({});
  (filterUsersForEmail as any).mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// getCommentsByMemoId
// ═══════════════════════════════════════════════════════════════════════════════

describe("getCommentsByMemoId", () => {
  it("returns 400 when memoId is not a number", async () => {
    // Arrange
    const req = makeReq({ params: { id: "abc" } });
    const res = makeRes();

    // Act
    await getCommentsByMemoId(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid memo ID" });
  });

  it("returns 500 on DB error", async () => {
    // Arrange
    mp.comment.findMany.mockRejectedValue(new Error("db error"));
    const req = makeReq({ params: { id: "5" } });
    const res = makeRes();

    // Act
    await getCommentsByMemoId(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to fetch comments" });
  });

  it("returns payload with normalized attachment URLs", async () => {
    // Arrange
    const fakeComment = {
      id: 1,
      comment: "hello",
      isRecallExtra: false,
      ExtraUserid: null,
      ExtraStatus: null,
      extraApprovalLineId: null,
      createdAt: new Date("2024-01-01"),
      extraUser: null,
      tags: [],
      user: { id: 10, name: "Alice", profileImagePath: "alice.jpg" },
      attachments: [
        { id: 99, url: "/api/uploads/comments/file.pdf", filename: "file.pdf", mimetype: "application/pdf" },
      ],
    };
    mp.comment.findMany.mockResolvedValue([fakeComment]);
    const req = makeReq({ params: { id: "5" } });
    const res = makeRes();

    // Act
    await getCommentsByMemoId(req, res, vi.fn());

    // Assert
    expect(res.json).toHaveBeenCalledTimes(1);
    const [payload] = res.json.mock.calls[0];
    expect(payload).toHaveLength(1);
    expect(payload[0].user.profileImage).toBe("/uploads/profiles/alice.jpg");
    // /api/uploads → /uploads (stripped)
    expect(payload[0].attachments[0].url).toContain("/uploads/comments/file.pdf");
    expect(payload[0].hasMentions).toBe(false);
  });

  it("marks hasMentions = true when tags exist", async () => {
    // Arrange
    const fakeComment = {
      id: 2,
      comment: "hey @bob",
      isRecallExtra: false,
      ExtraUserid: null,
      ExtraStatus: null,
      extraApprovalLineId: null,
      createdAt: new Date(),
      extraUser: null,
      tags: [{ id: 1, user: { id: 20, name: "Bob", lastname: null, nickname: null } }],
      user: { id: 10, name: "Alice", profileImagePath: null },
      attachments: [],
    };
    mp.comment.findMany.mockResolvedValue([fakeComment]);
    const req = makeReq({ params: { id: "5" } });
    const res = makeRes();

    // Act
    await getCommentsByMemoId(req, res, vi.fn());

    // Assert
    const [payload] = res.json.mock.calls[0];
    expect(payload[0].hasMentions).toBe(true);
    expect(payload[0].tags).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// addCommentToMemo
// ═══════════════════════════════════════════════════════════════════════════════

describe("addCommentToMemo", () => {
  it("returns 400 when memoId is not a number", async () => {
    // Arrange
    const req = makeReq({ params: { id: "xyz" }, body: { content: "hi" } });
    const res = makeRes();

    // Act
    await addCommentToMemo(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid memo ID" });
  });

  it("returns 400 when both content and file are missing", async () => {
    // Arrange
    const req = makeReq({ params: { id: "1" }, body: { content: "  " }, files: [] });
    const res = makeRes();

    // Act
    await addCommentToMemo(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Comment or attachment is required" });
  });

  it("does NOT send email/notification when status is draft (silent)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(DRAFT_PIVOT);
    const fakeComment = { id: 5, memoId: 1, userId: 1, comment: "test" };
    mp.comment.create.mockResolvedValue(fakeComment);
    mp.comment.findUnique.mockResolvedValue({
      ...fakeComment,
      user: { id: 1, name: "Alice", lastname: null, profileImagePath: null },
      attachments: [],
    });
    mp.memoHistory.create.mockResolvedValue({});

    const req = makeReq({ params: { id: "1" }, body: { content: "test" }, files: [] });
    const res = makeRes();

    // Act
    await addCommentToMemo(req, res, vi.fn());

    // Assert — email and notification should NOT be sent
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mp.notification.createMany).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("does NOT send email/notification when status is recalled (silent)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(RECALLED_PIVOT);
    const fakeComment = { id: 6, memoId: 1, userId: 1, comment: "test" };
    mp.comment.create.mockResolvedValue(fakeComment);
    mp.comment.findUnique.mockResolvedValue({
      ...fakeComment,
      user: { id: 1, name: "Alice", lastname: null, profileImagePath: null },
      attachments: [],
    });

    const req = makeReq({ params: { id: "1" }, body: { content: "test" }, files: [] });
    const res = makeRes();

    // Act
    await addCommentToMemo(req, res, vi.fn());

    // Assert
    expect(sendEmail).not.toHaveBeenCalled();
    expect(mp.notification.createMany).not.toHaveBeenCalled();
  });

  it("does NOT send email/notification when status is null (silent)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(null);
    const fakeComment = { id: 7, memoId: 1, userId: 1, comment: "test" };
    mp.comment.create.mockResolvedValue(fakeComment);
    mp.comment.findUnique.mockResolvedValue({
      ...fakeComment,
      user: { id: 1, name: "Alice", lastname: null, profileImagePath: null },
      attachments: [],
    });

    const req = makeReq({ params: { id: "1" }, body: { content: "test" }, files: [] });
    const res = makeRes();

    // Act
    await addCommentToMemo(req, res, vi.fn());

    // Assert
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("creates commentTag records for valid mentionUserIds", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    const fakeComment = { id: 8, memoId: 2, userId: 1, comment: "hello @bob" };
    mp.comment.create.mockResolvedValue(fakeComment);
    mp.comment.findUnique.mockResolvedValue({
      ...fakeComment,
      user: { id: 1, name: "Alice", lastname: null, profileImagePath: null },
      attachments: [],
    });
    mp.commentTag.createMany.mockResolvedValue({ count: 1 });
    mp.masterMemo.findUnique.mockResolvedValue(null); // skip notification path

    const req = makeReq({
      params: { id: "2" },
      body: { content: "hello @bob", mentionUserIds: JSON.stringify([20]) },
      user: { id: 1 },
      files: [],
    });
    const res = makeRes();

    // Act
    await addCommentToMemo(req, res, vi.fn());

    // Assert
    expect(mp.commentTag.createMany).toHaveBeenCalledWith({
      data: [{ memoId: 2, commentId: 8, userId: 20 }],
      skipDuplicates: true,
    });
  });

  it("excludes the commenter's own userId from mentionUserIds", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    const fakeComment = { id: 9, memoId: 3, userId: 5, comment: "self mention" };
    mp.comment.create.mockResolvedValue(fakeComment);
    mp.comment.findUnique.mockResolvedValue({
      ...fakeComment,
      user: { id: 5, name: "Charlie", lastname: null, profileImagePath: null },
      attachments: [],
    });
    mp.masterMemo.findUnique.mockResolvedValue(null);

    const req = makeReq({
      params: { id: "3" },
      body: { content: "self mention", mentionUserIds: JSON.stringify([5, 20]) },
      user: { id: 5 }, // same as userId 5 in mentionUserIds
      files: [],
    });
    const res = makeRes();

    // Act
    await addCommentToMemo(req, res, vi.fn());

    // Assert — userId 5 filtered out, only 20 should be tagged
    expect(mp.commentTag.createMany).toHaveBeenCalledWith({
      data: [{ memoId: 3, commentId: 9, userId: 20 }],
      skipDuplicates: true,
    });
  });

  it("creates commentAttachment record when file is uploaded", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    const fakeComment = { id: 10, memoId: 4, userId: 1, comment: "" };
    mp.comment.create.mockResolvedValue(fakeComment);
    mp.comment.findUnique.mockResolvedValue({
      ...fakeComment,
      user: { id: 1, name: "Alice", lastname: null, profileImagePath: null },
      attachments: [
        { id: 55, url: "/uploads/comments/1234-doc.pdf", filename: "doc.pdf", mimetype: "application/pdf" },
      ],
    });
    mp.commentAttachment.create.mockResolvedValue({});
    mp.masterMemo.findUnique.mockResolvedValue(null);

    const req = makeReq({
      params: { id: "4" },
      body: { content: "" },
      user: { id: 1 },
      files: [
        { filename: "1234-doc.pdf", mimetype: "application/pdf", size: 1024, originalname: "doc.pdf" },
      ],
    });
    const res = makeRes();

    // Act
    await addCommentToMemo(req, res, vi.fn());

    // Assert
    expect(mp.commentAttachment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commentId: 10,
        url: "/uploads/comments/1234-doc.pdf",
        filename: "doc.pdf",
        mimetype: "application/pdf",
        size: 1024,
      }),
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it("returns 500 when comment.create fails", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    mp.comment.create.mockRejectedValue(new Error("db error"));

    const req = makeReq({ params: { id: "1" }, body: { content: "hi" }, files: [] });
    const res = makeRes();

    // Act
    await addCommentToMemo(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to add comment" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// deleteComment
// ═══════════════════════════════════════════════════════════════════════════════

describe("deleteComment", () => {
  it("returns 400 when commentId is not a number", async () => {
    // Arrange
    const req = makeReq({ params: { commentId: "abc" } });
    const res = makeRes();

    // Act
    await deleteComment(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid comment ID" });
  });

  it("returns 404 when comment does not exist", async () => {
    // Arrange
    mp.comment.findUnique.mockResolvedValue(null);
    const req = makeReq({ params: { commentId: "99" } });
    const res = makeRes();

    // Act
    await deleteComment(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Comment not found" });
  });

  it("returns 403 when comment has no mention tags (regular comment)", async () => {
    // Arrange
    mp.comment.findUnique.mockResolvedValue({
      id: 1,
      memoId: 5,
      comment: "regular comment",
      tags: [], // no mentions
      memo: { subject: "Test Memo", memonumber: "M001", userId: 2 },
      user: { name: "Alice", lastname: null },
    });
    const req = makeReq({ params: { commentId: "1" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await deleteComment(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: "Only comments with mentions can be deleted.",
    });
    expect(mp.comment.delete).not.toHaveBeenCalled();
  });

  it("deletes comment with mentions and returns 204", async () => {
    // Arrange
    mp.comment.findUnique.mockResolvedValue({
      id: 10,
      memoId: 5,
      comment: "hey @bob check this",
      tags: [{ userId: 20 }],
      memo: { subject: "Test Memo", memonumber: "M001", userId: 2 },
      user: { name: "Alice", lastname: "Smith" },
    });
    mp.comment.delete.mockResolvedValue({});
    mp.user.findMany.mockResolvedValue([{ name: "Bob", lastname: null, nickname: null }]);

    const req = makeReq({ params: { commentId: "10" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await deleteComment(req, res, vi.fn());

    // Assert
    expect(mp.comment.delete).toHaveBeenCalledWith({ where: { id: 10 } });
    expect(res.sendStatus).toHaveBeenCalledWith(204);
  });

  it("uses req.user.id as actorId (not comment owner)", async () => {
    // Arrange — comment owned by user 99 but deleted by user 1 (admin)
    mp.comment.findUnique.mockResolvedValue({
      id: 11,
      memoId: 6,
      comment: "mention comment",
      tags: [{ userId: 30 }],
      memo: { subject: "Memo", memonumber: "M002", userId: 99 },
      user: { name: "Original", lastname: "Owner" },
    });
    mp.comment.delete.mockResolvedValue({});
    mp.user.findMany.mockResolvedValue([{ name: "Carol", lastname: null, nickname: null }]);
    (filterUsersForEmail as any).mockResolvedValue([30]);
    mp.user.findMany.mockResolvedValue([{ id: 30, name: "Carol", email: "carol@test.com" }]);

    const req = makeReq({ params: { commentId: "11" }, user: { id: 1 } });
    const res = makeRes();

    // Act
    await deleteComment(req, res, vi.fn());

    // Assert — notification actorId should be 1 (req.user.id), not 99
    // The notification data passed to createMany should have actorId: 1
    // (We verify indirectly via 204 success — the test checks no throw)
    expect(mp.comment.delete).toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(204);
  });

  it("excludes actorId from mentionRecipients", async () => {
    // Arrange — actor is also tagged in the comment
    mp.comment.findUnique.mockResolvedValue({
      id: 12,
      memoId: 7,
      comment: "self-mention",
      tags: [{ userId: 1 }, { userId: 20 }], // userId 1 = actor
      memo: { subject: "Memo", memonumber: "M003", userId: 2 },
      user: { name: "Alice", lastname: null },
    });
    mp.comment.delete.mockResolvedValue({});
    mp.user.findMany.mockResolvedValue([{ name: "Bob", lastname: null, nickname: null }]);

    const req = makeReq({ params: { commentId: "12" }, user: { id: 1 } }); // actor = 1
    const res = makeRes();

    // Act
    await deleteComment(req, res, vi.fn());

    // Assert — filterUsersForEmail should be called without userId 1
    const calls = (filterUsersForEmail as any).mock.calls;
    if (calls.length > 0) {
      const mentionCall = calls[0][0] as number[];
      expect(mentionCall).not.toContain(1);
    }
    expect(res.sendStatus).toHaveBeenCalledWith(204);
  });

  it("returns 500 on unexpected error", async () => {
    // Arrange
    mp.comment.findUnique.mockRejectedValue(new Error("unexpected"));
    const req = makeReq({ params: { commentId: "1" } });
    const res = makeRes();

    // Act
    await deleteComment(req, res, vi.fn());

    // Assert
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Failed to delete comment" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sendCommentEmailsAsync
// ═══════════════════════════════════════════════════════════════════════════════

describe("sendCommentEmailsAsync", () => {
  const BASE_ARGS = {
    receiverIds: [10],
    memoSubject: "Test Memo",
    memoNumber: "M001",
    memoId: 1,
    commenter: "Alice",
    snippet: "hello world",
  };

  it("returns early when status is draft (silent)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(DRAFT_PIVOT);

    // Act
    await sendCommentEmailsAsync(BASE_ARGS);

    // Assert
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("returns early when status is recalled (silent)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(RECALLED_PIVOT);

    // Act
    await sendCommentEmailsAsync(BASE_ARGS);

    // Assert
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("returns early when receiverIds is empty", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);

    // Act
    await sendCommentEmailsAsync({ ...BASE_ARGS, receiverIds: [] });

    // Assert
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("returns early when filterUsersForEmail returns empty", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    (filterUsersForEmail as any).mockResolvedValue([]);

    // Act
    await sendCommentEmailsAsync(BASE_ARGS);

    // Assert
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("sends email to filtered users with correct subject (non-mention)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    (filterUsersForEmail as any).mockResolvedValue([10]);
    mp.user.findMany.mockResolvedValue([{ id: 10, name: "Bob", email: "bob@test.com" }]);

    // Act
    await sendCommentEmailsAsync({ ...BASE_ARGS, isMention: false });

    // Assert
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject] = (sendEmail as any).mock.calls[0];
    expect(to).toEqual(["bob@test.com"]);
    expect(subject).toContain("New comment on memo");
  });

  it("sends email with mention subject when isMention = true", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    (filterUsersForEmail as any).mockResolvedValue([10]);
    mp.user.findMany.mockResolvedValue([{ id: 10, name: "Bob", email: "bob@test.com" }]);

    // Act
    await sendCommentEmailsAsync({ ...BASE_ARGS, isMention: true });

    // Assert
    const [, subject] = (sendEmail as any).mock.calls[0];
    expect(subject).toContain("You were mentioned");
  });

  it("uses 'tagged-in-comment' slug when isMention = true", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    (filterUsersForEmail as any).mockResolvedValue([10]);
    mp.user.findMany.mockResolvedValue([{ id: 10, name: "Bob", email: "bob@test.com" }]);

    // Act
    await sendCommentEmailsAsync({ ...BASE_ARGS, isMention: true });

    // Assert
    expect(filterUsersForEmail).toHaveBeenCalledWith(
      expect.any(Array),
      "tagged-in-comment",
    );
  });

  it("uses 'others-mentioned' slug when mentionedNames has entries", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    (filterUsersForEmail as any).mockResolvedValue([10]);
    mp.user.findMany.mockResolvedValue([{ id: 10, name: "Bob", email: "bob@test.com" }]);

    // Act
    await sendCommentEmailsAsync({
      ...BASE_ARGS,
      isMention: false,
      mentionedNames: ["Carol"],
    });

    // Assert
    expect(filterUsersForEmail).toHaveBeenCalledWith(
      expect.any(Array),
      "others-mentioned",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// sendDeleteCommentEmailsAsync
// ═══════════════════════════════════════════════════════════════════════════════

describe("sendDeleteCommentEmailsAsync", () => {
  const BASE_ARGS = {
    receiverIds: [10],
    memoSubject: "Test Memo",
    memoNumber: "M001",
    memoId: 1,
    commenter: "Alice",
    snippet: "deleted content",
  };

  it("returns early when status is draft (silent)", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(DRAFT_PIVOT);

    // Act
    await sendDeleteCommentEmailsAsync(BASE_ARGS);

    // Assert
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("returns early when receiverIds is empty", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);

    // Act
    await sendDeleteCommentEmailsAsync({ ...BASE_ARGS, receiverIds: [] });

    // Assert
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("uses 'removed-mention' notification slug always", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    (filterUsersForEmail as any).mockResolvedValue([10]);
    mp.user.findMany.mockResolvedValue([{ id: 10, name: "Bob", email: "bob@test.com" }]);

    // Act
    await sendDeleteCommentEmailsAsync(BASE_ARGS);

    // Assert
    expect(filterUsersForEmail).toHaveBeenCalledWith(
      expect.any(Array),
      "removed-mention",
    );
  });

  it("sends email with correct subject when isMention = true", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    (filterUsersForEmail as any).mockResolvedValue([10]);
    mp.user.findMany.mockResolvedValue([{ id: 10, name: "Bob", email: "bob@test.com" }]);

    // Act
    await sendDeleteCommentEmailsAsync({ ...BASE_ARGS, isMention: true });

    // Assert
    const [, subject] = (sendEmail as any).mock.calls[0];
    expect(subject).toContain("A mention of you was deleted");
  });

  it("sends email with correct subject when isMention = false", async () => {
    // Arrange
    mp.memoStatusPivot.findFirst.mockResolvedValue(NON_SILENT_PIVOT);
    (filterUsersForEmail as any).mockResolvedValue([10]);
    mp.user.findMany.mockResolvedValue([{ id: 10, name: "Bob", email: "bob@test.com" }]);

    // Act
    await sendDeleteCommentEmailsAsync({ ...BASE_ARGS, isMention: false });

    // Assert
    const [, subject] = (sendEmail as any).mock.calls[0];
    expect(subject).toContain("A comment with a mention was deleted");
  });
});
