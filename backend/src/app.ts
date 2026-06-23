/// <reference path="./types/express/index.d.ts" />

import express, { RequestHandler } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import path from "path";

import memoRoutes from "./routes/memo.routes";

import approvalLineRoutes from "./routes/approval-line.routes";
import memoStatusRoutes from "./routes/memoStatus.routes";
import notificationRoutes from "./routes/notification.routes";
import memotypeRoutes from "./routes/memotype.routes";
import userSignatureRoutes from "./routes/userSignature.route";
import memoccRoutes from "./routes/memocc.routes";
import fileRoutes from "./routes/file.routes";
import devExpiryRoutes from "./routes/dev-expiry.routes";

import LOAManagementRoutes from "./routes/loa_management.routes";


const app = express();

// ✅ กำหนด origin ที่อนุญาต
app.set("trust proxy", true);
const isProduction = process.env.NODE_ENV === "production";

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin;
  } catch {
    return origin.trim().replace(/\/$/, "");
  }
}

function readOrigins(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((origin) => origin.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map(normalizeOrigin);
}

const allowedOrigins = Array.from(new Set([
  ...readOrigins(process.env.CORS_ORIGIN),
  ...readOrigins(process.env.FRONTEND_URL),
  ...readOrigins(process.env.APP_BASE_URL),
  ...readOrigins(process.env.FRONT_BASE_URL),
  "https://e-approval.hylifeconnect.com",
  ...(!isProduction ? [
    "http://localhost:5173", // Keep for local development
    "http://localhost:3001",
  ] : []),
].map(normalizeOrigin)));
const CORS_ERROR_MESSAGE = "Not allowed by CORS";

function createCorsError(): Error {
  const error = new Error(CORS_ERROR_MESSAGE);
  (error as Error & { status?: number }).status = 403;
  return error;
}

function isApiRequest(req: express.Request): boolean {
  return req.path === "/api" || req.path.startsWith("/api/");
}

function isEmailActionRequest(req: express.Request): boolean {
  return req.method === "GET" && req.path === "/api/memos/action/email";
}

function isPublicNoOriginApiRequest(req: express.Request): boolean {
  if (req.path === "/api/health") {
    return true;
  }

  return isEmailActionRequest(req);
}

function isTrustedBrowserNoOriginRequest(req: express.Request): boolean {
  const fetchSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite === "same-origin" || fetchSite === "same-site") {
    return true;
  }

  const referer = req.get("referer");
  return Boolean(referer && allowedOrigins.includes(normalizeOrigin(referer)));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.use((req, res, next) => {
  if (
    !isProduction ||
    !isApiRequest(req) ||
    req.get("origin") ||
    isPublicNoOriginApiRequest(req) ||
    isTrustedBrowserNoOriginRequest(req)
  ) {
    return next();
  }

  res.status(403).json({
    message: CORS_ERROR_MESSAGE,
    error: "CORS_NOT_ALLOWED",
  });
});

// ✅ ใช้ dynamic CORS middleware
const corsMiddleware = cors({
  origin: function (origin, callback) {
    if (!origin) {
      return callback(null, true); // production API no-origin is filtered before CORS
    }

    if (allowedOrigins.includes(normalizeOrigin(origin))) {
      return callback(null, true);
    } else {
      return callback(createCorsError());
    }
  },
  credentials: true,
});

app.use((req, res, next) => {
  if (isEmailActionRequest(req)) {
    return next();
  }

  return corsMiddleware(req, res, next);
});



// ✅ middleware หลัก
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use("/api/secure-uploads", fileRoutes);
const viewsDist = path.resolve(__dirname, "../views");   // .../backend/dist/views
const viewsSrc  = path.resolve(process.cwd(), "views");  // .../backend/views

// เสิร์ฟไฟล์ทั้งหมดใต้ views จากทั้ง dist และ src (src เป็น fallback)
app.use("/", express.static(viewsDist));
app.use("/", express.static(viewsSrc));

// หรือจะเจาะจงโฟลเดอร์รูปอย่างเดียวก็ได้
app.use("/img", express.static(path.join(viewsDist, "img")));
app.use("/img", express.static(path.join(viewsSrc,  "img")));

// (ถ้าไม่ใช้จริง ๆ ให้ลบอันนี้ทิ้ง ป้องกันสับสน)
// app.use("/api/uploads", express.static(UPLOADS_DIR, { ... }));

// อย่าลืม: views ต้องมาหลัง /uploads
app.use("/", express.static(path.join(__dirname, "../views")));

// ✅ Routes
// /api/auth + /api/me — migrated to NestJS (removed from Express)
// /api/users (CRUD + BU/DCC access + delegation) — migrated to NestJS;
//   userSignature paths under /api/users still served by Express below
// /api/departments — migrated to NestJS (removed from Express)
// /api/types — migrated to NestJS (removed from Express)
app.use("/api/memotypes", memotypeRoutes);
app.use("/api/notifications", notificationRoutes);
app.use("/api/users", userSignatureRoutes);
app.use("/api", memoccRoutes);
app.use("/api", approvalLineRoutes);
app.use("/api", memoStatusRoutes);
app.use("/api", memoRoutes);
app.use("/api/dev", devExpiryRoutes);
// /api/cc-groups — migrated to NestJS (removed from Express)
app.use("/api", LOAManagementRoutes);
// /api/admin-logs — migrated to NestJS (removed from Express)

// ✅ Global error handler (must be last)
app.use(((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.message === CORS_ERROR_MESSAGE) {
    res.status(403).json({
      message: CORS_ERROR_MESSAGE,
      error: "CORS_NOT_ALLOWED",
    });
    return;
  }

  // Check if it's a multer/upload error that wasn't caught by the wrapper
  if (err.message && (
    err.message.includes("Only image, PDF, Word, Excel, and PowerPoint files are allowed") ||
    err.message.includes("Unsupported file")
  )) {
    res.status(400).json({
      message: "Only image, PDF, Word, Excel, and PowerPoint files are allowed",
      error: "UNSUPPORTED_FILE_TYPE",
    });
    return;
  }

  console.error("❌ Unhandled error:", err);
  res.status(500).json({ 
    message: "Internal server error",
    error: process.env.NODE_ENV === "development" ? err.message : undefined
  });
}) as express.ErrorRequestHandler);

export default app;
