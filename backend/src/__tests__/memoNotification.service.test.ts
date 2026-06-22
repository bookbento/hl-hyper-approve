/**
 * Unit tests for memoNotification.service.ts
 *
 * Tests cover:
 *  - notifyStatusUpdate: status transitions (3/4/5/7), CC handling
 *  - notifyCcAssigned: push + email dispatch
 *  - notifyRecallUpdate: CC push + email on recall
 *  - Helper functions: formatExpiresAt, statusLabelFromId, statusColorHex, safeFilename, buildCcPlain
 *
 * Wave 5 — TDD loop (write test first, verify against extracted service)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── vi.mock calls are hoisted — no top-level variables allowed inside ────────
vi.mock("../../prisma/client", () => ({
  prisma: {
    masterMemo: { findUnique: vi.fn() },
    approvalActionStatus: { findUnique: vi.fn() },
    memoApproverAction: {
      findMany: vi.fn(),
      aggregate: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    lineOfApprovalUserPivotForUse: { findMany: vi.fn() },
    notification: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
    user: { findMany: vi.fn(), findUnique: vi.fn() },
    memoCc: { findMany: vi.fn() },
    comment: { count: vi.fn() },
    attachedFile: { count: vi.fn() },
    extraApprovalLine: { findMany: vi.fn() },
    extraApprover: { findMany: vi.fn() },
  },
}));

vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("../lib/notify", () => ({ pushNoti: vi.fn() }));
vi.mock("../lib/token", () => ({
  makeEmailToken: vi.fn(() => "mock-token"),
  verifyEmailToken: vi.fn(),
}));
vi.mock("../lib/notificationPreferences", () => ({
  filterUsersForEmail: vi.fn(),
}));
vi.mock("../services/memoApproval.service", () => ({
  getPendingActions: vi.fn(() => Promise.resolve([])),
  recordApproverAction: vi.fn(),
}));
vi.mock("../approverLine", () => ({
  getApproverLineStatus: vi.fn(() => Promise.resolve([])),
}));
vi.mock("../services/pdf.core", () => ({
  createSignedPdfBuffer: vi.fn(() => Promise.resolve(Buffer.alloc(0))),
}));
vi.mock("../lib/memoHistory", () => ({ logMemoHistory: vi.fn() }));
vi.mock("../controllers/memoStatus.controller", () => ({
  toDisplayName: vi.fn(
    (u: any, opts?: any) =>
      [u?.name, u?.lastname].filter(Boolean).join(" ") || `User#${u?.id ?? "?"}`
  ),
  getUserDisplayName: vi.fn(async (id: number) => `User#${id}`),
  getLatestVersion: vi.fn(async () => 1),
}));

import {
  notifyStatusUpdate,
  notifyCcAssigned,
  notifyRecallUpdate,
  formatExpiresAt,
  statusLabelFromId,
  statusColorHex,
  safeFilename,
  buildCcPlain,
} from "../services/memoNotification.service";
import { prisma } from "../../prisma/client";
import { sendEmail } from "../lib/mailer";
import { pushNoti } from "../lib/notify";
import { filterUsersForEmail } from "../lib/notificationPreferences";

const mp = prisma as any;
const mockSendEmail = sendEmail as any;
const mockPushNoti = pushNoti as any;
const mockFilterUsersForEmail = filterUsersForEmail as any;

// ── Shared fixtures ───────────────────────────────────────────────────────────

const BASE_MEMO = {
  id: 1,
  memonumber: "MEMO-001",
  memoNumberRecord: null,
  subject: "Test Memo",
  memoType: { name: "Internal" },
  businessUnit: { name: "IT" },
  department: { name: "Engineering" },
  userId: 200,
  approvalLineId: 10,
  expiresAt: null,
};

function setupBaseMocks() {
  mp.masterMemo.findUnique.mockResolvedValue(BASE_MEMO);
  mp.approvalActionStatus.findUnique.mockResolvedValue({ id: 1 });
  mp.memoApproverAction.findMany.mockResolvedValue([]);
  mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
  mp.memoApproverAction.findFirst.mockResolvedValue(null);
  mp.lineOfApprovalUserPivotForUse.findMany.mockResolvedValue([]);
  mp.notification.findMany.mockResolvedValue([]);
  mp.notification.create.mockResolvedValue({});
  mp.user.findMany.mockResolvedValue([]);
  mp.user.findUnique.mockResolvedValue(null);
  mp.memoCc.findMany.mockResolvedValue([]);
  mp.comment.count.mockResolvedValue(0);
  mp.attachedFile.count.mockResolvedValue(0);
  mp.extraApprovalLine.findMany.mockResolvedValue([]);
  mp.extraApprover.findMany.mockResolvedValue([]);
  mockSendEmail.mockResolvedValue(undefined);
  mockPushNoti.mockResolvedValue(undefined);
  mockFilterUsersForEmail.mockResolvedValue([]);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("formatExpiresAt", () => {
  it("returns null when called with null", () => {
    expect(formatExpiresAt(null)).toBeNull();
  });

  it("returns null when called with undefined", () => {
    expect(formatExpiresAt(undefined)).toBeNull();
  });

  it("returns a string for a valid Date", () => {
    const dt = new Date("2025-12-31T12:00:00Z");
    const result = formatExpiresAt(dt);
    expect(typeof result).toBe("string");
    expect(result).not.toBeNull();
  });
});

describe("statusLabelFromId", () => {
  it("returns Approved for statusId 3", () => {
    expect(statusLabelFromId(3)).toBe("Approved");
  });

  it("returns Terminated for statusId 7", () => {
    expect(statusLabelFromId(7)).toBe("Terminated");
  });

  it("returns Rejected for statusId 4", () => {
    expect(statusLabelFromId(4)).toBe("Rejected");
  });

  it("returns Processing as fallback", () => {
    expect(statusLabelFromId(5)).toBe("Processing");
    expect(statusLabelFromId(undefined)).toBe("Processing");
  });
});

describe("statusColorHex", () => {
  it("returns red for statusId 4", () => {
    expect(statusColorHex(4)).toBe("#e74c3c");
  });

  it("returns green for statusId 3", () => {
    expect(statusColorHex(3)).toBe("#27ae60");
  });

  it("returns dark for statusId 7", () => {
    expect(statusColorHex(7)).toBe("#34495e");
  });

  it("returns blue as fallback", () => {
    expect(statusColorHex(5)).toBe("#2980b9");
  });
});

describe("safeFilename", () => {
  it("appends .pdf extension by default", () => {
    expect(safeFilename("MEMO-001")).toBe("MEMO-001.pdf");
  });

  it("strips dangerous characters", () => {
    expect(safeFilename('memo<>/\\:"test')).toContain("memo");
    expect(safeFilename('memo<>/\\:"test')).not.toContain("<");
  });

  it("truncates to 150 chars + extension", () => {
    const long = "a".repeat(200);
    const result = safeFilename(long);
    expect(result.length).toBeLessThanOrEqual(154); // 150 + ".pdf"
  });
});

describe("buildCcPlain", () => {
  it("includes receiver name and memo subject", () => {
    const result = buildCcPlain(
      "Alice",
      "Bob",
      "Test Subject",
      "MEMO-001",
      "http://app/memo/1",
      "Internal",
      "IT",
      "Engineering"
    );
    expect(result).toContain("Alice");
    expect(result).toContain("Test Subject");
    expect(result).toContain("MEMO-001");
  });

  it("includes status label when statusId provided", () => {
    const result = buildCcPlain(
      "Alice",
      "Bob",
      "Test Subject",
      "MEMO-001",
      "http://app/memo/1",
      "Internal",
      "IT",
      "Engineering",
      null,
      { statusId: 3, statusLabel: "Approved" }
    );
    expect(result).toContain("Approved");
  });

  it("includes detail lines when provided", () => {
    const result = buildCcPlain(
      "Alice",
      "Bob",
      "Test Subject",
      "MEMO-001",
      "http://app/memo/1",
      "Internal",
      "IT",
      "Engineering",
      null,
      { detailLines: ["All approvers have approved."] }
    );
    expect(result).toContain("All approvers have approved.");
  });
});

describe("notifyStatusUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
  });

  it("returns early when memo not found", async () => {
    mp.masterMemo.findUnique.mockResolvedValue(null);
    await notifyStatusUpdate(1, 100, "Alice", 4, 1);
    expect(mockPushNoti).not.toHaveBeenCalled();
  });

  it("returns early for unknown statusId", async () => {
    await notifyStatusUpdate(1, 100, "Alice", 99, 1);
    expect(mockPushNoti).not.toHaveBeenCalled();
  });

  it("calls pushNoti for statusId 4 (Rejected)", async () => {
    await notifyStatusUpdate(1, 100, "Alice", 4, 1);
    expect(mockPushNoti).toHaveBeenCalledWith(
      [200], // ownerId
      100,
      expect.objectContaining({ statusId: 4, memoId: 1 }),
      "status-rejected"
    );
  });

  it("calls pushNoti for statusId 7 (Terminated)", async () => {
    await notifyStatusUpdate(1, 100, "Alice", 7, 1);
    expect(mockPushNoti).toHaveBeenCalledWith(
      [200],
      100,
      expect.objectContaining({ statusId: 7, memoId: 1 }),
      "status-terminated"
    );
  });

  it("returns early for statusId 5 when no waiting rows", async () => {
    mp.memoApproverAction.findMany.mockResolvedValue([]);
    await notifyStatusUpdate(1, 100, "Alice", 5, 1);
    // waitingRows is empty → returns early before pushNoti
    expect(mockPushNoti).not.toHaveBeenCalled();
  });

  it("sends immediate email for statusId 4 when users opt in", async () => {
    mockFilterUsersForEmail.mockResolvedValue([200]);
    mp.user.findMany.mockResolvedValue([
      { id: 200, name: "Owner", lastname: "User", nickname: null, email: "owner@test.com" },
    ]);

    await notifyStatusUpdate(1, 100, "Alice", 4, 1);
    expect(mockSendEmail).toHaveBeenCalledWith(
      ["owner@test.com"],
      expect.stringContaining("MEMO-001"),
      expect.any(String),
      expect.any(String),
      undefined
    );
  });

  it("does not send email for statusId 4 when no users opt in", async () => {
    mockFilterUsersForEmail.mockResolvedValue([]);
    await notifyStatusUpdate(1, 100, "Alice", 4, 1);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sends CC notifications for statusId 3 (Final Approved)", async () => {
    // Owner gets approved notification, CC gets separate
    mockFilterUsersForEmail.mockImplementation(async (ids: number[], slug: string) => {
      if (slug === "status-approved") return ids;
      if (slug === "cc-notification") return ids;
      return [];
    });
    mp.user.findMany.mockResolvedValue([
      { id: 200, name: "Owner", lastname: "", nickname: null, email: "owner@test.com" },
      { id: 301, name: "CC", lastname: "User", nickname: null, email: "cc@test.com" },
    ]);
    mp.memoCc.findMany.mockResolvedValue([{ userId: 301 }]);

    // Need pivots for level check in statusId=3
    mp.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mp.memoApproverAction.findMany.mockResolvedValue([
      {
        loaUser: {
          id: 10,
          userId: 100,
          level: 1,
          approvalRequirement: "ALL",
          user: { id: 100, name: "Alice", lastname: "", nickname: null },
        },
      },
    ]);

    await notifyStatusUpdate(1, 100, "Alice", 3, 1); // currentLevel == maxLevel == 1
    expect(mockPushNoti).toHaveBeenCalled();
  });
});

describe("notifyCcAssigned", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
  });

  it("returns early when ccUserIds is empty", async () => {
    await notifyCcAssigned(1, 100, []);
    expect(mockPushNoti).not.toHaveBeenCalled();
  });

  it("returns early when memo not found", async () => {
    mp.masterMemo.findUnique.mockResolvedValue(null);
    await notifyCcAssigned(1, 100, [301]);
    expect(mockPushNoti).not.toHaveBeenCalled();
  });

  it("calls pushNoti with correct memoId and statusId", async () => {
    await notifyCcAssigned(1, 100, [301]);
    expect(mockPushNoti).toHaveBeenCalledWith(
      [301],
      100,
      expect.objectContaining({ memoId: 1, statusId: 5 })
    );
  });

  it("sends email to CC users who opt in", async () => {
    mockFilterUsersForEmail.mockResolvedValue([301]);
    mp.user.findMany.mockResolvedValue([
      { id: 301, name: "CC", lastname: "User", nickname: null, email: "cc@test.com" },
    ]);

    await notifyCcAssigned(1, 100, [301]);
    expect(mockSendEmail).toHaveBeenCalledWith(
      ["cc@test.com"],
      expect.stringContaining("MEMO-001"),
      expect.any(String),
      expect.any(String),
      []
    );
  });

  it("does not send email when no CC users opt in", async () => {
    mockFilterUsersForEmail.mockResolvedValue([]);
    await notifyCcAssigned(1, 100, [301]);
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("deduplicates ccUserIds before pushing", async () => {
    await notifyCcAssigned(1, 100, [301, 301, 302]);
    const call = mockPushNoti.mock.calls[0];
    const recipients = call[0] as number[];
    // Should not have duplicates
    expect(new Set(recipients).size).toBe(recipients.length);
  });
});

describe("notifyRecallUpdate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupBaseMocks();
  });

  it("returns early when memo not found", async () => {
    mp.masterMemo.findUnique.mockResolvedValue(null);
    await notifyRecallUpdate(1, 100, "Alice");
    expect(mockPushNoti).not.toHaveBeenCalled();
  });

  it("does nothing when no CC users exist", async () => {
    mp.memoCc.findMany.mockResolvedValue([]);
    await notifyRecallUpdate(1, 100, "Alice");
    expect(mockPushNoti).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("sends pushNoti to CC users on recall", async () => {
    mp.memoCc.findMany.mockResolvedValue([{ userId: 301 }, { userId: 302 }]);
    await notifyRecallUpdate(1, 100, "Alice");
    expect(mockPushNoti).toHaveBeenCalledWith(
      expect.arrayContaining([301, 302]),
      100,
      expect.objectContaining({ statusId: 6, memoId: 1 })
    );
  });

  it("sends recall CC email to users who opt in", async () => {
    mp.memoCc.findMany.mockResolvedValue([{ userId: 301 }]);
    mockFilterUsersForEmail.mockResolvedValue([301]);
    mp.user.findMany.mockResolvedValue([
      { id: 301, name: "CC", lastname: "User", nickname: null, email: "cc@test.com" },
    ]);
    // memoDetails for buName/deptName/expiresAt
    mp.masterMemo.findUnique
      .mockResolvedValueOnce(BASE_MEMO) // first call for main memo
      .mockResolvedValueOnce({          // second call for memoDetails
        businessUnit: { name: "IT" },
        department: { name: "Engineering" },
        expiresAt: null,
      });

    await notifyRecallUpdate(1, 100, "Alice");
    expect(mockSendEmail).toHaveBeenCalledWith(
      ["cc@test.com"],
      expect.stringContaining("Recalled"),
      expect.any(String),
      expect.any(String),
      []
    );
  });

  it("does not send CC email when users opt out", async () => {
    mp.memoCc.findMany.mockResolvedValue([{ userId: 301 }]);
    mockFilterUsersForEmail.mockResolvedValue([]); // all opted out
    await notifyRecallUpdate(1, 100, "Alice");
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it("does not throw when CC email fails", async () => {
    mp.memoCc.findMany.mockRejectedValue(new Error("DB error"));
    // Should catch internally and not re-throw
    await expect(notifyRecallUpdate(1, 100, "Alice")).resolves.not.toThrow();
  });
});
