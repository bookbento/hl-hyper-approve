import express from "express";
import { actOnMemo, getApproverStatus, getApproverStatusBulk, getMemoActions, recallClear, recallPreserve, updateMemoStatus } from "../controllers/memoStatus.controller";
import { handleEmailAction } from "../controllers/emailAction.controller";
import { authenticate } from "../middlewares/auth.middleware";

const router = express.Router();

router.post("/memos/:id/status", authenticate, updateMemoStatus); // ✅ final path = /api/memos/:id/status
router.post("/memos/:id/action", authenticate, actOnMemo);
router.get("/memos/:id/actions", authenticate, getMemoActions);
router.get("/memos/action/email", handleEmailAction);
router.post("/memos/approver-status/bulk", authenticate, getApproverStatusBulk);
router.get("/memos/:id/approver-status", authenticate, getApproverStatus);
router.post("/memos/:id/recall-preserve", authenticate, recallPreserve);
router.post("/memos/:id/recall-clear", authenticate, recallClear);
export default router;



