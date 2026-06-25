import { Router } from "express";
import {
  createMemo,
  updateMemo,
  deleteMemo,
  uploadMainPDF,
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
  forceDeleteMemo,
  createExtraApprovalLine,
  getActiveExtraApprovalLine,
  getActiveExtraApprovalLinesBulk,
  actOnExtraApprovalLine,
  appendExtraApprovers,
  searchEligibleUsersForExtra,
  listExtraApprovalLines,
  removeExtraApprovalLine,
  renewExpiry,
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
//       The routes below cover WRITE operations and other sub-paths not
//       yet migrated.

/* ---------- routes ที่ไม่ใช่ Memo (dropdown data) ---------- */
// NOTE: /api/business-units is already handled by Nest BusinessUnit CRUD module.
// The handlers below are kept for sub-path usage but the top-level routes
// are shadowed by Nest's exclude list. Investigate dropdown vs. CRUD mismatch
// before removing (see Batch 6a migration report).
router.get("/business-units", authenticate, getBusinessUnits);
router.get("/approval-lines", authenticate, getApprovalLines);

/* ---------- Approvers (batch 4 migrated — shadowed, keep for safety) ---------- */
// GET /api/memos/:id/approvers   → Nest (ApprovalLineModule)
// GET /api/memos/:id/approval-line → Nest (ApprovalLineModule)
// These route lines are kept as silent fallback but Nest gateway excludes them.

/* ---------- Memo CRUD / utility ---------- */
// READS (GET /api/memos, GET /api/memos/:id, GET /api/memos/awaiting-approval,
//        GET /api/memos/current-approvers, GET /api/memos/search-for-reference,
//        POST /api/memos/search, POST /api/memos/search/stats,
//        POST /api/memos/users-delegation-info,
//        GET /api/memos/:id/references, PUT /api/memos/:id/references,
//        GET /api/memos/:id/reference-content/:referenceId)
//   → ALL migrated to Nest MemoQueryModule (Batch 6a). Route lines REMOVED.

router.get("/memos/:id/approvers", authenticate, getApprovers);
router.get("/memos/:id/approval-line", authenticate, getMemoApprovalLine);

router.post("/memos/:id/action-signature", authenticate, approveAction);
router.get("/memos/:id/download", authenticate, downloadMergedPdf);
router.get("/memos/:id/download/:filename", authenticate, downloadMergedPdf);
router.get("/memos/:id/raw", authenticate, downloadRawPdf);
router.get("/memos/:id/pdf", authenticate, getMainFilePdf);

router.post(
  "/memos",
  authenticate,
  handleUploadError(uploadToDisk.fields([
    { name: "files", maxCount: 50 },
    { name: "attachedFiles", maxCount: 50 },
  ])),
  createMemo
);
router.post("/memos/:id/upload-main", authenticate, handleUploadError(uploadToDisk.single("file")), uploadMainPDF);

/* ---------- ตำแหน่งลายเซ็น / วันที่ ---------- */
router.post("/memos/signature", authenticate, saveSignaturePosition);
router.post("/memos/date", authenticate, saveDatePosition);
router.post("/memos/note", authenticate, saveNotePosition);

/* ---------- สถานะ ---------- */
router.post("/memos/:id/recall", authenticate, recallMemo);
router.post("/memos/:id/renew-expiry", authenticate, renewExpiry);

router.put(
  "/memos/:id",
  authenticate,
  handleUploadError(uploadToDisk.fields([
    { name: "files", maxCount: 50 },
    { name: "attachedFiles", maxCount: 50 },
  ])),
  updateMemo
);

router.delete("/memos/:id", authenticate, deleteMemo);
router.delete("/memos/:id/force", authenticate, forceDeleteMemo);

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
