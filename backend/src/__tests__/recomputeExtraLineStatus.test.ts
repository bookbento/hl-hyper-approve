/**
 * Unit tests for recomputeExtraLineStatus
 *
 * Strategy: vi.mock the prisma module so the function never hits a real DB.
 * We verify the pure state-machine logic: which ExtraStatus is returned and
 * that the correct side-effects (extraApprovalLine.update, comment.updateMany)
 * are called with the right arguments.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ExtraStatus } from "@prisma/client";

// ── Mock prisma BEFORE importing the module under test ──
vi.mock("../../prisma/client", () => ({
  prisma: {
    status: {
      findFirst: vi.fn(),
    },
    extraApprover: {
      findMany: vi.fn(),
    },
    extraApprovalLine: {
      update: vi.fn(),
    },
    comment: {
      updateMany: vi.fn(),
    },
  },
}));

// Also mock heavy side-effect imports that memo.controller drags in
vi.mock("../lib/mailer", () => ({ sendEmail: vi.fn() }));
vi.mock("../lib/token", () => ({ makeEmailToken: vi.fn(), verifyEmailToken: vi.fn() }));
vi.mock("../lib/notificationPreferences", () => ({ filterUsersForEmail: vi.fn() }));
vi.mock("../controllers/memoStatus.controller", () => ({
  evaluateAndUpdateMemoStatus: vi.fn(),
  getUserDisplayName: vi.fn(),
  toDisplayName: vi.fn(),
  notifyStatusUpdate: vi.fn(),
}));

import { recomputeExtraLineStatus } from "../services/extraApproval.service";
import { prisma } from "../../prisma/client";

const mockPrisma = prisma as unknown as {
  status: { findFirst: ReturnType<typeof vi.fn> };
  extraApprover: { findMany: ReturnType<typeof vi.fn> };
  extraApprovalLine: { update: ReturnType<typeof vi.fn> };
  comment: { updateMany: ReturnType<typeof vi.fn> };
};

// Status IDs used in the real DB seed
const APPROVED_STATUS_ID = 3;
const REJECTED_STATUS_ID = 4;

beforeEach(() => {
  vi.clearAllMocks();

  // getStatusIdByName("Approved") -> 3, ("Rejected") -> 4
  mockPrisma.status.findFirst.mockImplementation(({ where }: { where: { name: string } }) => {
    if (where.name === "Approved") return Promise.resolve({ id: APPROVED_STATUS_ID });
    if (where.name === "Rejected") return Promise.resolve({ id: REJECTED_STATUS_ID });
    return Promise.resolve(null);
  });

  mockPrisma.extraApprovalLine.update.mockResolvedValue({});
  mockPrisma.comment.updateMany.mockResolvedValue({ count: 0 });
});

describe("recomputeExtraLineStatus", () => {
  it("returns PENDING when there are no approvers yet", async () => {
    // Arrange
    mockPrisma.extraApprover.findMany.mockResolvedValue([]);

    // Act
    const result = await recomputeExtraLineStatus(1);

    // Assert
    expect(result).toBe(ExtraStatus.PENDING);
    expect(mockPrisma.extraApprovalLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        data: expect.objectContaining({ status: ExtraStatus.PENDING, closedAt: null }),
      })
    );
  });

  it("returns COMPLETED and sets closedAt when all approvers approved", async () => {
    // Arrange
    mockPrisma.extraApprover.findMany.mockResolvedValue([
      { statusId: APPROVED_STATUS_ID },
      { statusId: APPROVED_STATUS_ID },
    ]);

    // Act
    const result = await recomputeExtraLineStatus(2);

    // Assert
    expect(result).toBe(ExtraStatus.COMPLETED);
    expect(mockPrisma.extraApprovalLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ExtraStatus.COMPLETED,
          closedAt: expect.any(Date),
        }),
      })
    );
  });

  it("returns REJECTED (and sets closedAt) when any approver rejects", async () => {
    // Arrange — one approved, one rejected → rejected wins
    mockPrisma.extraApprover.findMany.mockResolvedValue([
      { statusId: APPROVED_STATUS_ID },
      { statusId: REJECTED_STATUS_ID },
    ]);

    // Act
    const result = await recomputeExtraLineStatus(3);

    // Assert
    expect(result).toBe(ExtraStatus.REJECTED);
    expect(mockPrisma.extraApprovalLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ExtraStatus.REJECTED,
          closedAt: expect.any(Date),
        }),
      })
    );
  });

  it("returns IN_PROGRESS when some (but not all) approvers approved and none rejected", async () => {
    // Arrange — two approvers, only one approved
    mockPrisma.extraApprover.findMany.mockResolvedValue([
      { statusId: APPROVED_STATUS_ID },
      { statusId: null }, // waiting
    ]);

    // Act
    const result = await recomputeExtraLineStatus(4);

    // Assert
    expect(result).toBe(ExtraStatus.IN_PROGRESS);
    expect(mockPrisma.extraApprovalLine.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: ExtraStatus.IN_PROGRESS, closedAt: null }),
      })
    );
  });

  it("updates comment ExtraStatus with correctly formatted string", async () => {
    // Arrange
    mockPrisma.extraApprover.findMany.mockResolvedValue([
      { statusId: APPROVED_STATUS_ID },
    ]);

    // Act — allApproved → COMPLETED
    await recomputeExtraLineStatus(5);

    // Assert — "COMPLETED" → "Completed"
    expect(mockPrisma.comment.updateMany).toHaveBeenCalledWith({
      where: { extraApprovalLineId: 5 },
      data: { ExtraStatus: "Completed" },
    });
  });

  it("formats multi-word status IN_PROGRESS as 'In Progress'", async () => {
    // Arrange — partial approval → IN_PROGRESS
    mockPrisma.extraApprover.findMany.mockResolvedValue([
      { statusId: APPROVED_STATUS_ID },
      { statusId: null },
    ]);

    // Act
    await recomputeExtraLineStatus(6);

    // Assert
    expect(mockPrisma.comment.updateMany).toHaveBeenCalledWith({
      where: { extraApprovalLineId: 6 },
      data: { ExtraStatus: "In Progress" },
    });
  });

  it("REJECTED takes precedence even when all others approved", async () => {
    // Arrange — 3 approved + 1 rejected
    mockPrisma.extraApprover.findMany.mockResolvedValue([
      { statusId: APPROVED_STATUS_ID },
      { statusId: APPROVED_STATUS_ID },
      { statusId: APPROVED_STATUS_ID },
      { statusId: REJECTED_STATUS_ID },
    ]);

    // Act
    const result = await recomputeExtraLineStatus(7);

    // Assert — anyRejected guard fires first
    expect(result).toBe(ExtraStatus.REJECTED);
  });
});
