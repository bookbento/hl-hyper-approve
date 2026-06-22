// src/routes/cc-group.routes.ts
import { Router } from "express";
import { authenticate, authorizeAdminOrDcc } from "../middlewares/auth.middleware";
import {
  listMyGroups, createGroup, getGroup, renameGroup, replaceGroupMembers, deleteGroup,
  searchCcGroups, getGroupsBasicInfo, bulkUpdateMembers
} from "../controllers/ccGroup.controller";

const router = Router();
router.get("/search", authenticate, searchCcGroups);
router.get("/basic-info", authenticate, getGroupsBasicInfo);
// พาธภายในใช้ '/', '/:id' ให้หมด
router.get("/", authenticate,  listMyGroups);
router.post("/", authenticate, authorizeAdminOrDcc, createGroup);
router.post("/bulk-update", authenticate, authorizeAdminOrDcc, bulkUpdateMembers);
router.get("/:id", authenticate, authorizeAdminOrDcc, getGroup);
router.put("/:id", authenticate, authorizeAdminOrDcc, renameGroup);
router.put("/:id/members", authenticate, authorizeAdminOrDcc, replaceGroupMembers);
router.delete("/:id", authenticate, authorizeAdminOrDcc, deleteGroup);


export default router;
