import { Router } from "express";
import {
  saveSignaturePosition,
  saveDatePosition,
  saveNotePosition,
  getMemoApprovalLine,
  downloadMergedPdf,
  downloadRawPdf,
  getMainFilePdf,
  recallMemo,
  getCommentsByMemoId,
  addCommentToMemo,
  deleteComment,
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
import {
  getApprovers,
  getBusinessUnits,
  getApprovalLines,
} from "../services/memoQuery.service";
import { uploadToDisk, handleUploadError } from "../middlewares/upload";
import { authenticate } from "../middlewares/auth.middleware";

const router = Router();

// ── Routes NOT migrated to Nest yet ────────────────────────────────────────
// NOTE: All GET /memos READ endpoints are now owned by Nest (Batch 6a).
//       Batch 6b migrated: POST /memos, PUT /memos/:id, DELETE /memos/:id,
//       DELETE /memos/:id/force, POST /memos/:id/renew-expiry,
//       POST /memos/:id/upload-main → all now owned by Nest MemoLifecycleModule.

/* ---------- routes ที่ไม่ใช่ Memo (dropdown data) ---------- */
// NOTE: /api/business-units is already handled by Nest BusinessUnit CRUD module.
router.get("/business-units", authenticate, getBusinessUnits);
router.get("/approval-lines", authenticate, getApprovalLines);

/* ---------- Approvers (batch 4 migrated — shadowed, keep for safety) ---------- */
router.get("/memos/:id/approvers", authenticate, getApprovers);
router.get("/memos/:id/approval-line", authenticate, getMemoApprovalLine);

router.post("/memos/:id/action-signature", authenticate, approveAction);
router.get("/memos/:id/download", authenticate, downloadMergedPdf);
router.get("/memos/:id/download/:filename", authenticate, downloadMergedPdf);
router.get("/memos/:id/raw", authenticate, downloadRawPdf);
router.get("/memos/:id/pdf", authenticate, getMainFilePdf);

/* ---------- ตำแหน่งลายเซ็น / วันที่ ---------- */
router.post("/memos/signature", authenticate, saveSignaturePosition);
router.post("/memos/date", authenticate, saveDatePosition);
router.post("/memos/note", authenticate, saveNotePosition);

/* ---------- สถานะ ---------- */
router.post("/memos/:id/recall", authenticate, recallMemo);

/* ---------- Comment ---------- */
router.get("/memos/:id/comments", authenticate, getCommentsByMemoId);
router.post(
  "/memos/:id/comments",
  authenticate,
  handleUploadError(uploadToDisk.array("files", 6)),
  addCommentToMemo
);
router.delete("/comments/:commentId", authenticate, deleteComment);

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
