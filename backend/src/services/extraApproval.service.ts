/**
 * ExtraApprovalService — what is left after Batch 7b moved the extra approval
 * lines to Nest (apps/api/src/modules/extra-approval). memoApproveAction still
 * needs hasActiveExtraLine; delete this file with backend/ in Batch 8b.
 */

import { prisma } from "../../prisma/client";
import { ExtraStatus } from "@prisma/client";

// ─── Private helper: check if memo has an active extra line ────────────────
export async function hasActiveExtraLine(memoId: number): Promise<boolean> {
  const row = await prisma.extraApprovalLine.findFirst({
    where: {
      memoId,
      status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] },
    },
    select: { id: true },
  });
  return !!row;
}
