// src/middlewares/auth.middleware.ts
import { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { AuthenticatedRequest } from "../types/request";
import { prisma } from "../../prisma/client";

/* -------------------- 1) AUTHENTICATE -------------------- */
export const authenticate: RequestHandler = async (req, res, next) => {
  const authReq = req as AuthenticatedRequest;

  const token =
    authReq.cookies?.refreshToken ||
    authReq.headers.authorization?.split(" ")[1];

  if (!token) {
    res.status(401).json({ error: "No token provided" });
    return;
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      id: number;
      name: string;
      role: string;
      businessUnitId: number;
      teamId: number;
    };

    // Check if the user account has been archived (soft-deleted)
    const user = await prisma.user.findUnique({
      where: { id: decoded.id },
      select: { deletedAt: true },
    });

    if (!user || user.deletedAt) {
      res.clearCookie("refreshToken");
      res.status(403).json({ error: "ACCOUNT_ARCHIVED" });
      return;
    }

    authReq.user = decoded;
    next();
  } catch {
    res.status(403).json({ error: "ข้อมูลคนอื่นอย่าแอบดูสิจ๊ะ" });
    return ;
  }
};

/* -------------------- 2) AUTHORIZE -------------------- */
/**
 * อนุญาตเฉพาะ
 *   - เจ้าของ resource (param :id)
 *   - หรือ role === "admin"
 * ใช้คู่กับ authenticate เสมอ
 */
export const authorizeSelfOrAdmin: RequestHandler = (req, res, next) => {
  const user = (req as AuthenticatedRequest).user;
  if (!user) {
    res.sendStatus(401);
    return ;
  }

  const paramId = Number(req.params.id);
  const isSelf = user.id === paramId;
  const isAdmin = user.role.toLowerCase() === "admin";

   isSelf || isAdmin ? next() : res.sendStatus(403);
   return ;
};
/* -------------------- 3) AUTHORIZE: admin only -------------------- */
export const authorizeAdmin: RequestHandler = (req, res, next) => {
  const user = (req as AuthenticatedRequest).user;

  if (!user) {
    res.sendStatus(401);
    return;
  }

  const role = (user.role || "").toLowerCase();
  if (role !== "admin") {
    res.sendStatus(403);
    return;
  }

  next();
};

/* -------------------- 4) AUTHORIZE: admin หรือ dcc -------------------- */
export const authorizeAdminOrDcc: RequestHandler = (req, res, next) => {
  const user = (req as AuthenticatedRequest).user;

  if (!user) {
    res.sendStatus(401); // ยังไม่ล็อกอิน / ไม่มี token
    return;
  }

  const role = (user.role || "").toLowerCase();
  const isAllowed = role === "admin" || role === "dcc";

  if (!isAllowed) {
    res.sendStatus(403); // มี token แต่สิทธิ์ไม่พอ
    return;
  }

  next();
};

/* -------------------- 5) AUTHORIZE: admin logs read access -------------------- */
const dccReadableAdminLogModules = new Set(["MEMO_TYPE", "CC_GROUP", "LOA"]);

export const authorizeAdminLogRead: RequestHandler = (req, res, next) => {
  const user = (req as AuthenticatedRequest).user;

  if (!user) {
    res.sendStatus(401);
    return;
  }

  const role = (user.role || "").toLowerCase();
  if (role === "admin") {
    next();
    return;
  }

  if (role !== "dcc") {
    res.sendStatus(403);
    return;
  }

  const module = String(req.query.module ?? "").toUpperCase();
  if (!dccReadableAdminLogModules.has(module)) {
    res.sendStatus(403);
    return;
  }

  next();
};
