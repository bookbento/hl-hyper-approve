// src/routes/file.routes.ts
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import path from "path";
import fs from "fs";
import { lookup as mimeLookup } from "mime-types";
import { PrismaClient } from "@prisma/client";

import { authenticate } from "../middlewares/auth.middleware";
import { UPLOADS_DIR } from "../middlewares/upload";
import { canAccessMemo, getUserId } from "../lib/filesec";

const prisma = new PrismaClient();
const r = Router();

/** helper: async handler -> ให้ type เป็น RequestHandler เสมอ */
const ah =
  (
    fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
  ): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/** --- Utils --- */
function stripLeadingSlashes(s: string) {
  return s.replace(/^\/+/, "");
}

/** ถ้าเป็น URL เต็ม -> ตัดเหลือ pathname, และตัด "uploads/" นำหน้าออก */
function coerceToRelative(raw: string): string {
  let s = raw.trim();
  // decode หนึ่งรอบเพื่อให้ %2F กลายเป็น '/'
  try {
    s = decodeURIComponent(s);
  } catch {}
  s = stripLeadingSlashes(s);

  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = stripLeadingSlashes(u.pathname || "");
    } catch {
      // fallback: ตัดโปรโตคอล+โดเมนแบบ regex
      s = s.replace(/^https?:\/\/[^/]+/i, "");
      s = stripLeadingSlashes(s);
    }
  }

  // normalize ให้เข้ากับโครง uploads
  // เช่น "uploads/profiles/a.png" -> "profiles/a.png"
  s = s.replace(/^uploads\//i, "");
  return s;
}

/** ปรับ path ให้ปลอดภัย (ตัด .. และ / นำหน้า) */
function normalizeRel(reqPath: string): string {
  return path.normalize(String(reqPath)).replace(/^(\.+[\\/])+|^[\\/]+/g, "");
}

/** สร้าง absolute path ใต้ UPLOADS_DIR และกัน path traversal (ไม่เรียก realpathSync กับไฟล์ที่อาจไม่อยู่) */
function resolveSafeUploadPath(relPath: string): { abs: string; rel: string } {
  const rel = normalizeRel(relPath);
  const uploadsRoot = path.resolve(UPLOADS_DIR);
  const abs = path.resolve(uploadsRoot, rel);

  // กัน traversal: abs ต้องอยู่ใต้ uploadsRoot
  const inRoot = abs === uploadsRoot || abs.startsWith(uploadsRoot + path.sep);
  if (!inRoot) {
    const err = new Error("Path traversal detected");
    (err as any).status = 400;
    throw err;
  }
  return { abs, rel };
}

// file.routes.ts

// file.routes.ts
function baseNameLower(p: string) {
  return path.basename(p).toLowerCase();
}

// ใช้ relPath จากตัว URL ที่เข้ามา (เช่น "attached/1759...pdf")
async function findMemoIdByPath(relPath: string): Promise<number | null> {
  const base = baseNameLower(relPath);
  const relFwd = relPath.replace(/\\/g, "/");         // attached/1759...pdf
  const relBack = relFwd.replace(/\//g, "\\");        // attached\1759...pdf
  const withUploadsFwd = `uploads/${relFwd}`;         // uploads/attached/...
  const withUploadsBack = `uploads\\${relBack}`;      // uploads\attached\...

  // 1) MainFile
  const mf = await prisma.mainFile.findFirst({
    where: {
      OR: [
        { fileName: { equals: base, mode: "insensitive" } },
        { filePath: { endsWith: "/" + base, mode: "insensitive" } },
        { filePath: { endsWith: "\\" + base, mode: "insensitive" } },
        { filePath: { equals: relFwd, mode: "insensitive" } },
        { filePath: { equals: relBack, mode: "insensitive" } },
        { filePath: { equals: withUploadsFwd, mode: "insensitive" } },
        { filePath: { equals: withUploadsBack, mode: "insensitive" } },
      ],
    },
    select: { memoId: true, memoTypeId: true },
  });
  if (mf?.memoId) return mf.memoId;
  if (mf && !mf.memoId) return -1; // template ของ MemoType

  // 2) AttachedFile
  const af = await prisma.attachedFile.findFirst({
    where: {
      OR: [
        { fileName: { equals: base, mode: "insensitive" } },
        { filePath:  { endsWith: "/" + base, mode: "insensitive" } },
        { filePath:  { endsWith: "\\" + base, mode: "insensitive" } },
        { filePath:  { equals: relFwd, mode: "insensitive" } },
        { filePath:  { equals: relBack, mode: "insensitive" } },
        { filePath:  { equals: withUploadsFwd, mode: "insensitive" } },
        { filePath:  { equals: withUploadsBack, mode: "insensitive" } },
      ],
    },
    select: { memoId: true },
  });
  if (af?.memoId) return af.memoId;

  // 3) CommentAttachment (url อาจเป็น rel หรือ absolute)
  const ca = await prisma.commentAttachment.findFirst({
    where: {
      OR: [
        { filename: { equals: base, mode: "insensitive" } },
        { url:      { endsWith: "/" + base, mode: "insensitive" } },
        { url:      { endsWith: "\\" + base, mode: "insensitive" } },
        { url:      { endsWith: relFwd, mode: "insensitive" } },
        { url:      { endsWith: relBack, mode: "insensitive" } },
        { url:      { endsWith: withUploadsFwd, mode: "insensitive" } },
        { url:      { endsWith: withUploadsBack, mode: "insensitive" } },
      ],
    },
    select: { comment: { select: { memoId: true } } },
  });
  if (ca?.comment?.memoId) return ca.comment.memoId;

  return null;
}

/** โฟลเดอร์พิเศษ */
async function specialFolderAllow(
  relPath: string,
  userId: number
): Promise<boolean> {
  const p = relPath.replace(/\\/g, "/");

  // 1) profiles/ — อนุญาต (ถ้าต้องการ auth-only ให้เปลี่ยนเป็น return false)
  if (p.startsWith("profiles/")) return true;

  // 2) signatures/ — เจ้าของหรือผูกกับเมโมที่เข้าถึงได้
  if (p.startsWith("signatures/")) {
    const base = baseNameLower(p);
    const sig = await prisma.userSignature.findFirst({
      where: {
        OR: [
          { path: { equals: base, mode: "insensitive" } },
          { path: { endsWith: "/" + base, mode: "insensitive" } },
        ],
      },
      select: { id: true, userId: true },
    });
    if (!sig) return false;
    if (sig.userId === userId) return true;

    const act = await prisma.memoApproverAction.findFirst({
      where: { signatureImageId: sig.id },
      select: { memoId: true },
    });
    if (act && (await canAccessMemo(prisma, userId, act.memoId))) return true;

    return false;
  }

  // 3) types/ — ผ่าน authenticate แล้วถือว่าได้ (ต้องเข้มขึ้นค่อยแก้เงื่อนไขตรงนี้)
  if (p.startsWith("types/")) return true;

  return false;
}

function sendFile(absPath: string, res: Response): void {
  const mime = mimeLookup(absPath) || "application/octet-stream";
  const fileName = path.basename(absPath);
  
  // Extract original filename from timestamp-prefixed filename
  // Format: "1234567890-originalname.ext" -> "originalname.ext"
  const originalFileName = fileName.replace(/^\d+-/, '');
  res.setHeader("Content-Type", String(mime));
  
  if (String(mime) === "application/pdf") {
    const disposition = `inline; filename="${originalFileName}"; filename*=UTF-8''${encodeURIComponent(originalFileName)}`;
    res.setHeader("Content-Disposition", disposition);
    // Add cache control headers to prevent stale caching
    res.setHeader("Cache-Control", "private, no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  } else {
    const disposition = `attachment; filename="${originalFileName}"; filename*=UTF-8''${encodeURIComponent(originalFileName)}`;
    res.setHeader("Content-Disposition", disposition);
    res.setHeader("Cache-Control", "private, max-age=60");
  }
  
  // Expose Content-Disposition header to frontend
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
  res.sendFile(absPath);
}

/**
 * ✅ ไม่ใช้ path pattern (เลี่ยง path-to-regexp)
 *   mount: app.use("/api/secure-uploads", fileRoutes);
 */
r.use(authenticate);

r.use(
  ah(async (req: Request, res: Response): Promise<void> => {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).json({ error: "Method Not Allowed" });
      return;
    }

    // ตัวอย่าง: /api/secure-uploads/https://host/uploads/a/b.pdf
    // -> req.path = "/https://host/uploads/a/b.pdf"
    const rawTail = stripLeadingSlashes(String(req.path || ""));
    const coerced = coerceToRelative(rawTail); // <<— ตัดโปรโตคอล/โดเมน และ "uploads/" ออก
    
    console.log(`[FileServe] Raw path: ${rawTail}`);
    console.log(`[FileServe] Coerced path: ${coerced}`);
    
    if (!coerced) {
      console.log(`[FileServe] Missing path - 400`);
      res.status(400).json({ error: "Missing path" });
      return;
    }

    const { abs, rel } = resolveSafeUploadPath(coerced);
    console.log(`[FileServe] Resolved - abs: ${abs}, rel: ${rel}`);

    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      console.log(`[FileServe] File not found - 404: ${abs}`);
      res.status(404).json({ error: "File not found" });
      return;
    }

    const userId = getUserId(req);
    console.log(`[FileServe] User ID: ${userId}`);

    // โฟลเดอร์พิเศษก่อน
    if (await specialFolderAllow(rel, userId)) {
      console.log(`[FileServe] Special folder allowed: ${rel}`);
      sendFile(abs, res);
      return;
    }

    // ตรวจสิทธิ์ผ่าน memoId
    const memoId = await findMemoIdByPath(rel);
    console.log(`[FileServe] Found memoId: ${memoId} for path: ${rel}`);

    if (memoId === -1) {
      // template ของ MemoType (ไม่มี memoId) — แค่ auth ก็พอ
      console.log(`[FileServe] Template file - allowing`);
      sendFile(abs, res);
      return;
    }

    if (!memoId) {
      console.log(`[FileServe] No memoId found - 403`);
      res.status(403).json({ error: "Access denied: unknown file mapping" });
      return;
    }

    const ok = await canAccessMemo(prisma, userId, memoId);
    console.log(`[FileServe] Access check for memo ${memoId}: ${ok}`);
    
    if (!ok) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    console.log(`[FileServe] Serving file: ${abs}`);
    sendFile(abs, res);
  })
);

export default r;
