// src/routes/memocc.routes.ts
import { Router } from "express";
import {
  listCc,
  replaceCc,
  addCcOne,
  removeCcOne,
  listMemosCcToMe,
} from "../controllers/memocc.controller";
import { authenticate } from "../middlewares/auth.middleware";

const router = Router();

// ✅ ใส่ authenticate ทุกตัว
router.get("/memos/:id/cc", authenticate, listCc);
router.put("/memos/:id/cc", authenticate, replaceCc);
router.post("/memos/:id/cc/:userId", authenticate, addCcOne);
router.delete("/memos/:id/cc/:userId", authenticate, removeCcOne);

// กล่อง "CC ถึงฉัน"
router.get("/memos/cc/me", authenticate, listMemosCcToMe);

export default router;
