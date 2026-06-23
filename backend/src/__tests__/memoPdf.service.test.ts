/**
 * Unit tests for memoPdf.service.ts (Wave 10)
 *
 * Strategy: vi.mock all I/O (prisma, pdf.core, fs, memoAccess, filesec, upload, filename)
 * — no real DB, disk, or PDF operations.
 *
 * Scenarios covered:
 *   uploadMainPDF       — creates mainFile record, returns 201
 *   saveSignaturePosition — creates record, returns 201
 *   saveDatePosition    — creates record with Date conversion, returns 201
 *   saveNotePosition    — creates record, returns 201
 *   downloadMergedPdf   — 403 when canViewMemo=false, 404 when pdf.core throws 404,
 *                         500 on unknown error, 200 with PDF bytes on success,
 *                         recall+no-actions edge case returns merged PDF early
 *   downloadRawPdf      — 400 on invalid memoId, 403 on access denied,
 *                         404 when no files, 200 with merged bytes on success,
 *                         500 on read error
 *   getMainFilePdf      — 400 on invalid memoId, 400 on invalid fileId,
 *                         403 on access denied, 404 when DB returns null,
 *                         404 when file missing on disk, 200 sends file
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response } from "express";

// ── All mocks BEFORE imports (vi.mock is hoisted) ─────────────────────────────

vi.mock("../../prisma/client", () => ({
  prisma: {
    mainFile: {
      create: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
    },
    signaturePosition: { create: vi.fn() },
    datePosition: { create: vi.fn() },
    notePosition: { create: vi.fn() },
    masterMemo: { findUnique: vi.fn() },
    memoStatusPivot: { findFirst: vi.fn() },
    memoApproverAction: { findMany: vi.fn() },
  },
}));

vi.mock("../services/memoAccess.service", () => ({
  canViewMemo: vi.fn(),
}));

vi.mock("../lib/filesec", () => ({
  getUserId: vi.fn(),
}));

vi.mock("../services/pdf.core", () => ({
  createPdfForDownload: vi.fn(),
}));

vi.mock("../middlewares/upload", () => ({
  UPLOADS_DIR: "/mock/uploads",
  toPublicUploadPath: vi.fn((p: string) => p),
}));

vi.mock("../lib/filename", () => ({
  decodeFilename: vi.fn((s: string) => s),
  safeFileName: vi.fn((s: string) => s),
}));

vi.mock("pdf-lib", () => ({
  PDFDocument: {
    create: vi.fn(),
    load: vi.fn(),
  },
}));

vi.mock("fs", () => ({
  default: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  },
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("content-disposition", () => ({
  default: vi.fn((filename: string, opts?: object) => `attachment; filename="${filename}"`),
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

import { prisma } from "../../prisma/client";
import { canViewMemo } from "../services/memoAccess.service";
import { getUserId } from "../lib/filesec";
import { createPdfForDownload } from "../services/pdf.core";
import fs from "fs";
import { PDFDocument } from "pdf-lib";

import {
  uploadMainPDF,
  saveSignaturePosition,
  saveDatePosition,
  saveNotePosition,
  downloadMergedPdf,
  downloadRawPdf,
  getMainFilePdf,
} from "../services/memoPdf.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: {},
    query: {},
    body: {},
    file: undefined,
    user: { id: 1 },
    headers: {},
    ...overrides,
  } as unknown as Request;
}

function makeRes(): Response {
  const json = vi.fn().mockReturnThis();
  const status = vi.fn().mockReturnThis();
  const header = vi.fn().mockReturnThis();
  const set = vi.fn().mockReturnThis();
  const send = vi.fn().mockReturnThis();
  const sendFile = vi.fn().mockImplementation((_path, cb?: Function) => {
    cb && cb(null);
    return res;
  });
  const res = { json, status, header, set, send, sendFile } as unknown as Response;
  return res;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("uploadMainPDF", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a mainFile record and returns 201", async () => {
    const created = { id: 1, memoId: 5, filePath: "upload/x.pdf" };
    (prisma.mainFile.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const req = makeReq({
      params: { id: "5" },
      file: { path: "upload/x.pdf", originalname: "test.pdf", size: 1024 } as Express.Multer.File,
    });
    const res = makeRes();

    await uploadMainPDF(req, res, vi.fn());

    expect(prisma.mainFile.create).toHaveBeenCalledWith({
      data: {
        memoId: 5,
        filePath: "upload/x.pdf",
        fileName: "test.pdf",
        size: 1024,
      },
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(created);
  });
});

describe("saveSignaturePosition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates signature position and returns 201", async () => {
    const created = { id: 10 };
    (prisma.signaturePosition.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const req = makeReq({
      body: { memoId: 1, fileId: 2, userId: 3, page: 1, x: 50, y: 60 },
    });
    const res = makeRes();

    await saveSignaturePosition(req, res, vi.fn());

    expect(prisma.signaturePosition.create).toHaveBeenCalledWith({
      data: { memoId: 1, fileId: 2, userId: 3, page: 1, x: 50, y: 60 },
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(created);
  });
});

describe("saveDatePosition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates date position with Date conversion and returns 201", async () => {
    const created = { id: 20 };
    (prisma.datePosition.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const dateStr = "2025-01-15";
    const req = makeReq({
      body: { memoId: 1, fileId: 2, userId: 3, page: 1, x: 10, y: 20, date: dateStr },
    });
    const res = makeRes();

    await saveDatePosition(req, res, vi.fn());

    const call = (prisma.datePosition.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.date).toBeInstanceOf(Date);
    expect(call.data.date.toISOString()).toContain("2025-01-15");
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe("saveNotePosition", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates note position and returns 201", async () => {
    const created = { id: 30 };
    (prisma.notePosition.create as ReturnType<typeof vi.fn>).mockResolvedValue(created);

    const req = makeReq({
      body: { memoId: 1, fileId: 2, page: 1, x: 5, y: 5, text: "hello" },
    });
    const res = makeRes();

    await saveNotePosition(req, res, vi.fn());

    expect(prisma.notePosition.create).toHaveBeenCalledWith({
      data: { memoId: 1, fileId: 2, page: 1, x: 5, y: 5, text: "hello" },
    });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith(created);
  });
});

describe("downloadMergedPdf", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 when canViewMemo returns false", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const req = makeReq({ params: { id: "7" }, query: {} });
    const res = makeRes();

    await downloadMergedPdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Access denied" });
  });

  it("returns 401 when getUserId throws", async () => {
    const err: any = new Error("no token");
    err.status = 401;
    (getUserId as ReturnType<typeof vi.fn>).mockImplementation(() => { throw err; });

    const req = makeReq({ params: { id: "7" }, query: {} });
    const res = makeRes();

    await downloadMergedPdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("returns 404 when createPdfForDownload throws status 404", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const err: any = new Error("No main PDF files found");
    err.status = 404;
    (createPdfForDownload as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const req = makeReq({ params: { id: "7" }, query: {} });
    const res = makeRes();

    await downloadMergedPdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });

  it("returns 500 on unexpected error from createPdfForDownload", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (createPdfForDownload as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));

    const req = makeReq({ params: { id: "7" }, query: {} });
    const res = makeRes();

    await downloadMergedPdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("sends PDF bytes with correct content-type on success", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const fakeBytes = new Uint8Array([1, 2, 3]);
    const fakePdf = { save: vi.fn().mockResolvedValue(fakeBytes) };
    (createPdfForDownload as ReturnType<typeof vi.fn>).mockResolvedValue(fakePdf);

    (prisma.masterMemo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      memonumber: "M001",
      subject: "Test",
    });
    (prisma.memoStatusPivot.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = makeReq({ params: { id: "7" }, query: {} });
    const res = makeRes();

    await downloadMergedPdf(req, res, vi.fn());

    expect(res.header).toHaveBeenCalledWith("Content-Type", "application/pdf");
    expect(res.send).toHaveBeenCalledWith(Buffer.from(fakeBytes));
  });

  it("sends early PDF when recall exists but no approved actions after recall", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);

    const fakeBytes = new Uint8Array([9, 8, 7]);
    const fakePdf = { save: vi.fn().mockResolvedValue(fakeBytes) };
    (createPdfForDownload as ReturnType<typeof vi.fn>).mockResolvedValue(fakePdf);

    (prisma.masterMemo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      memonumber: "M001",
      subject: "Test",
    });
    // recall exists
    (prisma.memoStatusPivot.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      createdAt: new Date("2025-01-01"),
    });
    // no approved actions after recall
    (prisma.memoApproverAction.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const req = makeReq({ params: { id: "7" }, query: {} });
    const res = makeRes();

    await downloadMergedPdf(req, res, vi.fn());

    expect(res.send).toHaveBeenCalledWith(Buffer.from(fakeBytes));
  });
});

describe("downloadRawPdf", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for invalid memoId", async () => {
    const req = makeReq({ params: { id: "abc" }, query: {} });
    const res = makeRes();

    await downloadRawPdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid memoId" });
  });

  it("returns 403 when access denied", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const req = makeReq({ params: { id: "5" }, query: {} });
    const res = makeRes();

    await downloadRawPdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 404 when no files found", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (prisma.masterMemo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.mainFile.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const req = makeReq({ params: { id: "5" }, query: {} });
    const res = makeRes();

    await downloadRawPdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "No files found for this memo" });
  });

  it("sends merged PDF bytes on success", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (prisma.masterMemo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      memonumber: "M002",
      subject: "Raw",
    });
    (prisma.mainFile.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { id: 1, filePath: "/mock/uploads/a.pdf" },
    ]);

    const rawBytes = new Uint8Array([10, 20, 30]);
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from(rawBytes));

    const fakeDoc = {
      getPageIndices: vi.fn().mockReturnValue([0]),
    };
    const fakeMerged = {
      copyPages: vi.fn().mockResolvedValue([{}]),
      addPage: vi.fn(),
      save: vi.fn().mockResolvedValue(new Uint8Array([99, 98, 97])),
    };

    (PDFDocument.create as ReturnType<typeof vi.fn>).mockResolvedValue(fakeMerged);
    (PDFDocument.load as ReturnType<typeof vi.fn>).mockResolvedValue(fakeDoc);

    const req = makeReq({ params: { id: "5" }, query: {} });
    const res = makeRes();

    await downloadRawPdf(req, res, vi.fn());

    // Should call copyPages + addPage, then save
    expect(PDFDocument.create).toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({ "Content-Type": "application/pdf" })
    );
    expect(res.send).toHaveBeenCalled();
  });

  it("returns 500 on unexpected error", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (prisma.masterMemo.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.mainFile.findMany as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("DB down"));

    const req = makeReq({ params: { id: "5" }, query: {} });
    const res = makeRes();

    await downloadRawPdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe("getMainFilePdf", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 400 for invalid memoId", async () => {
    const req = makeReq({ params: { id: "abc" }, query: {} });
    const res = makeRes();

    await getMainFilePdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid memoId" });
  });

  it("returns 400 for invalid fileId", async () => {
    const req = makeReq({ params: { id: "5" }, query: { fileId: "xyz" } });
    const res = makeRes();

    await getMainFilePdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid fileId" });
  });

  it("returns 403 when canViewMemo returns false", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const req = makeReq({ params: { id: "5" }, query: {} });
    const res = makeRes();

    await getMainFilePdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("returns 404 when DB returns no file", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (prisma.mainFile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const req = makeReq({ params: { id: "5" }, query: {} });
    const res = makeRes();

    await getMainFilePdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "File not found" });
  });

  it("returns 404 when file missing on disk", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (prisma.mainFile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      filePath: "/mock/uploads/doc.pdf",
      fileName: "doc.pdf",
    });
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const req = makeReq({ params: { id: "5" }, query: {} });
    const res = makeRes();

    await getMainFilePdf(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "File missing on disk" });
  });

  it("calls sendFile with the absolute path when file exists", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (prisma.mainFile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 1,
      filePath: "/mock/uploads/doc.pdf",
      fileName: "doc.pdf",
    });
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const req = makeReq({ params: { id: "5" }, query: {} });
    const res = makeRes();

    await getMainFilePdf(req, res, vi.fn());

    expect(res.header).toHaveBeenCalledWith("Content-Type", "application/pdf");
    expect(res.sendFile).toHaveBeenCalled();
  });

  it("selects specific file when fileId query param is provided", async () => {
    (getUserId as ReturnType<typeof vi.fn>).mockReturnValue(1);
    (canViewMemo as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    (prisma.mainFile.findFirst as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 3,
      filePath: "/mock/uploads/specific.pdf",
      fileName: "specific.pdf",
    });
    (fs.existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);

    const req = makeReq({ params: { id: "5" }, query: { fileId: "3" } });
    const res = makeRes();

    await getMainFilePdf(req, res, vi.fn());

    expect(prisma.mainFile.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ memoId: 5, id: 3 }),
      })
    );
  });
});
