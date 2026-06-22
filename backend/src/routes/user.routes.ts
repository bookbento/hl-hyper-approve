import { RequestHandler, Router } from "express";
import {
  getAllUsers,
  getArchivedUsers,
  restoreUser,
  getUserById,
  createUser,
  updateUser,
  deleteUser,
  updateProfileImage,
  uploadProfileImage,
  changePassword,
  searchUsers,
  checkEmailExists,
  getUsersBasicInfo,
  setUserDelegation,
  getUserDelegation,
  clearUserDelegation,
  getNotificationPreferences,
  updateSingleNotificationPreference,
  updateBulkNotificationPreferences,
  forcePasswordReset,
  clearFirstLogin,
} from "../controllers/user.controller";
import {
  getUserBusinessUnitAccess,
  updateUserBusinessUnitAccess,
  getAccessibleBusinessUnits,
} from "../controllers/userBusinessUnitAccess.controller";
import {
  getDCCManagementAccess,
  updateDCCManagementAccess,
  getManageableBusinessUnits,
} from "../controllers/userDCCManagementAccess.controller";
import { uploadToMemory, uploadToDisk, handleUploadError } from "../middlewares/upload";
import { prisma } from "../../prisma/client";
import {
  authenticate,
  authorizeSelfOrAdmin,
} from "../middlewares/auth.middleware";

const router = Router();
router.get("/check-email", checkEmailExists);
router.get("/search", authenticate, searchUsers);
router.get("/basic-info", authenticate, getUsersBasicInfo);
router.get("/archived", authenticate, getArchivedUsers);
router.get(
  "/",
  authenticate, // ⭐️ ใส่ตัวนี้ก่อน // admin ผ่าน, คนอื่นโดน 403
  getAllUsers
);
router.get(
  "/:id",
  authenticate,
  authorizeSelfOrAdmin, // ✅ now types OK
  getUserById as RequestHandler
);

// ✅ รองรับ multipart/form-data

router.post("/", authenticate,authorizeSelfOrAdmin, handleUploadError(uploadToMemory.single("image")), createUser);
router.put("/:id", authenticate, authorizeSelfOrAdmin, handleUploadError(uploadToMemory.single("image")), updateUser);
router.put(
  "/:id/profile-image",
  authenticate,
  authorizeSelfOrAdmin,
  handleUploadError(uploadToDisk.any()), // Accept any field name to avoid "Unexpected field" error
  uploadProfileImage
);
router.put(
  "/:id/profile-image-legacy",
  authenticate,
  authorizeSelfOrAdmin,
  handleUploadError(uploadToMemory.single("image")),
  updateProfileImage
);
router.delete("/:id", authenticate, authorizeSelfOrAdmin, deleteUser);
router.post("/:id/restore", authenticate, authorizeSelfOrAdmin, restoreUser);
router.put("/:id/change-password", authenticate, authorizeSelfOrAdmin, changePassword);

// Force password reset route (must be before generic /:id routes)
router.post("/:id/force-password-reset", authenticate, authorizeSelfOrAdmin, forcePasswordReset);
router.post("/:id/clear-first-login", authenticate, authorizeSelfOrAdmin, clearFirstLogin);

router.post("/bulk", authenticate, async (req, res) => {
  const ids: number[] = req.body.ids;
  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
  res.json(users);
});

// Delegation routes
router.put("/:id/delegation", authenticate, authorizeSelfOrAdmin, setUserDelegation);
router.get("/:id/delegation", authenticate, authorizeSelfOrAdmin, getUserDelegation);
router.delete("/:id/delegation", authenticate, authorizeSelfOrAdmin, clearUserDelegation);

// Notification preference routes
router.get("/me/notification-preferences", authenticate, getNotificationPreferences);
router.put("/me/notification-preferences/bulk", authenticate, updateBulkNotificationPreferences);
router.put("/me/notification-preferences/:typeId", authenticate, updateSingleNotificationPreference);

// Business unit access routes
router.get("/:id/business-unit-access", authenticate, authorizeSelfOrAdmin, getUserBusinessUnitAccess);
router.put("/:id/business-unit-access", authenticate, authorizeSelfOrAdmin, updateUserBusinessUnitAccess);
router.get("/:id/accessible-business-units", authenticate, authorizeSelfOrAdmin, getAccessibleBusinessUnits);

// DCC Management access routes (for managing memo types and approval lines across BUs)
router.get("/:id/dcc-management-access", authenticate, authorizeSelfOrAdmin, getDCCManagementAccess);
router.put("/:id/dcc-management-access", authenticate, authorizeSelfOrAdmin, updateDCCManagementAccess);
router.get("/:id/manageable-business-units", authenticate, authorizeSelfOrAdmin, getManageableBusinessUnits);

export default router;
