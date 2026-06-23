// src/services/memoPdf.service.ts
//
// Wave 10 — PDF handler layer extracted from memo.controller.ts.
// Each function is a thin Express RequestHandler that delegates heavy
// lifting to pdf.core.ts (createPdfForDownload) and prisma.
// No new business logic is introduced here.

import { RequestHandler } from "express";
import { PDFDocument } from "pdf-lib";
import fs from "fs";
import path from "path";
import contentDisposition from "content-disposition";
import { prisma } from "../../prisma/client";
import { decodeFilename } from "../lib/filename";
import { getUserId } from "../lib/filesec";
import { canViewMemo } from "./memoAccess.service";
import { createPdfForDownload } from "./pdf.core";
import { UPLOADS_DIR } from "../middlewares/upload";

// ---------------------------------------------------------------------------
// uploadMainPDF
// POST /api/memos/:id/upload-main
// ---------------------------------------------------------------------------
export const uploadMainPDF: RequestHandler = async (req, res) => {
  const memoId = +req.params.id;
  const file = req.file!;
  const newFile = await prisma.mainFile.create({
    data: {
      memoId,
      filePath: file.path,
      fileName: decodeFilename(file.originalname),
      size: file.size,
    },
  });
  res.status(201).json(newFile);
};

// ---------------------------------------------------------------------------
// saveSignaturePosition
// POST /api/memos/signature
// ---------------------------------------------------------------------------
export const saveSignaturePosition: RequestHandler = async (req, res) => {
  const { memoId, fileId, userId, page, x, y } = req.body;
  const s = await prisma.signaturePosition.create({
    data: { memoId, fileId, userId, page, x, y },
  });
  res.status(201).json(s);
};

// ---------------------------------------------------------------------------
// saveDatePosition
// POST /api/memos/date
// ---------------------------------------------------------------------------
export const saveDatePosition: RequestHandler = async (req, res) => {
  const { memoId, fileId, userId, page, x, y, date } = req.body;
  const d = await prisma.datePosition.create({
    data: {
      memoId,
      fileId,
      userId,
      page,
      x,
      y,
      date: new Date(date),
    },
  });
  res.status(201).json(d);
};

// ---------------------------------------------------------------------------
// saveNotePosition
// POST /api/memos/note
// ---------------------------------------------------------------------------
export const saveNotePosition: RequestHandler = async (req, res) => {
  const { memoId, fileId, page, x, y, text } = req.body;
  const n = await prisma.notePosition.create({
    data: {
      memoId,
      fileId,
      page,
      x,
      y,
      text,
    },
  });
  res.status(201).json(n);
};

// ---------------------------------------------------------------------------
// downloadMergedPdf
// GET /api/memos/:id/pdf/merged  (also GET /api/memos/:id/download)
// ---------------------------------------------------------------------------
export const downloadMergedPdf: RequestHandler = async (req, res) => {
  const memoId = +req.params.id;
  const showDraft = String(req.query.preview ?? "") === "1";
  const forceInline = String(req.query.inline ?? "") === "1";

  // Access check
  try {
    const userId = getUserId(req);
    const ok = await canViewMemo(userId, memoId);
    if (!ok) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } catch (e: any) {
    res.status(e?.status || 401).json({ error: e?.message });
    return;
  }

  // Generate merged PDF
  let merged: Awaited<ReturnType<typeof createPdfForDownload>>;
  try {
    merged = await createPdfForDownload(memoId, showDraft);
  } catch (err: any) {
    if (
      err?.status === 404 ||
      err?.message?.includes("No main PDF files found")
    ) {
      res
        .status(404)
        .json({
          error:
            "ไม่พบไฟล์ PDF สำหรับบันทึกข้อความนี้ (ไฟล์อาจถูกลบออกจากระบบ)",
        });
      return;
    }
    console.error("downloadMergedPdf failed:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
    return;
  }

  // Build filename
  const memoRow = await prisma.masterMemo.findUnique({
    where: { id: memoId },
  });

  const baseRaw =
    memoRow?.memonumber && memoRow?.subject
      ? `${memoRow.memonumber}-${memoRow.subject}`
      : `memo-${memoId}`;
  const safeBase = baseRaw.replace(/[\r\n]/g, " ").trim();

  const isInline = showDraft || forceInline;
  const cd = contentDisposition(`${safeBase}.pdf`, {
    type: isInline ? "inline" : "attachment",
  });

  // Handle recall-with-no-actions edge case
  const lastRecall = await prisma.memoStatusPivot.findFirst({
    where: { memoId, statusId: { in: [6] } },
    orderBy: { createdAt: "desc" },
  });

  if (lastRecall && !showDraft) {
    const actions = await prisma.memoApproverAction.findMany({
      where: {
        memoId,
        status: { code: "approved" },
        actedAt: { gte: lastRecall.createdAt },
      },
    });

    if (actions.length === 0) {
      const out = await merged.save();
      res
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", cd)
        .send(Buffer.from(out));
      return;
    }
  }

  const outBytes = await merged.save();
  res
    .header("Content-Type", "application/pdf")
    .header("Content-Disposition", cd)
    .send(Buffer.from(outBytes));
};

// ---------------------------------------------------------------------------
// downloadRawPdf
// GET /api/memos/:id/raw
// Returns the plain merged PDF without any overlaid signatures.
// ---------------------------------------------------------------------------
export const downloadRawPdf: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);

  if (Number.isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memoId" });
    return;
  }

  // Access check
  try {
    const userId = getUserId(req);
    const ok = await canViewMemo(userId, memoId);
    if (!ok) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } catch (e: any) {
    res.status(e?.status || 401).json({ error: e?.message });
    return;
  }

  try {
    const meta = await prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { memonumber: true, subject: true },
    });

    const files = await prisma.mainFile.findMany({
      where: { memoId },
      orderBy: { orderNo: "asc" },
    });

    if (!files.length) {
      res.status(404).json({ error: "No files found for this memo" });
      return;
    }

    const merged = await PDFDocument.create();
    for (const f of files) {
      const srcBytes = fs.readFileSync(path.resolve(f.filePath));
      const srcDoc = await PDFDocument.load(srcBytes, {
        ignoreEncryption: true,
      });
      const pages = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }

    const bytes = await merged.save();

    const baseName = meta
      ? `${meta.memonumber}-${meta.subject}`
      : `Memo_${memoId}`;

    const safeBase = baseName
      .replace(/[\r\n]/g, " ")
      .replace(/[\/\\?%*:|"<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);

    const fileName = `${safeBase}.pdf`;

    res
      .set({
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(
          fileName,
        )}`,
        "Content-Length": bytes.length.toString(),
      })
      .send(Buffer.from(bytes));
  } catch (err) {
    console.error("downloadRawPdf failed", err);
    res.status(500).json({ error: "Failed to generate raw PDF" });
  }
};

// ---------------------------------------------------------------------------
// getMainFilePdf
// GET /api/memos/:id/pdf?fileId=…
// Streams the raw uploaded file (no overlays) directly via sendFile.
// ---------------------------------------------------------------------------
export const getMainFilePdf: RequestHandler = async (req, res) => {
  const memoId = Number(req.params.id);
  const raw = req.query.fileId as string | undefined;
  const fileId = raw ? Number(raw) : undefined;

  if (isNaN(memoId)) {
    res.status(400).json({ error: "Invalid memoId" });
    return;
  }
  if (raw && isNaN(fileId!)) {
    res.status(400).json({ error: "Invalid fileId" });
    return;
  }

  // Access check
  try {
    const userId = getUserId(req);
    const ok = await canViewMemo(userId, memoId);
    if (!ok) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
  } catch (e: any) {
    res.status(e?.status || 401).json({ error: e?.message });
    return;
  }

  try {
    let target:
      | { id: number; filePath: string; fileName: string | null }
      | null
      | undefined;

    if (fileId !== undefined) {
      target = await prisma.mainFile.findFirst({
        where: { memoId, id: fileId },
        select: { id: true, filePath: true, fileName: true },
      });
    } else {
      target = await prisma.mainFile.findFirst({
        where: { memoId },
        orderBy: { orderNo: "asc" },
        select: { id: true, filePath: true, fileName: true },
      });
    }

    if (!target) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    const absolutePath = path.join(UPLOADS_DIR, path.basename(target.filePath));
    if (!fs.existsSync(absolutePath)) {
      res.status(404).json({ error: "File missing on disk" });
      return;
    }

    // Defense-in-depth: validate the resolved file stays within UPLOADS_DIR.
    // path.basename() above already strips traversal segments; this guards
    // against any future change that builds the path differently.
    const resolvedPath = path.resolve(absolutePath);
    const resolvedUploads = path.resolve(UPLOADS_DIR);
    if (!resolvedPath.startsWith(resolvedUploads + path.sep)) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    const cd = contentDisposition(target.fileName || `memo-${memoId}.pdf`, {
      type: "inline",
      fallback: false,
    });

    res
      .header("Content-Type", "application/pdf")
      .header("Access-Control-Expose-Headers", "Content-Disposition")
      .header("Content-Disposition", cd)
      .sendFile(resolvedPath);
  } catch (err) {
    console.error("getMainFilePdf failed:", err);
    res.status(500).json({ error: "Failed to fetch PDF" });
  }
};
