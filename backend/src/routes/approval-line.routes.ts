import express from "express";
import {
  createApprovalLine,
  updateApprovalLine,
  deleteApprovalLine,
  getApprovers,
  getApprovalLineByMemo,
  listMyApprovalRequests,
  getAllTeams,
} from "../controllers/approval-line.controller";
import { authenticate } from "../middlewares/auth.middleware";

const router = express.Router();

// LIST all teams (departments) with businessUnit - for admin dropdown
router.get("/teams", authenticate, getAllTeams);

// LIST (admin = ได้ทุกทีม, user ปกติ = เฉพาะทีมตัวเอง, admin กรองเพิ่มได้ด้วย ?teamId=)
router.get("/approval-lines", authenticate);

// LIST by team
router.get("/teams/:id/approval-lines", authenticate);

// CREATE / UPDATE / DELETE
router.post("/approval-lines", authenticate, createApprovalLine);
router.put("/approval-lines/:id", authenticate, updateApprovalLine);
router.delete("/approval-lines/:id", authenticate, deleteApprovalLine);

// MEMO helpers
router.get("/memos/:id/approvers", authenticate, getApprovers);
router.get("/memos/:id/approval-line", authenticate, getApprovalLineByMemo);
router.get("/approval-requests/my", authenticate, listMyApprovalRequests);
export default router;
