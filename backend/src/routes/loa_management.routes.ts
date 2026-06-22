// src/routes/approverAdmin.routes.ts
import { Router } from "express";
import {
  replaceApprover,
  bulkUpdateApprover,
  bulkUpdateSignature,
  bulkReorderApprover,
  getApproverLines,
  getAllApproverLines,
  getMemoTypesForLine,
  updateApproversForLine,
} from "../controllers/loa_management.controller";
import {
  authenticate,
  authorizeAdminOrDcc,
} from "../middlewares/auth.middleware";

const router = Router();

// ✅ list all lines (for admin page table)
router.get(
  "/approver-lines",
  authenticate,
  authorizeAdminOrDcc,
  getAllApproverLines
);

// ✅ when selecting fromUser, load lines that user belongs to
router.get(
  "/approver-lines/:userId",
  authenticate,
  authorizeAdminOrDcc,
  getApproverLines
);

// ✅ get memo types that use a specific line of approval
router.get(
  "/approver-lines/:lineId/memo-types",
  authenticate,
  authorizeAdminOrDcc,
  getMemoTypesForLine
);

// ✅ dry run / apply bulk replace
router.post(
  "/approvers/replace",
  authenticate,
  authorizeAdminOrDcc,
  replaceApprover
);

// ✅ new bulk update with multiple actions
router.post(
  "/approvers/bulk-update",
  authenticate,
  authorizeAdminOrDcc,
  bulkUpdateApprover
);

// ✅ bulk update signature requirements
router.post(
  "/approvers/bulk-signature-update",
  authenticate,
  authorizeAdminOrDcc,
  bulkUpdateSignature
);

// ✅ bulk reorder approver levels
router.post(
  "/approvers/bulk-reorder",
  authenticate,
  authorizeAdminOrDcc,
  bulkReorderApprover
);

// ✅ save edited slots for a specific line
router.put(
  "/approver-lines/:id",
  authenticate,
  authorizeAdminOrDcc,
  updateApproversForLine
);

router.post(
  "/approval-lines/:id/update-approvers",
  authenticate,
  authorizeAdminOrDcc,
  updateApproversForLine
);

export default router;
