import { Router } from "express";
import {
  getAllDepartments,
  getArchivedDepartments,
  getDepartmentById,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  restoreDepartment,
} from "../controllers/department.controller";
import { authenticate, authorizeSelfOrAdmin } from "../middlewares/auth.middleware";

const router = Router();

router.get("/",getAllDepartments);
router.get("/archived", authenticate, authorizeSelfOrAdmin, getArchivedDepartments);
router.get(
  "/:id",
  authenticate,      // login ก่อน
  authorizeSelfOrAdmin,   // admin เท่านั้น
  getDepartmentById
);
router.post("/", authenticate, authorizeSelfOrAdmin, createDepartment);
router.put("/:id", authenticate, authorizeSelfOrAdmin, updateDepartment);
router.delete("/:id", authenticate, authorizeSelfOrAdmin, deleteDepartment);
router.put("/restore/:id", authenticate, authorizeSelfOrAdmin, restoreDepartment);

export default router;
