import { Router } from "express";
import {
  getAllBusinessUnits,
  getBusinessUnitById,
  createBusinessUnit,
  updateBusinessUnit,
  deleteBusinessUnit,
} from "../controllers/businessUnit.controller";
import { authenticate, authorizeAdminOrDcc } from "../middlewares/auth.middleware";

const router = Router();

router.get("/", getAllBusinessUnits);
router.get("/:id", getBusinessUnitById);
router.post("/", authenticate, authorizeAdminOrDcc, createBusinessUnit);
router.put("/:id", authenticate, authorizeAdminOrDcc, updateBusinessUnit);
router.delete("/:id", authenticate, authorizeAdminOrDcc, deleteBusinessUnit);

export default router;
