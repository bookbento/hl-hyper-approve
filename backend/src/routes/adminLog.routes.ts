import { Router } from "express";
import { getLogsByModule, getAllLogs, createLog } from "../controllers/adminLog.controller";
import { authenticate, authorizeAdmin, authorizeAdminLogRead } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate);

// GET /api/admin-logs - Get all logs (with optional module filter)
// ADMIN can read all modules; DCC can read only MEMO_TYPE, CC_GROUP, and LOA logs.
router.get("/", authorizeAdminLogRead, getLogsByModule);

// GET /api/admin-logs/all - Get all logs without module filter
router.get("/all", authorizeAdmin, getAllLogs);

// POST /api/admin-logs - Create a manual log
router.post("/", authorizeAdmin, createLog);

export default router;
