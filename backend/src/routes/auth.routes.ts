import { RequestHandler, Router } from "express";
import { login, me, refreshToken, logout, getMySessions, changeFirstTimePassword } from "../controllers/auth.controller";
import { authenticate } from "../middlewares/auth.middleware";
const router = Router();

router.post("/login", login);
router.get("/me", authenticate, me);
router.post("/refresh-token", refreshToken);
router.post("/logout", logout);
router.get("/sessions", authenticate, getMySessions);
router.post("/change-first-time-password", authenticate, changeFirstTimePassword);
export default router;
