import { Router, Request, Response, NextFunction } from "express";
import { prisma } from "../../prisma/client";

const router = Router();

// GET /api/types
router.get("/", async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const types = await prisma.memoType.findMany()
    res.json(types);
  } catch (err) {
    next(err);
  }
});

export default router;
