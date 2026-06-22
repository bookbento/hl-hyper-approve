// src/routes/dev-expiry.routes.ts
import { Router, type Request, type Response, type NextFunction } from "express";
import { prisma } from "../../prisma/client";
import { sweepMemoExpiryOnce } from "../lib/memo-expiry";

const r = Router();

// helper: แปลง async fn -> RequestHandler
const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) =>
  (req: Request, res: Response, next: NextFunction) =>
    fn(req, res, next).catch(next);

r.post(
  "/expiry/set/:memoId",
  wrap(async (req, res) => {
    const memoId = Number(req.params.memoId);
    const mode = String(req.body?.mode || "expired");
    const date = req.body?.date as string | undefined;

    const today = new Date();
    let expiresAt: Date;
    if (mode === "3d") {
      expiresAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 3, 23, 59, 59, 999));
    } else if (mode === "date" && date) {
      const [y, m, d] = date.split("-").map(Number);
      expiresAt = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
    } else {
      expiresAt = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1, 23, 59, 59, 999));
    }

    await prisma.masterMemo.update({ where: { id: memoId }, data: { expiresAt } });
    res.json({ ok: true, memoId, expiresAt });
  })
);

r.post(
  "/expiry/run",
  wrap(async (req, res) => {
    const pretendNow = req.body?.pretendNow as string | undefined;
    await sweepMemoExpiryOnce(pretendNow ? new Date(pretendNow) : new Date());
    res.json({ ok: true });
  })
);

r.post(
  "/expiry/reset/:memoId",
  wrap(async (req, res) => {
    const memoId = Number(req.params.memoId);
    await prisma.memoHistory.deleteMany({ where: { memoId, action: { contains: "[expiry:" } } });
    res.json({ ok: true });
  })
);

export default r;
