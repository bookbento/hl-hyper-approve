// src/routes/userSignature.routes.ts
import { Router } from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import {
  listSignatures,
  uploadSignature,
  deleteSignature,
  getSignatureFile,
  setDefaultSignature,
} from "../controllers/userSignature.controller";
import { SIG_DIR } from "../middlewares/upload"; // ถ้าไฟล์กลาง export SIG_DIR อยู่
import {
  authenticate,
  authorizeSelfOrAdmin,
} from "../middlewares/auth.middleware";

const router = Router();

// สร้างโฟลเดอร์ให้แน่ใจ
fs.mkdirSync(SIG_DIR, { recursive: true });

// PNG-only uploader (เขียนลงโฟลเดอร์ signatures เท่านั้น)
const pngOnlyUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, SIG_DIR),
    filename: (_req, file, cb) => {
      const safe = file.originalname
        .normalize("NFC")
        .replace(/[^\w.\-]+/g, "_");
      cb(null, `${Date.now()}-${safe.replace(/\.[^.]+$/, "")}.png`);
    },
  }),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype !== "image/png" || ext !== ".png") {
      return cb(new Error("PNG only"));
    }
    cb(null, true);
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});

router.get(
  "/:id/signatures",
  authenticate,
  authorizeSelfOrAdmin,
  listSignatures
);

router.post(
  "/:id/signatures",
  authenticate,
  authorizeSelfOrAdmin,
  pngOnlyUpload.single("file"), // ชื่อ field = "file"
  uploadSignature
);

router.put(
  "/:id/default-signature",
  authenticate,
  authorizeSelfOrAdmin,
  setDefaultSignature
);
router.get("/signatures/:sigId/file", authenticate, getSignatureFile);
router.delete("/signatures/:sigId", authenticate, deleteSignature);
export default router;
