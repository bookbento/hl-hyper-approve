// src/middlewares/upload.ts
import path from "path";
import fs from "fs";
import multer from "multer";
import type { Request, Response, NextFunction } from "express";

/** หาโฟลเดอร์ ancestor ที่ชื่อ targetName (เช่น 'backend') */
function findAncestorDir(start: string, targetName: string) {
  let dir = path.resolve(start);
  for (let i = 0; i < 10; i++) {
    if (path.basename(dir).toLowerCase() === targetName.toLowerCase()) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const backendDir  = findAncestorDir(__dirname, "backend") ?? path.resolve(__dirname, ".."); // fallback
const PROJECT_ROOT = path.dirname(backendDir); // พาเรนท์ของ backend = โฟลเดอร์ ...\all
const DEFAULT_UPLOADS = path.join(PROJECT_ROOT, "uploads");

/** โฟลเดอร์อัปโหลดหลัก (ให้ ENV override ได้) */
function resolveUploadsDir() {
  const env = (process.env.UPLOADS_DIR || "").trim();
  if (!env) return DEFAULT_UPLOADS;
  // absolute = ใช้ตามนั้น, relative = ผูกกับ PROJECT_ROOT
  return path.isAbsolute(env) ? env : path.resolve(PROJECT_ROOT, env);
}
export const UPLOADS_DIR = resolveUploadsDir();

// console.log("[upload paths]", {
//   __filename,
//   __dirname,
//   cwd: process.cwd(),
//   PROJECT_ROOT,
//   DEFAULT_UPLOADS,
//   UPLOADS_DIR,
// });

export const SIG_DIR      = path.join(UPLOADS_DIR, "signatures");
export const COMMENTS_DIR = path.join(UPLOADS_DIR, "comments");
export const ATTACHED_DIR = path.join(UPLOADS_DIR, "attached");
export const PROFILES_DIR = path.join(UPLOADS_DIR, "profiles");
/** สร้างโฟลเดอร์ให้ชัวร์ */
[UPLOADS_DIR, SIG_DIR, COMMENTS_DIR, ATTACHED_DIR, PROFILES_DIR].forEach((p) =>
  fs.mkdirSync(p, { recursive: true })
);

/** เลือกโฟลเดอร์ปลายทางตาม URL/field */
function pickTargetDir(req: Request, file: Express.Multer.File) {
  const url = (req as any).originalUrl ?? req.url ?? "";
  if (url.includes("/signatures")) return SIG_DIR;
  if (url.includes("/comments")) return COMMENTS_DIR;
  if (url.includes("/profile-image")) return PROFILES_DIR;
  if (file.fieldname === "attachedFiles") return ATTACHED_DIR;
  return UPLOADS_DIR;
}

/** ทำชื่อไฟล์ให้ปลอดภัย */
function sanitizeName(name: string) {
  return name.normalize("NFC").replace(/[^\w.\-]+/g, "_");
}

const uploadToDisk = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const targetDir = pickTargetDir(req, file);
      fs.mkdirSync(targetDir, { recursive: true });
      cb(null, targetDir);
    },
    filename: (_req, file, cb) => {
      const safe = sanitizeName(file.originalname);
      cb(null, `${Date.now()}-${safe}`);
    },
  }),
fileFilter: (_req, file, cb) => {
  const ext = (path.extname(file.originalname || "") || "").toLowerCase();
  const mt  = (file.mimetype || "").toLowerCase();

  // อนุญาตตามสกุลไฟล์
  const ALLOWED_EXT = new Set([
    // images
    ".png", ".jpg", ".jpeg", ".gif", ".webp",
    // pdf
    ".pdf",
    // word
    ".doc", ".docx", ".rtf",
    // powerpoint
    ".ppt", ".pptx", ".pps", ".ppsx",
    // excel
    ".xls", ".xlsx", ".csv", ".ods",
  ]);

  // อนุญาตตาม MIME (บาง browser/ไคลเอนต์จะส่ง MIME เก่าๆ หรือเพี้ยน)
  const ALLOWED_MIME = new Set([
    // images
    "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
    // pdf
    "application/pdf",
    // word
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    // powerpoint
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    // excel
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv", "application/csv", "text/x-csv",
    "application/vnd.oasis.opendocument.spreadsheet",
  ]);

  // บางระบบอัปโหลด Office แล้ว MIME เป็น octet-stream -> ใช้การเช็คสกุลช่วย
  const LOOKS_LIKE_OFFICE_BY_EXT = new Set([
    ".doc", ".docx", ".rtf",
    ".ppt", ".pptx", ".pps", ".ppsx",
    ".xls", ".xlsx", ".csv", ".ods",
  ]);

  const allowed =
    ALLOWED_EXT.has(ext) ||
    ALLOWED_MIME.has(mt) ||
    (mt === "application/octet-stream" && LOOKS_LIKE_OFFICE_BY_EXT.has(ext));

  if (!allowed) {
    return cb(new Error("Only image, PDF, Word, Excel, and PowerPoint files are allowed"));
  }
  cb(null, true);
},

  limits: { fileSize: 50 * 1024 * 1024 }
});


/** สำหรับ upload เข้าหน่วยความจำ */
const uploadToMemory = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const mt  = (file.mimetype || "").toLowerCase();

    const ALLOWED_EXT = new Set([
      ".png", ".jpg", ".jpeg", ".gif", ".webp",
      ".pdf",
      ".xlsx", ".xls", ".csv", ".ods",
      ".doc", ".docx",
      // ✅ เพิ่ม PowerPoint
      ".ppt", ".pptx",
    ]);
    const ALLOWED_MIME = new Set([
      "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "text/csv", "application/csv", "text/x-csv",
      "application/vnd.oasis.opendocument.spreadsheet",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      // ✅ เพิ่ม PowerPoint
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]);

    if (ALLOWED_EXT.has(ext) || ALLOWED_MIME.has(mt)) return cb(null, true);
    cb(new Error(`Unsupported file. ext=${ext} mime=${mt}`));
  },
  limits: { fileSize: 50 * 1024 * 1024 },
});


export { uploadToDisk, uploadToMemory };


/** แปลง absolute path ใต้ UPLOADS_DIR -> path สำหรับเก็บลง DB แบบเดียวกันเสมอ
 *  ผลลัพธ์: "uploads/<subfolder>/<filename>" (ใช้ / เสมอ)
 */
export function toPublicUploadPath(absPath: string): string {
  // relative จาก UPLOADS_DIR เช่น "attached/1759....pdf"
  let rel = path.relative(UPLOADS_DIR, absPath);
  rel = rel.replace(/\\/g, "/");            // backslash -> slash
  rel = rel.replace(/^\/+/, "");            // ตัด / นำหน้า
  rel = rel.replace(/^(?:uploads\/)+/i, ""); // กันกรณีมี uploads/ ต้นทาง

  return `uploads/${rel}`;                   // สม่ำเสมอเป็น uploads/...
}

/**
 * Wrapper middleware to handle multer errors gracefully
 * Returns proper JSON error response instead of crashing
 */
export function handleUploadError(uploadMiddleware: any) {
  return (req: Request, res: Response, next: NextFunction) => {
    uploadMiddleware(req, res, (err: any) => {
      if (err) {
        // Handle multer-specific errors
        if (err instanceof multer.MulterError) {
          if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({
              message: "File size exceeds the 50MB limit",
              error: "FILE_TOO_LARGE",
            });
          }
          if (err.code === "LIMIT_FILE_COUNT") {
            return res.status(400).json({
              message: "Too many files uploaded",
              error: "TOO_MANY_FILES",
            });
          }
          return res.status(400).json({
            message: err.message || "File upload error",
            error: err.code,
          });
        }
        
        // Handle custom file filter errors (unsupported file type)
        if (err.message && err.message.includes("Only image, PDF, Word, Excel, and PowerPoint files are allowed")) {
          return res.status(400).json({
            message: "Only image, PDF, Word, Excel, and PowerPoint files are allowed",
            error: "UNSUPPORTED_FILE_TYPE",
          });
        }
        
        if (err.message && err.message.includes("Unsupported file")) {
          return res.status(400).json({
            message: "Unsupported file type. Please upload image, PDF, Word, Excel, or PowerPoint files only.",
            error: "UNSUPPORTED_FILE_TYPE",
          });
        }

        // Generic upload error
        return res.status(400).json({
          message: err.message || "File upload failed",
          error: "UPLOAD_ERROR",
        });
      }
      next();
    });
  };
}