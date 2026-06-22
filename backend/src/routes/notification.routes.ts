import { Router } from "express";
import {
  getNotifications,
  getUnreadCount,
  clearReadNotifications,
  markAllReadNotifications,
  markReadNotification,
} from "../controllers/notification.controller";
import { authenticate } from "../middlewares/auth.middleware";

const router = Router();

router.use(authenticate); 
/** GET /api/notifications?unreadOnly=true&limit=20&cursor=42 */
router.get("/", getNotifications);
router.patch("/:id/mark-read", markReadNotification);
router.patch("/mark-all-read", markAllReadNotifications);
router.get("/unread-count", getUnreadCount);
router.delete("/clear-read", clearReadNotifications);
export default router;
