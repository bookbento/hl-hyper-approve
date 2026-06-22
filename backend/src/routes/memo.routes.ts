import { Router } from "express";
import {
  getAllMemos,
  getMemoById,
  createMemo,
  updateMemo,
  deleteMemo,
  uploadMainPDF,
  saveSignaturePosition,
  saveDatePosition,
  saveNotePosition,
  getApprovers,
  getMemoApprovalLine,
  downloadMergedPdf,

  getBusinessUnits,
  getApprovalLines,
  downloadRawPdf,
  getMainFilePdf,
  recallMemo,
  getCommentsByMemoId,
  addCommentToMemo,
  deleteComment,
  getAwaitingApproval,
  approveAction,
  forceDeleteMemo,
  getCurrentApprovers,
  createExtraApprovalLine,
  getActiveExtraApprovalLine,
  getActiveExtraApprovalLinesBulk,
  actOnExtraApprovalLine,
  appendExtraApprovers,
  searchEligibleUsersForExtra,
  searchMemosForReference,
  getMemoReferences,
  updateMemoReferences,
  getReferenceMemoContent,
  getUsersDelegationInfo,
  listExtraApprovalLines,
  removeExtraApprovalLine,
  renewExpiry,
  searchMemosHandler,
  searchMemoStatsHandler,
} from "../controllers/memo.controller";
import { uploadToDisk, handleUploadError } from "../middlewares/upload";
import { authenticate } from "../middlewares/auth.middleware";

const router = Router();

/* ---------- routes ที่ไม่ใช่ Memo ---------- */

router.get("/business-units", authenticate, getBusinessUnits);      //  GET  /api/business-units
router.get("/approval-lines", authenticate, getApprovalLines);      //  GET  /api/approval-lines   //  GET  /api/approval-lines
router.get("/memos/awaiting-approval", authenticate,getAwaitingApproval);
router.get("/memos/current-approvers", authenticate, getCurrentApprovers);
router.post("/memos/search", authenticate, searchMemosHandler); // POST /api/memos/search — server-side paginated search
router.post("/memos/search/stats", authenticate, searchMemoStatsHandler); // POST /api/memos/search/stats — dashboard stat cards
router.post("/memos/users-delegation-info", authenticate, getUsersDelegationInfo);
/* ---------- Memo References ---------- */
router.get("/memos/search-for-reference", authenticate, searchMemosForReference);
/* ---------- Memo CRUD / utility ---------- */
router.get("/memos", authenticate, getAllMemos);            //  GET  /api/memos
router.get("/memos/:id", authenticate, getMemoById);          //  GET  /api/memos/:id
router.get("/memos/:id/approvers", authenticate, getApprovers);     //  GET  /api/memos/:id/approvers
router.get("/memos/:id/approval-line", authenticate, getMemoApprovalLine);     //  GET  /api/memos/:id/approval-line
router.post("/memos/:id/action-signature", authenticate,approveAction);            // POST /api/memos/:id/action
router.get("/memos/:id/download", authenticate, downloadMergedPdf);      //  GET  /api/memos/:id/download
router.get("/memos/:id/download/:filename", authenticate, downloadMergedPdf);      //  GET  /api/memos/:id/download/:filename
router.get("/memos/:id/raw", authenticate, downloadRawPdf);    //  GET  /api/memos/:id/raw
 //  GET  /api/memos/:id/raw

// แก้ให้ GET /api/memos/:id/pdf?fileId=XXX = ดึงต้นฉบับทีละไฟล์ (ไม่ merge)
//   → ตรงนี้จะเลือกใช้ getMainFilePdf แทน downloadMergedPdf
router.get("/memos/:id/pdf", authenticate, getMainFilePdf);          //  GET  /api/memos/:id/pdf?fileId=XXX

router.post(
  "/memos",
  authenticate,
  handleUploadError(uploadToDisk.fields([
    { name: "files", maxCount: 50 },
    { name: "attachedFiles", maxCount: 50 },
  ])),
  createMemo
); 
//  POST /api/memos
router.post("/memos/:id/upload-main", authenticate, handleUploadError(uploadToDisk.single("file")), uploadMainPDF); // POST /api/memos/:id/upload-main


/* ---------- ตำแหน่งลายเซ็น / วันที่ ---------- */
router.post("/memos/signature", authenticate, saveSignaturePosition);                 //  POST /api/memos/signature
router.post("/memos/date", authenticate, saveDatePosition);                      //  POST /api/memos/date
router.post("/memos/note", authenticate, saveNotePosition);                      //  POST /api/memos/note

/* ---------- สถานะ ---------- */
// router.post("/memos/:id/status", saveMemoStatus);
router.post("/memos/:id/recall", authenticate, recallMemo);                     //  POST /api/memos/:id/status
router.post("/memos/:id/renew-expiry", authenticate, renewExpiry);              //  POST /api/memos/:id/renew-expiry

router.put(
  "/memos/:id",
  authenticate,
  handleUploadError(uploadToDisk.fields([
    { name: "files", maxCount: 50 },
    { name: "attachedFiles", maxCount: 50 },
  ])),
  updateMemo
);
                  //  PUT   /api/memos/:id

router.delete("/memos/:id", authenticate, deleteMemo);      
router.delete("/memos/:id/force", authenticate, forceDeleteMemo);   //  DELETE /api/memos/:id                      //  DELETE /api/memos/:id
/* ---------- Comment ---------- */
// ดึงคอมเมนต์
router.get("/memos/:id/comments", authenticate, getCommentsByMemoId);

// เพิ่ม middleware multer เพื่ออ่านไฟล์ field ชื่อ "file" เข้า req.file
// แนะนำใช้ memoryStorage ถ้าอยากเอาไปประมวลผลก่อน save ลง DB
router.post(
  "/memos/:id/comments",
  authenticate,
  handleUploadError(uploadToDisk.array("files", 6)), // ✅ Support multiple files
  addCommentToMemo
);

// ลบคอมเมนต์
router.delete("/comments/:commentId", authenticate, deleteComment);
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

/* ---------- Memo References (continued) ---------- */
router.get("/memos/:id/references", authenticate, getMemoReferences);
router.put("/memos/:id/references", authenticate, updateMemoReferences);
router.get("/memos/:id/reference-content/:referenceId", authenticate, getReferenceMemoContent);


export default router;
