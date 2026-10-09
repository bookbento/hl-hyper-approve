import { Router } from "express";
import {
  downloadMergedPdf,
  downloadRawPdf,
  getMainFilePdf,
  recallMemo,
  approveAction,
  createExtraApprovalLine,
  getActiveExtraApprovalLine,
  getActiveExtraApprovalLinesBulk,
  actOnExtraApprovalLine,
  appendExtraApprovers,
  searchEligibleUsersForExtra,
  listExtraApprovalLines,
  removeExtraApprovalLine,
} from "../controllers/memo.controller";
import { authenticate } from "../middlewares/auth.middleware";

const router = Router();

// ── Routes NOT migrated to Nest yet ────────────────────────────────────────
// NOTE: All GET /memos READ endpoints are now owned by Nest (Batch 6a).
//       Batch 6b migrated: POST /memos, PUT /memos/:id, DELETE /memos/:id,
//       DELETE /memos/:id/force, POST /memos/:id/renew-expiry,
//       POST /memos/:id/upload-main → all now owned by Nest MemoLifecycleModule.
//       Batch 7a migrated: comments (GET/POST /memos/:id/comments,
//       DELETE /comments/:commentId) and POST /memos/signature|date|note.
//       Removed dead duplicates already owned by Nest: GET /business-units,
//       /approval-lines, /memos/:id/approvers, /memos/:id/approval-line.

router.post("/memos/:id/action-signature", authenticate, approveAction);
router.get("/memos/:id/download", authenticate, downloadMergedPdf);
router.get("/memos/:id/download/:filename", authenticate, downloadMergedPdf);
router.get("/memos/:id/raw", authenticate, downloadRawPdf);
router.get("/memos/:id/pdf", authenticate, getMainFilePdf);

/* ---------- สถานะ ---------- */
router.post("/memos/:id/recall", authenticate, recallMemo);

/* ---------- Extra Approval Lines ---------- */
router.post("/memos/:id/extra-approval-lines", authenticate, createExtraApprovalLine);
router.get("/memos/:id/extra-approval-lines", authenticate, listExtraApprovalLines);
router.post("/memos/extra-approval-lines/active/bulk", authenticate, getActiveExtraApprovalLinesBulk);
router.get("/memos/:id/extra-approval-lines/active", authenticate, getActiveExtraApprovalLine);
router.post("/memos/:memoId/extra-approval-lines/:lineId/action", authenticate, actOnExtraApprovalLine);
router.delete("/memos/:memoId/extra-approval-lines/:lineId", authenticate, removeExtraApprovalLine);
router.post(
  "/memos/:memoId/extra-approval-lines/:lineId/append",
  authenticate,
  appendExtraApprovers
);
router.get(
  "/memos/:memoId/extra-approval-lines/eligible-users",
  authenticate,
  searchEligibleUsersForExtra
);
router.get(
  "/memos/:memoId/extra-approval-lines/:lineId/eligible-users",
  authenticate,
  searchEligibleUsersForExtra
);

export default router;
