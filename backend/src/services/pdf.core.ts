// src/services/pdf.core.ts
import { PDFDocument, PDFPage, PDFArray, PDFName, rgb, StandardFonts, degrees as pdfDegrees } from "pdf-lib";
import fs from "fs";
import path from "path";
// @ts-ignore
import fontkit from "fontkit";
import { prisma } from "../../prisma/client";
import { UPLOADS_DIR } from "../middlewares/upload";
import sharp from "sharp";

/* ================================================================
 * TYPES
 * ================================================================ */
type ViewBox = { x: number; y: number; width: number; height: number };
type InkBBoxX = { minX: number; maxX: number; width: number; center: number };
type DrawBox = { x: number; y: number; w: number; h: number };

type RenderMode = "final" | "preview";

interface RenderOptions {
  memoId: number;
  mode: RenderMode; // "final" = approved only, "preview" = show draft
}

interface UserAction {
  userId: number;
  level: number;
  statusCode: string;
  signatureImageId: number | null;
  signatureText: string | null;
  actedAt: Date | null;
}

/* ================================================================
 * CONSTANTS
 * ================================================================ */
const STAMP_PT = 5;
const A4_WIDTH_PT = 595.28; // Reference page width for proportional scaling

// Font sizes per paper size & orientation (base values ก่อนคูณ pgScale)
// ขนาดจริง = FONT_PT × pgScale × sizePct%
// ปรับ fine-tune แต่ละ paper size ได้ที่นี่
const FONT_PT = {
  A4_PORTRAIT:  { SIGN: 16, DATE: 12, MEMONUM: 14, NOTE: 12 },
  A4_LANDSCAPE: { SIGN: 16, DATE: 12, MEMONUM: 14, NOTE: 12 },
  A3_PORTRAIT:  { SIGN: 16, DATE: 12, MEMONUM: 14, NOTE: 12 },
  A3_LANDSCAPE: { SIGN: 16, DATE: 12, MEMONUM: 14, NOTE: 12 },
} as const;

type FontPtKey = keyof typeof FONT_PT;
type FontField = "SIGN" | "DATE" | "MEMONUM" | "NOTE";

// Nudge offsets
const SIG_X_NUDGE_AT_BASE = -1.5;
// Signature X landscape
const SIG_X_NUDGE_A4_LANDSCAPE = 0.0;    // X signature A4 landscape  ← ปรับตรงนี้
const SIG_X_NUDGE_A3_LANDSCAPE = 0.0;    // X signature A3 landscape  ← ปรับตรงนี้
// Date X
const DATE_X_NUDGE_A4_PORTRAIT  = -10;   // X date A4 portrait         ← ปรับตรงนี้
const DATE_X_NUDGE_A4_LANDSCAPE = -8.5;   // X date A4 landscape        ← ปรับตรงนี้
const DATE_X_NUDGE_A3_PORTRAIT  = -8.0;  // X date A3 portrait         ← ปรับตรงนี้
const DATE_X_NUDGE_A3_LANDSCAPE = -6.0;  // X date A3 landscape        ← ปรับตรงนี้
const DATE_Y_NUDGE_AT_BASE = 1;
const MEMONUM_X_NUDGE_AT_BASE = -2.5;
const MEMONUM_Y_NUDGE_AT_BASE = 2.5;
const NOTE_X_NUDGE_AT_BASE = -2.5;
const NOTE_Y_NUDGE_AT_BASE = 2;
// Signature Y
const SIG_Y_NUDGE_A4_PORTRAIT   = 0.0;  // Y signature A4 portrait    ← ปรับตรงนี้
const SIG_Y_NUDGE_A4_LANDSCAPE  = 1.0;  // Y signature A4 landscape   ← ปรับตรงนี้
const SIG_Y_NUDGE_A3_PORTRAIT   = 0.0;  // Y signature A3 portrait    ← ปรับตรงนี้
const SIG_Y_NUDGE_A3_LANDSCAPE  = 0.0;  // Y signature A3 landscape   ← ปรับตรงนี้
// Date Y
const DATE_Y_NUDGE_A4_PORTRAIT  = -3.0;  // Y date A4 portrait         ← ปรับตรงนี้
const DATE_Y_NUDGE_A4_LANDSCAPE = -3.5;  // Y date A4 landscape        ← ปรับตรงนี้
const DATE_Y_NUDGE_A3_PORTRAIT  = 0.0;  // Y date A3 portrait         ← ปรับตรงนี้
const DATE_Y_NUDGE_A3_LANDSCAPE = -1.5;  // Y date A3 landscape        ← ปรับตรงนี้

// Colors
const rgb255 = (r: number, g: number, b: number) => rgb(r / 255, g / 255, b / 255);
const BLACK = rgb(0, 0, 0);
const BG_NAME = rgb255(238, 229, 255); // ม่วงอ่อน
const BG_DATE = rgb255(225, 240, 255); // ฟ้าอ่อน
const TEXT_NAME = rgb255(109, 40, 217); // ม่วง
const TEXT_DATE = rgb255(37, 99, 235); // ฟ้า
const STAMP_COLOR = rgb255(100, 116, 139);
const BG_OPACITY = 0.6;

/* ================================================================
 * HELPER FUNCTIONS
 * ================================================================ */
const cleanText = (s: string) => (s ?? "").normalize("NFKC").replace(/\s+/g, " ").trim();

const safeIsoDate = (v: unknown) => {
  if (v === null || v === undefined) return "";
  const d = new Date(v as any);
  return isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

const makeSignLabel = (u: {
  name?: string | null;
  lastname?: string | null;
  nickname?: string | null;
}) => {
  const base = [u?.name, u?.lastname].filter(Boolean).join(" ").trim();
  const s = u?.nickname ? `${base} (${u.nickname})` : base || (u?.name ?? "");
  return cleanText(s);
};

const tryMakeFontkitFont = (fontPath: string, bytes: Uint8Array) => {
  try {
    const fk: any = fontkit as any;
    if (typeof fk.openSync === "function") return fk.openSync(fontPath);
    if (typeof fk.create === "function") return fk.create(bytes);
  } catch { }
  return null;
};

const getViewBox = (page: PDFPage): ViewBox => {
  const p: any = page as any;

  const norm = (b: any): ViewBox | null => {
    if (!b) return null;
    const x = Number(b.x ?? 0);
    const y = Number(b.y ?? 0);
    const w = Number(b.width ?? b.w ?? 0);
    const h = Number(b.height ?? b.h ?? 0);
    if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
    return { x, y, width: w, height: h };
  };

  try {
    const crop = typeof p.getCropBox === "function" ? norm(p.getCropBox()) : null;
    if (crop) return crop;
  } catch { }

  try {
    const media = typeof p.getMediaBox === "function" ? norm(p.getMediaBox()) : null;
    if (media) return media;
  } catch { }

  const { width, height } = page.getSize();
  return { x: 0, y: 0, width, height };
};

// ดึงค่า rotation (0/90/180/270) จาก PDF page
const getPageRotation = (page: PDFPage): number => {
  try {
    return page.getRotation().angle;
  } catch {
    return 0;
  }
};

// Scale factor: อิงจาก visual width ของหน้า ÷ A4 width
// Frontend ใช้ canvasCssW / 595.28 เป็น reference เดียวกันทุกหน้า
// และ react-pdf render ทุกหน้าที่ width={containerWidth} เท่ากัน
// ดังนั้น marker PDF equivalent = effectivePt * (pageWidthPt / 595.28)
// A4 Portrait=1.0, A4 Landscape≈1.414, A3 Portrait≈1.414, A3 Landscape≈2.0
const pageScaleFactor = (page: PDFPage): number => {
  const b = getViewBox(page);
  return b.width / A4_WIDTH_PT;
};

// ตรวจว่าหน้าเป็น A3 (ด้านสั้น > 700pt) หรือไม่ — ใช้แยก paper size โดยไม่ขึ้นกับ orientation
const isA3Paper = (page: PDFPage): boolean => {
  const b = getViewBox(page);
  return Math.min(b.width, b.height) > 700;
};

// ตรวจว่าหน้าเป็นแนวนอน (landscape) หรือไม่
// รองรับทั้ง true landscape (MediaBox 1190×841) และ rotated portrait (/Rotate:90, MediaBox 841×1190)
const isLandscape = (page: PDFPage): boolean => {
  const b = getViewBox(page);
  const rotation = getPageRotation(page);
  // สำหรับ /Rotate:90 หรือ 270 — ขนาดจริงกลับด้าน ต้องตรวจ height>width แทน
  if (rotation === 90 || rotation === 270) return b.height > b.width;
  return b.width > b.height;
};

// ดึง font size key ตาม paper size + orientation
const getFontPtKey = (page: PDFPage): FontPtKey => {
  const a3 = isA3Paper(page);
  const land = isLandscape(page);
  if (a3) return land ? "A3_LANDSCAPE" : "A3_PORTRAIT";
  return land ? "A4_LANDSCAPE" : "A4_PORTRAIT";
};

const getFontPt = (page: PDFPage, field: FontField): number => FONT_PT[getFontPtKey(page)][field];

// "Bake in" /Rotate เป็น CTM ใน content stream แล้วตั้ง MediaBox ใหม่ให้ตรงกับ visual size
// เรียกหลัง copyPages → หน้าที่ผ่านฟังก์ชันนี้จะเป็น rotation=0 พร้อม visual dimensions ที่ถูกต้อง
// ข้อดี: visualToRaw กลายเป็น identity (rotation=0) — ไม่ต้อง counter-rotate signature แยก
const flattenPageRotation = (page: PDFPage, pdfDoc: PDFDocument): void => {
  const rotation = getPageRotation(page);
  if (rotation === 0) return;

  const mb = page.getMediaBox();
  const W = mb.width, H = mb.height;
  let a: number, b: number, c: number, d: number, e: number, f: number;
  let newW = W, newH = H;

  if (rotation === 90) {
    [a, b, c, d, e, f] = [0, -1, 1, 0, 0, W];
    newW = H; newH = W;
  } else if (rotation === 270) {
    [a, b, c, d, e, f] = [0, 1, -1, 0, H, 0];
    newW = H; newH = W;
  } else if (rotation === 180) {
    [a, b, c, d, e, f] = [-1, 0, 0, -1, W, H];
  } else {
    return;
  }

  const ctmStr = `q ${a} ${b} ${c} ${d} ${e} ${f} cm\n`;
  const ctmRef = pdfDoc.context.register(pdfDoc.context.stream(ctmStr, { Length: ctmStr.length }));
  const endStr = `Q\n`;
  const endRef = pdfDoc.context.register(pdfDoc.context.stream(endStr, { Length: endStr.length }));

  const existing = page.node.get(PDFName.of("Contents"));
  if (!existing) return;

  const existingItems = (existing instanceof PDFArray) ? existing.asArray() : [existing];
  const newContents = pdfDoc.context.obj([ctmRef, ...existingItems, endRef]);
  page.node.set(PDFName.of("Contents"), newContents);

  page.setMediaBox(0, 0, newW, newH);
  try {
    const cb = page.getCropBox();
    if (cb) page.setCropBox(0, 0, newW, newH);
  } catch { /* no CropBox */ }
  page.setRotation(pdfDegrees(0));
};

// แปลง visual (xPct, yPct) จาก frontend → raw PDF drawing coords สำหรับหน้าที่มี rotation
// หลังจาก flattenPageRotation แล้ว rotation=0 → ฟังก์ชันนี้คืน identity (xPct, yPct)
// ยังคงไว้เพื่อ backward compatibility กับหน้าที่ไม่ผ่านการ flatten
const visualToRaw = (
  page: PDFPage,
  xPct: number,
  yPct: number
): { effX: number; effY: number } => {
  const rotation = getPageRotation(page);
  if (rotation === 90) {
    // /Rotate:90 CW: raw bottom-left → visual top-left
    // raw_x = (yPct/100) * rawWidth   → effX = yPct
    // raw_y_from_bottom = (xPct/100) * rawHeight → effY = 100 - xPct
    return { effX: yPct, effY: 100 - xPct };
  }
  if (rotation === 270) {
    // /Rotate:270 CW (90° CCW): raw top-right → visual top-left
    // raw_x = rawWidth * (1 - yPct/100)  → effX = 100 - yPct
    // raw_y_from_bottom = rawHeight * (1 - xPct/100) → effY = xPct
    return { effX: 100 - yPct, effY: xPct };
  }
  if (rotation === 180) {
    return { effX: 100 - xPct, effY: 100 - yPct };
  }
  return { effX: xPct, effY: yPct };
};

// คำนวณ landscape nudge ที่ scale ตามขนาดหน้า
const landscapeSigXNudge = (page: PDFPage): number => {
  if (!isLandscape(page)) return 0;
  const isA3 = isA3Paper(page);
  return isA3 ? SIG_X_NUDGE_A3_LANDSCAPE : SIG_X_NUDGE_A4_LANDSCAPE;
};

// landscapeXNudge ใช้กับ memoNum/note (ยังคงเดิม)
const landscapeXNudge = (page: PDFPage): number => {
  if (!isLandscape(page)) return 0;
  const isA3 = isA3Paper(page);
  return isA3 ? SIG_X_NUDGE_A3_LANDSCAPE : SIG_X_NUDGE_A4_LANDSCAPE;
};

const sigYNudge = (page: PDFPage): number => {
  const isA3 = isA3Paper(page);
  const land = isLandscape(page);
  if (isA3) return land ? SIG_Y_NUDGE_A3_LANDSCAPE : SIG_Y_NUDGE_A3_PORTRAIT;
  return land ? SIG_Y_NUDGE_A4_LANDSCAPE : SIG_Y_NUDGE_A4_PORTRAIT;
};

const dateYNudge = (page: PDFPage): number => {
  const isA3 = isA3Paper(page);
  const land = isLandscape(page);
  if (isA3) return land ? DATE_Y_NUDGE_A3_LANDSCAPE : DATE_Y_NUDGE_A3_PORTRAIT;
  return land ? DATE_Y_NUDGE_A4_LANDSCAPE : DATE_Y_NUDGE_A4_PORTRAIT;
};

const ascentAtSize = (pdfFont: any, sizePt: number) => {
  try {
    return pdfFont.heightAtSize(sizePt, { descender: false });
  } catch {
    const h = pdfFont.heightAtSize(sizePt);
    return h * 0.8;
  }
};

const metricsAtSize = (fkFont: any, pdfFont: any, sizePt: number) => {
  try {
    const upm = Number(fkFont?.unitsPerEm);
    const asc = Number(fkFont?.ascent);
    const desc = Number(fkFont?.descent);
    if (Number.isFinite(upm) && upm > 0 && Number.isFinite(asc) && Number.isFinite(desc)) {
      const scale = sizePt / upm;
      const ascent = asc * scale;
      const descent = desc * scale;
      return { ascent, descent, height: ascent - descent };
    }
  } catch { }
  const h = pdfFont.heightAtSize(sizePt);
  const ascent = ascentAtSize(pdfFont, sizePt);
  const descent = -(h - ascent);
  return { ascent, descent, height: h };
};

const yTopToBaselineMetrics = (
  page: PDFPage,
  yPct: number,
  fkFont: any,
  pdfFont: any,
  sizePt: number
) => {
  const b = getViewBox(page);
  const topY = b.y + b.height - (yPct / 100) * b.height;
  const m = metricsAtSize(fkFont, pdfFont, sizePt);
  return topY - m.ascent;
};

const measureAdvanceWidthPt = (fkFont: any, text: string, sizePt: number) => {
  if (!fkFont || !text) return null;
  try {
    const run = fkFont.layout(text);
    const unitsPerEm = fkFont.unitsPerEm || 1000;
    const scale = sizePt / unitsPerEm;

    let adv = 0;
    for (let i = 0; i < run.glyphs.length; i++) {
      const g = run.glyphs[i];
      const p = run.positions?.[i] || {};
      adv += p.xAdvance ?? g?.advanceWidth ?? 0;
    }
    return adv * scale;
  } catch {
    return null;
  }
};

const xOriginForCssCenter = (
  page: PDFPage,
  xPct: number,
  fkFont: any,
  pdfFont: any,
  text: string,
  sizePt: number
) => {
  const b = getViewBox(page);
  const centerX = b.x + (xPct / 100) * b.width;
  const w = measureAdvanceWidthPt(fkFont, text, sizePt) ?? pdfFont.widthOfTextAtSize(text, sizePt);
  return centerX - w / 2;
};

const measureInkBBoxXPt = (fkFont: any, text: string, sizePt: number): InkBBoxX | null => {
  if (!fkFont || !text) return null;
  try {
    const run = fkFont.layout(text);
    const upm = fkFont.unitsPerEm || 1000;
    const scale = sizePt / upm;

    let xCursor = 0;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;

    for (let i = 0; i < run.glyphs.length; i++) {
      const g = run.glyphs[i];
      const p = run.positions?.[i] || {};
      const x = xCursor + (p.xOffset || 0);

      const bb = g?.bbox;
      if (bb) {
        minX = Math.min(minX, x + bb.minX);
        maxX = Math.max(maxX, x + bb.maxX);
      }

      xCursor += p.xAdvance ?? g?.advanceWidth ?? 0;
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) return null;

    const minXPt = minX * scale;
    const maxXPt = maxX * scale;
    return { minX: minXPt, maxX: maxXPt, width: maxXPt - minXPt, center: (minXPt + maxXPt) / 2 };
  } catch {
    return null;
  }
};

const xOriginForInkCenter = (
  page: PDFPage,
  xPct: number,
  fkFont: any,
  pdfFont: any,
  text: string,
  sizePt: number
) => {
  const b = getViewBox(page);
  const centerX = b.x + (xPct / 100) * b.width;

  const ink = measureInkBBoxXPt(fkFont, text, sizePt);
  if (ink) return centerX - ink.center;

  return xOriginForCssCenter(page, xPct, fkFont, pdfFont, text, sizePt);
};

const pctXCenter = (page: PDFPage, xPct: number, objW: number) => {
  const b = getViewBox(page);
  return b.x + (xPct / 100) * b.width - objW / 2;
};

const pctYTop = (page: PDFPage, yPct: number, objH: number) => {
  const b = getViewBox(page);
  const topFromTop = (yPct / 100) * b.height;
  return b.y + b.height - topFromTop - objH;
};

/* ================================================================
 * CORE RENDERING FUNCTION
 * ================================================================ */
export async function renderPdfWithSignatures(
  options: RenderOptions
): Promise<PDFDocument> {
  const { memoId, mode } = options;
  const showDraft = mode === "preview";

  console.log(`[renderPdfWithSignatures] START - Memo ${memoId}, mode: ${mode}`);

  /* ===== 1) รวมไฟล์ PDF หลัก ===== */
  const files = await prisma.mainFile.findMany({
    where: { memoId },
    orderBy: { orderNo: "asc" },
  });

  const merged = await PDFDocument.create();
  const pageOffset: Record<number, number> = {};

  for (const f of files) {
    const rel = String(f.filePath || "")
      .replace(/\\/g, "/")
      .replace(/^uploads\//i, "");
    const abs = path.resolve(UPLOADS_DIR, rel);

    if (!fs.existsSync(abs)) {
      console.warn(`[renderPdf] missing file: ${abs}`);
      continue;
    }

    const bytes = fs.readFileSync(abs);
    const srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: true });

    pageOffset[f.id] = merged.getPageCount();

    const pages = await merged.copyPages(srcDoc, srcDoc.getPageIndices());
    pages.forEach((p) => {
      merged.addPage(p);
      flattenPageRotation(p, merged); // normalize /Rotate → content CTM, ป้องกัน signature หมุน
    });
  }

  if (merged.getPageCount() === 0) {
    const err: any = new Error("No main PDF files found");
    err.status = 404;
    throw err;
  }

  /* ===== 2) ปั๊ม CANCEL ถ้า terminate ===== */
  const isTerminated = !!(await prisma.memoStatusPivot.findFirst({
    where: { memoId, statusId: 7 },
  }));

  if (isTerminated) {
    const stampPath = path.resolve(
      process.cwd(),
      "..",
      "frontend",
      "public",
      "img",
      "stamp_canceled.png"
    );

    if (fs.existsSync(stampPath)) {
      const stampBytes = fs.readFileSync(stampPath);
      const stampImage = await merged.embedPng(stampBytes);
      const stampScale = 0.45;
      const { width: imgW, height: imgH } = stampImage.scale(stampScale);

      merged.getPages().forEach((page) => {
        const { width, height } = page.getSize();
        page.drawImage(stampImage, {
          x: (width - imgW) / 2,
          y: (height - imgH) / 2,
          width: imgW,
          height: imgH,
          opacity: 0.4,
        });
      });
    }
  }

  /* ===== 3) โหลดฟอนต์ ===== */
  let signFont: any;
  let dateFont: any;
  let signFk: any = null;
  let dateFk: any = null;
  let thaiFont: any;
  let thaiFk: any = null;

  try {
    merged.registerFontkit(fontkit);

    const signCandidates = [
      path.resolve(process.cwd(), "fonts/Allura-Regular.ttf"),
      path.resolve(process.cwd(), "src/fonts/Allura-Regular.ttf"),
      path.resolve(__dirname, "../../fonts/Allura-Regular.ttf"),
      path.resolve(__dirname, "../../../fonts/Allura-Regular.ttf"),
    ];
    const signPath = signCandidates.find((p) => fs.existsSync(p));
    if (!signPath) throw new Error("sign-font-not-found");
    const signBytes = fs.readFileSync(signPath);
    signFont = await merged.embedFont(signBytes);
    signFk = tryMakeFontkitFont(signPath, signBytes);

    const dateCandidates = [
      path.resolve(process.cwd(), "fonts/Prompt-Regular.ttf"),
      path.resolve(process.cwd(), "src/fonts/Prompt-Regular.ttf"),
      path.resolve(__dirname, "../../fonts/Prompt-Regular.ttf"),
      path.resolve(__dirname, "../../../fonts/Prompt-Regular.ttf"),
    ];
    const datePath = dateCandidates.find((p) => fs.existsSync(p));
    if (!datePath) throw new Error("date-font-not-found");
    const dateBytes = fs.readFileSync(datePath);
    dateFont = await merged.embedFont(dateBytes);
    dateFk = tryMakeFontkitFont(datePath, dateBytes);

    // Load Thai font for comment/condition/history pages.
    // Prefer THSarabunNew (SIPA) — uses negative-bearing glyph design so
    // vowels/tone-marks position correctly without GPOS.
    // Fall back to Sarabun-Regular (Google Fonts) if not found.
    const thaiCandidates = [
      path.resolve(process.cwd(), "fonts/THSarabunNew.ttf"),
      path.resolve(process.cwd(), "src/fonts/THSarabunNew.ttf"),
      path.resolve(__dirname, "../../fonts/THSarabunNew.ttf"),
      path.resolve(__dirname, "../../../fonts/THSarabunNew.ttf"),
      path.resolve(process.cwd(), "fonts/Sarabun-Regular.ttf"),
      path.resolve(process.cwd(), "src/fonts/Sarabun-Regular.ttf"),
      path.resolve(__dirname, "../../fonts/Sarabun-Regular.ttf"),
      path.resolve(__dirname, "../../../fonts/Sarabun-Regular.ttf"),
    ];
    const sarabunPath = thaiCandidates.find((p) => fs.existsSync(p));
    if (sarabunPath) {
      const sarabunBytes = fs.readFileSync(sarabunPath);
      thaiFont = await merged.embedFont(sarabunBytes);
      thaiFk = tryMakeFontkitFont(sarabunPath, sarabunBytes);
      // console.log(`[PDF] Thai font loaded: ${path.basename(sarabunPath)}`);
    }
  } catch {
    const helv = await merged.embedFont(StandardFonts.Helvetica);
    signFont = signFont || helv;
    dateFont = dateFont || helv;
    signFk = null;
    dateFk = null;
  }
  // Fallback: if Sarabun failed to load, use dateFont
  thaiFont = thaiFont || dateFont;

  /* ===== 4) ข้อมูลเมโม & ปั๊มเลขเมโมมุมขวาบน ===== */
  const memoRow = await prisma.masterMemo.findUnique({
    where: { id: memoId },
    select: { memonumber: true, subject: true },
  });

  const memoNumberText = cleanText(memoRow?.memonumber ?? `MEMO-${memoId}`);

  merged.getPages().forEach((page) => {
    const b = getViewBox(page);
    const MARGIN = 6, PAD_X = 6, PAD_Y = 6;

    const labelText = "E-Approval No: ";
    const fullText = `${labelText}${memoNumberText}`;
    const textW = dateFont.widthOfTextAtSize(fullText, STAMP_PT);
    const textH = dateFont.heightAtSize(STAMP_PT);
    const rectW = textW + PAD_X * 2;
    const rectH = textH + PAD_Y * 2;

    const xText = b.x + b.width - MARGIN - rectW + PAD_X;
    const yText = b.y + b.height - MARGIN - rectH + PAD_Y;

    page.drawText(fullText, {
      x: xText,
      y: yText,
      font: dateFont,
      size: STAMP_PT,
      color: STAMP_COLOR,
    });
  });

  /* ===== 5) Recall ล่าสุด ===== */
  const lastRecall = await prisma.memoStatusPivot.findFirst({
    where: { memoId, statusId: { in: [6] } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const recalledAt = lastRecall?.createdAt ?? null;

  /* ===== 6) ดึง Actions ตาม mode ===== */
  // Key format: "userId-level" to track approvals per user per level
  let userActions: Map<string, UserAction>;

  if (mode === "final") {
    // Final mode: เฉพาะ approved หลัง recall
    const approvedActions = await prisma.memoApproverAction.findMany({
      where: {
        memoId,
        status: { code: "approved" },
        ...(recalledAt ? { actedAt: { gte: recalledAt } } : {}),
      },
      orderBy: [{ loaUserId: "asc" }, { version: "desc" }],
      distinct: ["loaUserId"],
      select: {
        loaUser: { select: { userId: true, level: true } },
        status: { select: { code: true } },
        signatureImageId: true,
        signatureText: true,
        actedAt: true,
      },
    });

    userActions = new Map();
    for (const a of approvedActions) {
      const uid = a.loaUser.userId;
      const level = a.loaUser.level;
      if (uid != null) {
        const key = `${uid}-${level}`;
        userActions.set(key, {
          userId: uid,
          level: level,
          statusCode: a.status.code,
          signatureImageId: a.signatureImageId,
          signatureText: a.signatureText,
          actedAt: a.actedAt,
        });
      }
    }
  } else {
    // Preview mode: ทุก action หลัง recall + เลือกดีสุดต่อคน per level
    const allActions = await prisma.memoApproverAction.findMany({
      where: { memoId },
      orderBy: [{ loaUserId: "asc" }, { version: "desc" }],
      distinct: ["loaUserId"],
      select: {
        loaUser: { select: { userId: true, level: true } },
        status: { select: { code: true } },
        version: true,
        signatureImageId: true,
        signatureText: true,
        actedAt: true,
      },
    });

    const actionsAfterRecall = recalledAt
      ? allActions.filter((a) => !a.actedAt || a.actedAt >= recalledAt)
      : allActions;

    type ActionRow = (typeof actionsAfterRecall)[number];

    const score = (a: ActionRow) =>
      a.status.code === "approved" && a.signatureImageId
        ? 3
        : a.status.code === "approved" && a.signatureText
          ? 2
          : a.status.code === "approved"
            ? 1
            : 0;

    // Key format: "userId-level"
    const chosenByUserLevel: Record<string, ActionRow> = {};
    for (const a of actionsAfterRecall) {
      const uid = a.loaUser.userId;
      const level = a.loaUser.level;
      if (uid == null) continue;

      const key = `${uid}-${level}`;
      const cur = chosenByUserLevel[key];
      if (!cur || score(a) > score(cur) || (score(a) === score(cur) && a.version > cur.version)) {
        chosenByUserLevel[key] = a;
      }
    }

    userActions = new Map();
    for (const [key, a] of Object.entries(chosenByUserLevel)) {
      const uid = a.loaUser.userId;
      const level = a.loaUser.level;
      if (uid != null) {
        userActions.set(key, {
          userId: uid,
          level: level,
          statusCode: a.status.code,
          signatureImageId: a.signatureImageId,
          signatureText: a.signatureText,
          actedAt: a.actedAt,
        });
      }
    }
  }

  /* ===== 6.5) ANY-level satisfaction check ===== */
  // Query approval requirements per level for this memo
  const levelPivotsForReq = await prisma.lineOfApprovalUserPivotForUse.findMany({
    where: { memoId },
    select: { level: true, approvalRequirement: true },
  });

  // Build map: level → approvalRequirement ("ALL" | "ANY")
  const levelRequirements = new Map<number, string>();
  for (const p of levelPivotsForReq) {
    if (!levelRequirements.has(p.level)) {
      levelRequirements.set(p.level, p.approvalRequirement);
    }
  }

  // Determine which ANY levels are already satisfied (≥1 approved)
  const satisfiedAnyLevels = new Set<number>();
  for (const [level, requirement] of levelRequirements) {
    if (requirement === "ANY") {
      for (const action of userActions.values()) {
        if (action.level === level && action.statusCode === "approved") {
          satisfiedAnyLevels.add(level);
          break;
        }
      }
    }
  }

  /* ===== 7) โหลดรูปลายเซ็น ===== */
  const sigImgBuffers: Record<number, Uint8Array> = {};
  const uploadsDir = path.join(UPLOADS_DIR, "signatures");

  for (const act of userActions.values()) {
    if (!act.signatureImageId) continue;

    const us = await prisma.userSignature.findUnique({
      where: { id: act.signatureImageId },
      select: { path: true },
    });
    if (!us?.path) continue;

    const fileName = path.basename(us.path);
    const absPath = path.join(uploadsDir, fileName);
    if (!fs.existsSync(absPath)) continue;

    try {
      const trimmed = await sharp(fs.readFileSync(absPath))
        .ensureAlpha()
        .trim({ threshold: 10 })
        .png({ compressionLevel: 9 })
        .toBuffer();
      sigImgBuffers[act.signatureImageId] = trimmed;
    } catch (e) {
      console.warn(`[stamp] trim failed, fallback raw: ${absPath}`, e);
      sigImgBuffers[act.signatureImageId] = fs.readFileSync(absPath);
    }
  }

  /* ===== 8) ดึงตำแหน่งจาก DB ===== */
  const sigs = await prisma.signaturePosition.findMany({
    where: { memoId },
    select: {
      fileId: true,
      page: true,
      x: true,
      y: true,
      sizePct: true,
      level: true,
      user: { select: { id: true, name: true, lastname: true, nickname: true } },
    },
  });

  const dates = await prisma.datePosition.findMany({
    where: { memoId },
    select: {
      id: true,
      fileId: true,
      page: true,
      x: true,
      y: true,
      sizePct: true,
      date: true,
      userId: true,
      level: true,
    },
  });

  const memoNumberPos = await prisma.memoNumberPosition.findMany({
    where: { memoId },
    select: { fileId: true, page: true, x: true, y: true, sizePct: true },
  });

  const notePos = await prisma.notePosition.findMany({
    where: { memoId },
    select: { fileId: true, page: true, x: true, y: true, text: true, sizePct: true },
  });

  /* ===== 9) Helper สำหรับหาหน้า ===== */
  const getPageSafe = (fileId: number, pageNo: number) => {
    const base = pageOffset[fileId];
    if (base === undefined) return null;
    const idx = base + (pageNo - 1);
    const pages = merged.getPages();
    return idx >= 0 && idx < pages.length ? pages[idx] : null;
  };

  /* ===== 10) Nudge functions ===== */
  const sigXNudgePt = (sizePt: number, page: PDFPage) => (SIG_X_NUDGE_AT_BASE * sizePt) / getFontPt(page, "SIGN");
  const dateXNudgePt = (sizePt: number, page: PDFPage) => {
    const isA3 = isA3Paper(page);
    const land = isLandscape(page);
    const base = isA3
      ? (land ? DATE_X_NUDGE_A3_LANDSCAPE : DATE_X_NUDGE_A3_PORTRAIT)
      : (land ? DATE_X_NUDGE_A4_LANDSCAPE : DATE_X_NUDGE_A4_PORTRAIT);
    return (base * sizePt) / getFontPt(page, "DATE");
  };
  const dateYNudgePt = (sizePt: number, page: PDFPage) => (DATE_Y_NUDGE_AT_BASE * sizePt) / getFontPt(page, "DATE");
  const memoNumXNudgePt = (sizePt: number, page: PDFPage) => (MEMONUM_X_NUDGE_AT_BASE * sizePt) / getFontPt(page, "MEMONUM");
  const memoNumYNudgePt = (sizePt: number, page: PDFPage) => (MEMONUM_Y_NUDGE_AT_BASE * sizePt) / getFontPt(page, "MEMONUM");
  const noteXNudgePt = (sizePt: number, page: PDFPage) => (NOTE_X_NUDGE_AT_BASE * sizePt) / getFontPt(page, "NOTE");
  const noteYNudgePt = (sizePt: number, page: PDFPage) => (NOTE_Y_NUDGE_AT_BASE * sizePt) / getFontPt(page, "NOTE");

  const usedDateIds = new Set<number>();

  /* ===== 11) วาดลายเซ็น + วันที่ ===== */
  for (const sig of sigs) {
    const pg = getPageSafe(sig.fileId, sig.page);
    if (!pg) continue;

    const label = makeSignLabel(sig.user);

    // Use composite key "userId-level" to find the action for this specific signature position
    // If signature has no level (legacy data), fall back to finding any approved action for this user
    const sigLevel = sig.level;
    let act: UserAction | undefined;

    if (sigLevel != null) {
      // New behavior: look up by userId-level
      const key = `${sig.user.id}-${sigLevel}`;
      act = userActions.get(key);
    } else {
      // Legacy fallback: find any action for this user (for old data without level)
      for (const [key, action] of userActions.entries()) {
        if (action.userId === sig.user.id) {
          act = action;
          break;
        }
      }
    }

    const code = act?.statusCode;

    // Skip users who haven't approved if their ANY level is already satisfied by another approver
    const isAnyLevelDoneByOther =
      sigLevel != null &&
      satisfiedAnyLevels.has(sigLevel) &&
      code !== "approved";

    const shouldRender = code === "approved" || (showDraft && !isAnyLevelDoneByOther);
    if (!shouldRender) continue;

    const pgScale = pageScaleFactor(pg);
    const szSig = getFontPt(pg, "SIGN") * pgScale * (Number(sig.sizePct ?? 100) / 100);
    const xNudge = sigXNudgePt(szSig, pg) + landscapeSigXNudge(pg);

    // DEBUG: log page size and orientation
    {
      const b = getViewBox(pg);
      const isA3 = isA3Paper(pg);
      const orient = isLandscape(pg) ? "Landscape" : "Portrait";
      const size = isA3 ? "A3" : "A4";
      const pgScale = pageScaleFactor(pg);
      //console.log(`[PDF][page file=${sig.fileId} p=${sig.page}] ${size} ${orient} | box=${b.width.toFixed(0)}x${b.height.toFixed(0)} scale=${pgScale.toFixed(3)} | sigY_nudge=${sigYNudge(pg).toFixed(2)} dateY_nudge=${dateYNudge(pg).toFixed(2)}`);
    }

    // แปลง visual (x,y) → raw PDF coords สำหรับ rotated pages
    const { effX: sigEffX, effY: sigEffY } = visualToRaw(pg, Number(sig.x), Number(sig.y));

    // ✅ หา date ที่ใกล้สุด - พิจารณา level และระยะทาง
    const candidates = dates.filter(
      (d) =>
        d.userId === sig.user.id &&
        d.fileId === sig.fileId &&
        d.page === sig.page &&
        !usedDateIds.has(d.id)
    );

    let nearest: (typeof candidates)[number] | null = null;
    let bestDist2 = Number.POSITIVE_INFINITY;

    for (const d of candidates) {
      // ✅ ถ้ามี level ทั้งคู่ ต้องตรงกัน ถ้าไม่ตรงข้าม
      const levelMatch =
        (sigLevel == null || d.level == null) ? true : (d.level === sigLevel);

      if (!levelMatch) continue;

      const dx = Number(d.x) - Number(sig.x);
      const dy = Number(d.y) - Number(sig.y);
      const dist2 = dx * dx + dy * dy;
      if (dist2 < bestDist2) {
        bestDist2 = dist2;
        nearest = d;
      }
    }

    // ✅ คำนวณ date - ไม่จำกัดระยะทาง (ลบเงื่อนไข THRESH_RADIUS)
    let dateStr = "";
    let dateRect: DrawBox | null = null;
    let dateText: { x: number; y: number; size: number } | null = null;

    if (nearest) {
      // Use approval date (actedAt) when approved, otherwise use stored date for draft/preview
      const dateSource = (code === "approved" && act?.actedAt) ? act.actedAt : nearest.date;
      const raw = safeIsoDate(dateSource);
      const tDate = cleanText(raw);

      if (tDate) {
        const szDate = getFontPt(pg, "DATE") * pgScale * (Number(nearest.sizePct ?? 100) / 100);
        const { effX: dateEffX, effY: dateEffY } = visualToRaw(pg, Number(nearest.x), Number(nearest.y));

        const xText =
          xOriginForCssCenter(pg, dateEffX, dateFk, dateFont, tDate, szDate) +
          dateXNudgePt(szDate, pg) + landscapeXNudge(pg);

        const baselineY =
          yTopToBaselineMetrics(pg, dateEffY, dateFk, dateFont, szDate) +
          dateYNudgePt(szDate, pg) + dateYNudge(pg);

        const m = metricsAtSize(dateFk, dateFont, szDate);
        const w =
          measureAdvanceWidthPt(dateFk, tDate, szDate) ??
          dateFont.widthOfTextAtSize(tDate, szDate);
        const h = m.height;
        const yBottom = baselineY + m.descent;
        dateRect = { x: xText, y: yBottom, w, h };

        dateStr = tDate;
        dateText = { x: xText, y: baselineY, size: szDate };
        usedDateIds.add(nearest.id);
      }
    }

    // measure sig box สำหรับ BG
    const measureSigBox = async (): Promise<DrawBox> => {
      if (act?.signatureImageId && sigImgBuffers[act.signatureImageId]) {
        const png = await merged.embedPng(sigImgBuffers[act.signatureImageId]);
        const targetH = szSig * 1.2;
        const targetW = (png.width / png.height) * targetH;
        // ✅ Bug fix: image signature ต้องใช้ landscapeSigXNudge เหมือน text
        const x = pctXCenter(pg, sigEffX, targetW) + landscapeSigXNudge(pg);
        const y = pctYTop(pg, sigEffY, targetH) + sigYNudge(pg);
        return { x, y, w: targetW, h: targetH };
      }

      const tRaw = act?.signatureText ? act.signatureText : label;
      const t = cleanText(tRaw);
      const w =
        measureAdvanceWidthPt(signFk, t, szSig) ?? signFont.widthOfTextAtSize(t, szSig);
      const h = signFont.heightAtSize(szSig);
      const x = xOriginForCssCenter(pg, sigEffX, signFk, signFont, t, szSig) + xNudge;
      const y = pctYTop(pg, sigEffY, h) + sigYNudge(pg);
      return { x, y, w, h };
    };

    const measuredSigBox = await measureSigBox();

    // วาด BG draft
    if (showDraft && code !== "approved") {
      const padH = 1.2 * getFontPt(pg, "SIGN");
      const padV = 0.6 * getFontPt(pg, "SIGN");

      pg.drawRectangle({
        x: measuredSigBox.x - padH,
        y: measuredSigBox.y - padV,
        width: Math.max(0.1, measuredSigBox.w + 2 * padH),
        height: Math.max(0.1, measuredSigBox.h + 2 * padV),
        color: BG_NAME,
        opacity: BG_OPACITY,
      });

      if (dateRect) {
        pg.drawRectangle({
          x: dateRect.x - padH,
          y: dateRect.y - padV,
          width: Math.max(0.1, dateRect.w + 2 * padH),
          height: Math.max(0.1, dateRect.h + 2 * padV),
          color: BG_DATE,
          opacity: BG_OPACITY,
        });
      }
    }

    // วาดลายเซ็น
    if (act?.signatureImageId && sigImgBuffers[act.signatureImageId]) {
      const png = await merged.embedPng(sigImgBuffers[act.signatureImageId]);
      const targetH = szSig * 1.2;
      const targetW = (png.width / png.height) * targetH;

      // ✅ Bug fix: image signature ต้องใช้ landscapeSigXNudge เหมือน text
      const x = pctXCenter(pg, sigEffX, targetW) + landscapeSigXNudge(pg);
      const y = pctYTop(pg, sigEffY, targetH) + sigYNudge(pg);
      pg.drawImage(png, { x, y, width: targetW, height: targetH });
    } else if (act?.signatureText) {
      const t = cleanText(act.signatureText);
      const x = xOriginForCssCenter(pg, sigEffX, signFk, signFont, t, szSig) + xNudge;
      const y = yTopToBaselineMetrics(pg, sigEffY, signFk, signFont, szSig) + sigYNudge(pg);
      pg.drawText(t, {
        font: signFont,
        size: szSig,
        x,
        y,
        color: code === "approved" ? BLACK : TEXT_NAME,
        opacity: code === "approved" ? 1 : 0.35,
      });
    } else {
      const t = cleanText(label);
      const x = xOriginForCssCenter(pg, sigEffX, signFk, signFont, t, szSig) + xNudge;
      const y = yTopToBaselineMetrics(pg, sigEffY, signFk, signFont, szSig) + sigYNudge(pg);
      pg.drawText(t, {
        font: signFont,
        size: szSig,
        x,
        y,
        ...(code === "approved" ? {} : { color: TEXT_NAME }),
      });
    }

    // วาดวันที่
    if (dateText && dateStr) {
      pg.drawText(dateStr, {
        font: dateFont,
        size: dateText.size,
        x: dateText.x,
        y: dateText.y,
        color: code === "approved" ? BLACK : TEXT_DATE,
        opacity: 1,
      });
    }
  }

  /* ===== 12) วาดเลขเอกสาร ===== */
  for (const pos of memoNumberPos) {
    const pg = getPageSafe(pos.fileId, pos.page);
    if (!pg) continue;

    const sizePct = Number(pos.sizePct ?? 100);
    const pgScaleNum = pageScaleFactor(pg);
    const szNum = getFontPt(pg, "MEMONUM") * pgScaleNum * (sizePct / 100);
    const { effX: numEffX, effY: numEffY } = visualToRaw(pg, Number(pos.x), Number(pos.y));

    const xPDF =
      xOriginForInkCenter(pg, numEffX, dateFk, dateFont, memoNumberText, szNum) +
      memoNumXNudgePt(szNum, pg) + landscapeXNudge(pg);

    const yPDF =
      yTopToBaselineMetrics(pg, numEffY, dateFk, dateFont, szNum) +
      memoNumYNudgePt(szNum, pg) + sigYNudge(pg);

    pg.drawText(memoNumberText, {
      font: dateFont,
      size: szNum,
      x: xPDF,
      y: yPDF,
      color: BLACK,
    });
  }

  /* ===== 13) วาดหมายเหตุ ===== */
  for (const pos of notePos) {
    const pg = getPageSafe(pos.fileId, pos.page);
    if (!pg) continue;

    const noteText = cleanText(pos.text || "");
    if (!noteText) continue;

    const sizePct = Number(pos.sizePct ?? 100);
    const pgScaleNote = pageScaleFactor(pg);
    const szNote = getFontPt(pg, "NOTE") * pgScaleNote * (sizePct / 100);
    const { effX: noteEffX, effY: noteEffY } = visualToRaw(pg, Number(pos.x), Number(pos.y));

    const xPDF =
      xOriginForInkCenter(pg, noteEffX, dateFk, dateFont, noteText, szNote) +
      noteXNudgePt(szNote, pg) + landscapeXNudge(pg);

    const yPDF =
      yTopToBaselineMetrics(pg, noteEffY, dateFk, dateFont, szNote) +
      noteYNudgePt(szNote, pg) + sigYNudge(pg);

    pg.drawText(noteText, {
      font: dateFont,
      size: szNote,
      x: xPDF,
      y: yPDF,
      color: BLACK,
    });
  }

  /* ===== 13.5) Stamp "Approve with condition" + Extra Approval on ALL existing pages ===== */
  {
    // Query approve-with-condition records
    const condActionsForStamp = await prisma.memoApproverAction.findMany({
      where: { memoId, approveWithCondition: { not: null }, status: { code: "approved" } },
      select: { id: true },
    });

    //console.log(`[PDF Stamp] Memo ${memoId}: condActionsForStamp.length = ${condActionsForStamp.length}`);

    // If memo is also terminated, skip stamps
    // — only the final status ("Terminated") should appear on pages
    const hasTerminateStamp = await prisma.memoApproverAction.count({
      where: { memoId, terminationReason: { not: null }, status: { code: "terminated" } },
    });

    // Query extra approval lines (independent of condition approvals)
    const extraLinesForStamp = await prisma.extraApprovalLine.findMany({
      where: { memoId },
      include: {
        approvers: {
          include: { user: { select: { name: true, lastname: true, nickname: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const extraNamesForStamp = extraLinesForStamp
      .flatMap((line) => line.approvers)
      .map((a) => {
        const parts = [a.user.name, a.user.lastname].filter(Boolean).join(" ");
        return a.user.nickname ? `${parts} (${a.user.nickname})` : parts;
      });
    const extraLabelForStamp = extraNamesForStamp.length > 0
      ? `Extra Approval (${extraNamesForStamp.length})`
      : "";

    const stampColor = rgb(0.39, 0.45, 0.55);
    const stampSize = 5;
    const stampMargin = 10;

    // Only stamp if not terminated and there's something to stamp
    const hasConditionStamp = condActionsForStamp.length > 0;
    const hasExtraStamp = extraLabelForStamp !== "";

    if (hasTerminateStamp === 0 && (hasConditionStamp || hasExtraStamp)) {
      const totalPages = merged.getPages().length;
      //console.log(`[PDF Stamp] Stamping on ${totalPages} pages`);

      if (hasConditionStamp) {
        const count = condActionsForStamp.length;
        const label = `Approved with condition (${count})`;
        //console.log(`[PDF Stamp] Label: "${label}"`);
      }

      for (const pg of merged.getPages()) {
        try {
          const { width: pgW, height: pgH } = pg.getSize();
          // memo number ถูก stamp ไว้แล้วตอน create memo ที่ pgH - 10
          // เว้นลงมา 2 บรรทัด (8pt x 3 = 24pt) จาก memo number
          let stampY = pgH - 10 - 16;

          // Stamp "Approve with condition" only if there are condition approvals
          if (hasConditionStamp) {
            const count = condActionsForStamp.length;
            const label = `Approved with conditions (${count})`;
            const lw = dateFont.widthOfTextAtSize(label, stampSize);
            pg.drawText(label, {
              x: pgW - stampMargin - lw - 2, y: stampY,
              font: dateFont, size: stampSize, color: stampColor,
            });
            stampY -= 8;
          }

          // Stamp "Extra Approval" independently if there are extra approval lines
          if (hasExtraStamp) {
            const ew = dateFont.widthOfTextAtSize(extraLabelForStamp, stampSize);
            pg.drawText(extraLabelForStamp, {
              x: pgW - stampMargin - ew, y: stampY,
              font: dateFont, size: stampSize, color: stampColor,
            });
          }
        } catch (err) {
          console.error('[PDF Stamp] Error stamping page:', err);
        }
      }
      console.log(`[PDF Stamp] Finished stamping`);
    }
  }

  /* ===== 14) Approve With Condition + Terminate + Comments pages ===== */
  // Save page count BEFORE appending condition pages so Section 14.5
  // only stamps "Terminated" on the original pages (condition pages
  // already have their own "Terminated" label from stampMemoNum).
  const originalPageCount = merged.getPageCount();
  await appendConditionTerminateAndCommentPages(merged, thaiFont, thaiFk, memoId, memoNumberText, dateFont);

  /* ===== 14.5) Stamp "Terminated" on ORIGINAL pages only ===== */
  // Only stamp on the original pages (index 0..originalPageCount-1).
  // Condition pages appended by Section 14 already have "Terminated"
  // from their own stampMemoNum — stamping here too would cause a
  // duplicate "Terminated" label on those pages.
  {
    const terminateActionsForStamp = await prisma.memoApproverAction.count({
      where: { memoId, terminationReason: { not: null }, status: { code: "terminated" } },
    });

    if (terminateActionsForStamp > 0) {
      const stampColor = rgb(0.39, 0.45, 0.55);
      const stampSize = 5;
      const stampMargin = 10;

      const allPages = merged.getPages();
      for (let i = 0; i < originalPageCount; i++) {
        const pg = allPages[i];
        try {
          const { width: pgW, height: pgH } = pg.getSize();
          // memo number ถูก stamp ไว้แล้วตอน create memo ที่ pgH - 10
          // เว้นลงมา 2 บรรทัด (8pt x 3 = 24pt) จาก memo number
          const stampY = pgH - 10 - 16;

          const label = "Terminated";
          const lw = dateFont.widthOfTextAtSize(label, stampSize);
          pg.drawText(label, {
            x: pgW - stampMargin - lw - 2, y: stampY,
            font: dateFont, size: stampSize, color: stampColor,
          });
        } catch { /* ignore stamp errors */ }
      }
    }
  }

  /* ===== 15) Comment-only pages (general case) ===== */
  await appendCommentOnlyPages(merged, thaiFont, thaiFk, memoId, memoNumberText, dateFont);

  /* ===== 16) History section - Always render ===== */
  //console.log(`[PDF] About to call renderHistorySection for memo ${memoId}`);
  await renderHistorySection(merged, thaiFont, memoId, memoNumberText, [], thaiFk, dateFont);
  //console.log(`[PDF] Finished renderHistorySection for memo ${memoId}`);

  return merged;
}

/* ================================================================
 * APPROVE WITH CONDITION + COMMENTS PDF PAGES
 * ================================================================ */

const PAGE_W = 595.28; // A4 width in pt
const PAGE_H = 841.89; // A4 height in pt
const MARGIN = 50;
const CONTENT_W = PAGE_W - MARGIN * 2;
const LINE_H = 14;
const SECTION_GAP = 20;

// Helper function to draw rounded rectangle
function drawRoundedRect(
  page: PDFPage,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  options: {
    color?: any;
    borderColor?: any;
    borderWidth?: number;
  } = {}
) {
  const { color, borderColor, borderWidth = 0 } = options;

  // Draw filled rounded rectangle
  if (color) {
    // Top side
    page.drawRectangle({
      x: x + radius,
      y: y + height - radius,
      width: width - radius * 2,
      height: radius,
      color,
      borderWidth: 0,
    });
    // Bottom side
    page.drawRectangle({
      x: x + radius,
      y: y,
      width: width - radius * 2,
      height: radius,
      color,
      borderWidth: 0,
    });
    // Middle
    page.drawRectangle({
      x: x,
      y: y + radius,
      width: width,
      height: height - radius * 2,
      color,
      borderWidth: 0,
    });

    // Corners (approximate with small rectangles for simplicity)
    // Top-left
    page.drawRectangle({ x: x, y: y + height - radius, width: radius, height: radius, color, borderWidth: 0 });
    // Top-right
    page.drawRectangle({ x: x + width - radius, y: y + height - radius, width: radius, height: radius, color, borderWidth: 0 });
    // Bottom-left
    page.drawRectangle({ x: x, y: y, width: radius, height: radius, color, borderWidth: 0 });
    // Bottom-right
    page.drawRectangle({ x: x + width - radius, y: y, width: radius, height: radius, color, borderWidth: 0 });
  }

  // Draw border
  if (borderColor && borderWidth > 0) {
    const bw = borderWidth;
    const r = radius;

    // Top line
    page.drawLine({
      start: { x: x + r, y: y + height },
      end: { x: x + width - r, y: y + height },
      thickness: bw,
      color: borderColor,
    });
    // Right line
    page.drawLine({
      start: { x: x + width, y: y + height - r },
      end: { x: x + width, y: y + r },
      thickness: bw,
      color: borderColor,
    });
    // Bottom line
    page.drawLine({
      start: { x: x + width - r, y: y },
      end: { x: x + r, y: y },
      thickness: bw,
      color: borderColor,
    });
    // Left line
    page.drawLine({
      start: { x: x, y: y + r },
      end: { x: x, y: y + height - r },
      thickness: bw,
      color: borderColor,
    });

    // Corner arcs (simplified with short lines)
    // Top-left
    page.drawLine({ start: { x: x, y: y + height - r }, end: { x: x + r, y: y + height }, thickness: bw, color: borderColor });
    // Top-right
    page.drawLine({ start: { x: x + width - r, y: y + height }, end: { x: x + width, y: y + height - r }, thickness: bw, color: borderColor });
    // Bottom-right
    page.drawLine({ start: { x: x + width, y: y + r }, end: { x: x + width - r, y: y }, thickness: bw, color: borderColor });
    // Bottom-left
    page.drawLine({ start: { x: x + r, y: y }, end: { x: x, y: y + r }, thickness: bw, color: borderColor });
  }
}

function wrapText(font: any, text: string, fontSize: number, maxWidth: number): string[] {
  if (!text) return [""];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    let testWidth: number;
    try {
      testWidth = font.widthOfTextAtSize(testLine, fontSize);
    } catch {
      testWidth = testLine.length * fontSize * 0.5;
    }

    if (testWidth > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [""];
}

/**
 * Wrap text using fontkit's layout() for accurate width measurement (supports Thai and other complex scripts).
 */
function wrapTextFk(
  fkFont: any,
  pdfFont: any,
  text: string,
  fontSize: number,
  maxWidth: number
): string[] {
  if (!text) return [""];

  const measureW = (t: string): number => {
    if (!t) return 0;
    if (fkFont) {
      const w = measureAdvanceWidthPt(fkFont, t, fontSize);
      if (w !== null) return w;
    }
    try { return pdfFont.widthOfTextAtSize(t, fontSize); } catch { return t.length * fontSize * 0.5; }
  };

  const parts = text.split(" ");
  const lines: string[] = [];
  let currentLine = "";

  for (const part of parts) {
    const testLine = currentLine ? `${currentLine} ${part}` : part;
    if (measureW(testLine) > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = part;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines.length > 0 ? lines : [""];
}

/**
 * Draw Thai (and mixed) text as a single text element so the embedded font's
 * built-in glyph metrics (negative bearings in THSarabunNew) position
 * vowels and tone marks correctly without requiring the PDF viewer to apply
 * GPOS.  Rendering the whole string in one drawText call also lets modern
 * viewers apply OpenType features across the entire cluster when available.
 */
function drawShapedText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  _fkFont: any,   // reserved — kept for API compatibility
  pdfFont: any,
  color: any
): void {
  if (!text) return;
  try {
    page.drawText(text, { x, y, size, font: pdfFont, color });
  } catch {
    // ignore individual line errors
  }
}

// Helper function to render history section on a new page
async function renderHistorySection(
  doc: PDFDocument,
  font: any,
  memoId: number,
  memoNumberText: string,
  extraLines: any[] = [], // Add extraLines parameter
  fkFont: any = null,
  stampFont: any = null
): Promise<void> {
  //console.log(`[PDF History] renderHistorySection called for memo ${memoId}`);

  // Fetch all history items
  const history = await prisma.memoHistory.findMany({
    where: { memoId },
    include: {
      user: { select: { name: true, lastname: true, nickname: true } },
      status: { select: { name: true } },
    },
    orderBy: { timestamp: "desc" }, // Most recent first
  });

  //console.log(`[PDF History] Found ${history.length} history items for memo ${memoId}`);

  if (history.length === 0) {
    //console.log(`[PDF History] No history items found, skipping history section`);
    return;
  }

  // Start new page for history
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let cursorY = PAGE_H - MARGIN;

  // Fetch stamp data for history pages
  const condActionsCountHist = await prisma.memoApproverAction.count({
    where: { memoId, approveWithCondition: { not: null }, status: { code: "approved" } },
  });
  const hasTerminateStampHist = await prisma.memoApproverAction.count({
    where: { memoId, terminationReason: { not: null }, status: { code: "terminated" } },
  });
  const extraLinesHist = await prisma.extraApprovalLine.findMany({
    where: { memoId },
    include: { approvers: { include: { user: { select: { name: true, lastname: true, nickname: true } } } } },
  });
  const extraNamesCountHist = extraLinesHist.flatMap((l) => l.approvers).length;
  const extraLabelHist = extraNamesCountHist > 0 ? `Extra Approval (${extraNamesCountHist})` : "";
  const hasConditionStampHist = hasTerminateStampHist === 0 && condActionsCountHist > 0;
  const hasExtraStampHist = hasTerminateStampHist === 0 && extraLabelHist !== "";

  // Stamp memo number
  const sf = stampFont || font;
  const stampMemoNum = (pg: PDFPage) => {
    try {
      let stampY = PAGE_H - 10;
      const stampColor = rgb(0.39, 0.45, 0.55);
      const stampSize = 5;

      const labelText = "E-Approval No: ";
      const fullText = `${labelText}${memoNumberText}`;
      const tw = sf.widthOfTextAtSize(fullText, stampSize);
      pg.drawText(fullText, {
        x: PAGE_W - MARGIN - tw,
        y: stampY,
        font: sf,
        size: stampSize,
        color: stampColor,
      });
      stampY -= 8;

      if (hasConditionStampHist) {
        const label = `Approved with conditions (${condActionsCountHist})`;
        const lw = sf.widthOfTextAtSize(label, stampSize);
        pg.drawText(label, {
          x: PAGE_W - MARGIN - lw - 2,
          y: stampY,
          font: sf,
          size: stampSize,
          color: stampColor,
        });
        stampY -= 8;
      }

      if (hasExtraStampHist) {
        const ew = sf.widthOfTextAtSize(extraLabelHist, stampSize);
        pg.drawText(extraLabelHist, {
          x: PAGE_W - MARGIN - ew,
          y: stampY,
          font: sf,
          size: stampSize,
          color: stampColor,
        });
        stampY -= 8;
      }

      if (hasTerminateStampHist > 0) {
        const label = "Terminated";
        const lw = sf.widthOfTextAtSize(label, stampSize);
        pg.drawText(label, {
          x: PAGE_W - MARGIN - lw - 2,
          y: stampY,
          font: sf,
          size: stampSize,
          color: stampColor,
        });
      }
    } catch { }
  };
  stampMemoNum(page);

  // Draw page border
  page.drawRectangle({
    x: MARGIN,
    y: MARGIN + 20,
    width: CONTENT_W,
    height: PAGE_H - MARGIN - MARGIN - 20,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.8, 0.8, 0.8),
    borderWidth: 1,
  });

  // Header section with clock icon
  const headerH = 40;
  const headerY = PAGE_H - MARGIN - headerH;

  page.drawRectangle({
    x: MARGIN,
    y: headerY,
    width: CONTENT_W,
    height: headerH,
    color: rgb(0.98, 0.98, 0.98),
  });

  // Clock icon
  const iconX = MARGIN + 25;
  const iconY = PAGE_H - MARGIN - 20;

  // Clock circle
  page.drawCircle({
    x: iconX,
    y: iconY,
    size: 8,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.3, 0.3, 0.3),
    borderWidth: 1.5,
  });

  // Clock hands
  page.drawLine({
    start: { x: iconX, y: iconY },
    end: { x: iconX, y: iconY + 4 },
    thickness: 1.5,
    color: rgb(0.3, 0.3, 0.3),
  });
  page.drawLine({
    start: { x: iconX, y: iconY },
    end: { x: iconX + 3, y: iconY },
    thickness: 1.5,
    color: rgb(0.3, 0.3, 0.3),
  });

  // Title
  page.drawText("History", {
    x: iconX + 15,
    y: PAGE_H - MARGIN - 25,
    font,
    size: 12,
    color: rgb(0.1, 0.1, 0.1),
  });

  // Horizontal line below header
  page.drawLine({
    start: { x: MARGIN, y: headerY },
    end: { x: MARGIN + CONTENT_W, y: headerY },
    thickness: 1,
    color: rgb(0.8, 0.8, 0.8),
  });

  cursorY = headerY - 20;

  const fmtDateTime = (v: unknown): string => {
    if (!v) return "-";
    const d = new Date(v as any);
    if (isNaN(d.getTime())) return "-";
    const mon = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const year = d.getFullYear();
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${mon}/${day}/${year}, ${h}:${m}:${s} ${ampm}`;
  };

  const makeUserLabel = (u: {
    name?: string | null;
    lastname?: string | null;
    nickname?: string | null;
  }) => {
    // const base = [u?.name, u?.lastname].filter(Boolean).join(" ").trim();
    // const nick = u?.nickname ? ` (${u.nickname})` : "";
    // return `${base}${nick}`;
    const base = [u?.name, u?.lastname].filter(Boolean).join(" ").trim();
    return u?.nickname ? `${base} (${u.nickname})` : base || "";
  };

  const ensureSpace = (needH: number) => {
    if (cursorY - needH < MARGIN + 40) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      cursorY = PAGE_H - MARGIN;
      stampMemoNum(page);

      // Draw border on new page
      page.drawRectangle({
        x: MARGIN,
        y: MARGIN + 20,
        width: CONTENT_W,
        height: PAGE_H - MARGIN - MARGIN - 20,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.8, 0.8, 0.8),
        borderWidth: 1,
      });

      cursorY -= 20;
    }
  };

  // Render each history item
  for (let i = 0; i < history.length; i++) {
    const item = history[i];
    const dateStr = fmtDateTime(item.timestamp);
    const userName = makeUserLabel(item.user);
    const action = cleanText(item.action || "");

    //console.log(`[PDF History] Item ${i + 1}: action="${action}", user="${userName}"`);

    // Parse action to check if it's a special card type
    // Check for various patterns of condition/termination/extra approval/reject
    const isApprovedWithCondition =
      action.includes("Approved With Condition") ||
      action.includes("approved the memo (with condition:") ||
      action.includes("with condition:");

    const isTerminated =
      action.includes("Terminate Condition") ||
      action.includes("terminated the memo") ||
      action.includes("Terminated");

    const isRejected =
      action.includes("rejected the memo") ||
      action.includes("needs revised");

    // Extra Approval should only show as card when approved, not when added
    const isExtraApproval =
      action.includes("Extra Approval: Approved by");

    // Extra Approver added (not yet approved) - show as simple text
    const isExtraApproverAdded =
      action.includes("Extra Approver added");

    if (isApprovedWithCondition || isTerminated || isExtraApproval || isRejected) {
      // Render as card with date above

      // Extract details from action text
      let approverName = userName;
      let level = "";
      let conditionText = "";

      // For Extra Approval, extract the approver name from action text
      // Pattern: "Extra Approver added: Name (Nickname) by ..."
      if (isExtraApproval) {
        //console.log(`[PDF History] Extra Approval detected. Action text: "${action}"`);

        // Pattern 1: "Extra Approver added: Name by ..."
        let approverMatch = action.match(/Extra Approver added:\s*(.+?)\s+by\s+/i);

        // Pattern 2: "Extra Approval: Approved by Name"
        if (!approverMatch) {
          approverMatch = action.match(/Extra Approval:\s*Approved by\s+(.+)/i);
        }

        //console.log(`[PDF History] Approver match result:`, approverMatch);
        if (approverMatch) {
          approverName = approverMatch[1].trim();
          //console.log(`[PDF History] Extracted approver name: "${approverName}"`);
        } else {
          //console.log(`[PDF History] Failed to extract approver name, using userName: "${userName}"`);
        }
      }

      // Try to extract level
      const levelMatch = action.match(/Level[:\s]+(\d+)/i);
      if (levelMatch) {
        level = levelMatch[1];
      }

      // Try to extract condition/reason text
      if (isApprovedWithCondition) {
        // Pattern 1: "Approved With Condition - Approval Conditions: text"
        let condMatch = action.match(/Approval Condition[s]?:\s*(.+)/i);
        if (!condMatch) {
          // Pattern 2: "approved the memo (with condition: text)"
          condMatch = action.match(/with condition:\s*([^)]+)/i);
        }
        if (condMatch) {
          conditionText = condMatch[1].trim();
        }
      } else if (isTerminated) {
        // Pattern 1: "Terminated Condition: text"
        let termMatch = action.match(/Terminated Condition:\s*(.+)/i);
        if (!termMatch) {
          // Pattern 2: "termination reason: text"
          termMatch = action.match(/termination reason:\s*(.+)/i);
        }
        if (!termMatch) {
          // Pattern 3: "terminated the memo: text"
          termMatch = action.match(/terminated the memo:\s*(.+)/i);
        }
        if (termMatch) {
          conditionText = termMatch[1].trim();
        }
      } else if (isExtraApproval) {
        // Try to extract from action text first
        let commentMatch = action.match(/Comment:\s*(.+)/i) ||
          action.match(/Reason:\s*(.+)/i);
        if (commentMatch) {
          conditionText = commentMatch[1].trim();
        } else {
          // If not in action text, try to find from extraApprovalLine
          // Match by approver name instead of timestamp
          //console.log(`[PDF History] Looking for extra approval comment for approver: "${approverName}"`);

          const extraLine = extraLines.find(line => {
            // Check if any approver in this line matches the approverName
            return line.approvers.some((a: any) => {
              const fullName = `${a.user.name} ${a.user.lastname || ''} ${a.user.nickname ? '(' + a.user.nickname + ')' : ''}`.trim();
              const match = fullName === approverName ||
                fullName.includes(approverName) ||
                approverName.includes(a.user.name);
              //console.log(`[PDF History] Comparing: "${fullName}" vs "${approverName}" = ${match}`);
              return match;
            });
          });

          console.log(`[PDF History] Found extraLine:`, extraLine ? {

            comment: extraLine.comment?.comment
          } : 'NOT FOUND');

          if (extraLine?.comment?.comment) {
            conditionText = cleanText(extraLine.comment.comment);
          }
        }
      } else if (isRejected) {
        // Pattern 1: "rejected the memo: reason"
        let rejectMatch = action.match(/rejected the memo:\s*(.+)/i);
        if (!rejectMatch) {
          // Pattern 2: "needs revised: reason"
          rejectMatch = action.match(/needs revised:\s*(.+)/i);
        }
        if (rejectMatch) {
          conditionText = rejectMatch[1].trim();
        }
      }

      const conditionLines = conditionText ? wrapTextFk(fkFont, font, conditionText, 9, CONTENT_W - 100) : [];

      // Calculate card height (very compact)
      const headerH = 35;
      const byLineH = 0;
      // First line is on same line as label, so -1 from line count
      const conditionLabelH = conditionLines.length > 0 ? 11 : 0; // Label + first line
      const conditionTextH = conditionLines.length > 1 ? (conditionLines.length - 1) * 11 : 0; // Remaining lines
      const contentH = byLineH + conditionLabelH + conditionTextH + 10;
      const totalH = headerH + contentH;

      ensureSpace(totalH + 50);

      // Draw date above card (outside)
      page.drawText(dateStr, {
        x: MARGIN + 20,
        y: cursorY,
        font,
        size: 9,
        color: rgb(0.1, 0.1, 0.1),
      });

      cursorY -= 0; // Reduced from 20

      const containerY = cursorY;

      // Icon in header
      const iconX = MARGIN + 50;
      const iconY = containerY - 20;

      if (isTerminated) {
        // Red X circle
        page.drawCircle({
          x: iconX,
          y: iconY,
          size: 10,
          color: rgb(0.9, 0.2, 0.2),
        });
        // X mark
        page.drawLine({
          start: { x: iconX - 4, y: iconY - 4 },
          end: { x: iconX + 4, y: iconY + 4 },
          thickness: 2,
          color: rgb(1, 1, 1),
        });
        page.drawLine({
          start: { x: iconX - 4, y: iconY + 4 },
          end: { x: iconX + 4, y: iconY - 4 },
          thickness: 2,
          color: rgb(1, 1, 1),
        });
      } else if (isRejected) {
        // Orange X circle
        page.drawCircle({
          x: iconX,
          y: iconY,
          size: 10,
          color: rgb(0.95, 0.5, 0.2),
        });
        // X mark
        page.drawLine({
          start: { x: iconX - 4, y: iconY - 4 },
          end: { x: iconX + 4, y: iconY + 4 },
          thickness: 2,
          color: rgb(1, 1, 1),
        });
        page.drawLine({
          start: { x: iconX - 4, y: iconY + 4 },
          end: { x: iconX + 4, y: iconY - 4 },
          thickness: 2,
          color: rgb(1, 1, 1),
        });
      } else if (isExtraApproval) {
        // Blue circle with plus
        page.drawCircle({
          x: iconX,
          y: iconY,
          size: 10,
          color: rgb(0.2, 0.5, 0.9),
        });
        // Plus symbol
        page.drawLine({
          start: { x: iconX - 5, y: iconY },
          end: { x: iconX + 5, y: iconY },
          thickness: 2,
          color: rgb(1, 1, 1),
        });
        page.drawLine({
          start: { x: iconX, y: iconY - 5 },
          end: { x: iconX, y: iconY + 5 },
          thickness: 2,
          color: rgb(1, 1, 1),
        });
      } else {
        // Green checkmark circle
        page.drawCircle({
          x: iconX,
          y: iconY,
          size: 10,
          color: rgb(0.3, 0.7, 0.3),
        });
        // Checkmark
        page.drawLine({
          start: { x: iconX - 3, y: iconY },
          end: { x: iconX - 1, y: iconY - 3 },
          thickness: 2,
          color: rgb(1, 1, 1),
        });
        page.drawLine({
          start: { x: iconX - 1, y: iconY - 3 },
          end: { x: iconX + 4, y: iconY + 3 },
          thickness: 2,
          color: rgb(1, 1, 1),
        });
      }

      // Title next to icon
      const title = isTerminated
        ? "Terminate Condition"
        : isRejected
          ? "Needs Revised"
          : isExtraApproval
            ? "Extra Approval Requests"
            : "Approved With Conditions";

      page.drawText(title, {
        x: iconX + 20,
        y: containerY - 25,
        font,
        size: 11,
        color: rgb(0.1, 0.1, 0.1),
      });

      // Add "By" and "Level" info in header (same line as title)
      const titleW = font.widthOfTextAtSize(title, 11);
      const byInfo = level
        ? `   By : ${approverName}   Level: ${level}`
        : `   By : ${approverName}`;

      page.drawText(byInfo, {
        x: iconX + 20 + titleW,
        y: containerY - 25,
        font,
        size: 9,
        color: rgb(0.3, 0.3, 0.3),
      });

      // Content area (white background)
      let cy = containerY - headerH - 8; // Reduced from 10

      // All cards now show "By" info in header, no "By" line in content

      // Condition/Reason section
      if (conditionLines.length > 0) {
        const condLabel = isTerminated
          ? "Terminated Condition: "
          : isRejected
            ? "Rejection Reason: "
            : isExtraApproval
              ? "Comment / Reason: "
              : "Approval Condition: ";

        // Draw label and first line on same line
        const labelW = font.widthOfTextAtSize(condLabel, 9);

        page.drawText(condLabel, {
          x: MARGIN + 40,
          y: cy,
          font,
          size: 9,
          color: rgb(0.2, 0.2, 0.2),
        });

        // Draw first line of condition text on same line as label
        if (conditionLines.length > 0) {
          drawShapedText(page, conditionLines[0], MARGIN + 40 + labelW, cy, 9, fkFont, font, rgb(0.3, 0.3, 0.3));
          cy -= 11;

          // Draw remaining lines with indentation
          for (let i = 1; i < conditionLines.length; i++) {
            drawShapedText(page, conditionLines[i], MARGIN + 55, cy, 9, fkFont, font, rgb(0.3, 0.3, 0.3));
            cy -= 11;
          }
        }
      }

      cursorY -= totalH + 2; // Reduced from 20

    } else {
      // Render as simple text line
      ensureSpace(30);

      // Date
      page.drawText(dateStr, {
        x: MARGIN + 20,
        y: cursorY,
        font,
        size: 9,
        color: rgb(0.1, 0.1, 0.1),
      });

      cursorY -= 15;

      // // Action with user name in bold
      // const actionText = action.includes(userName) ? action : `${userName} ${action}`;

      // Handle name in action text
      let actionText = action;

      // Extract name without nickname for comparison
      const nameWithoutNickname = userName.replace(/\s*\([^)]+\)\s*$/, '').trim();

      // Check if action already contains the full name with nickname
      if (action.includes(userName)) {
        // Already has full name with nickname, use as is
        actionText = action;
      } else if (action.includes(nameWithoutNickname)) {
        // Has name without nickname, replace with full name including nickname
        actionText = action.replace(nameWithoutNickname, userName);
      } else {
        // Name not found in action, prepend it
        actionText = `${userName} ${action}`;
      }

      page.drawText(`: ${actionText}`, {
        x: MARGIN + 35,
        y: cursorY,
        font,
        size: 9,
        color: rgb(0.3, 0.3, 0.3),
      });

      cursorY -= 20;
    }

    // Separator line (except last item)
    if (i < history.length - 1) {
      ensureSpace(20);
      page.drawLine({
        start: { x: MARGIN + 20, y: cursorY },
        end: { x: MARGIN + CONTENT_W - 20, y: cursorY },
        thickness: 0.5,
        color: rgb(0.85, 0.85, 0.85),
      });
      cursorY -= 15;
    }
  }
}

// Helper function to render comments section on a new page
async function renderCommentsSection(
  doc: PDFDocument,
  font: any,
  fkFont: any,
  comments: any[],
  memoNumberText: string,
  resolveAttPath: (url: string) => string,
  stampFont: any = null,
  memoId: number = 0
): Promise<void> {
  if (comments.length === 0) return;

  // Start new page for comments
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let cursorY = PAGE_H - MARGIN;
  let isFirstPage = true;

  // Fetch stamp data for comment pages
  const condActionsCountComm = memoId ? await prisma.memoApproverAction.count({
    where: { memoId, approveWithCondition: { not: null }, status: { code: "approved" } },
  }) : 0;
  const hasTerminateStampComm = memoId ? await prisma.memoApproverAction.count({
    where: { memoId, terminationReason: { not: null }, status: { code: "terminated" } },
  }) : 0;
  const extraLinesComm = memoId ? await prisma.extraApprovalLine.findMany({
    where: { memoId },
    include: { approvers: { include: { user: { select: { name: true, lastname: true, nickname: true } } } } },
  }) : [];
  const extraNamesCountComm = extraLinesComm.flatMap((l) => l.approvers).length;
  const extraLabelComm = extraNamesCountComm > 0 ? `Extra Approval (${extraNamesCountComm})` : "";
  const hasConditionStampComm = hasTerminateStampComm === 0 && condActionsCountComm > 0;
  const hasExtraStampComm = hasTerminateStampComm === 0 && extraLabelComm !== "";

  // Stamp memo number
  const sf = stampFont || font;
  const stampMemoNum = (pg: PDFPage) => {
    try {
      let stampY = PAGE_H - 10;
      const stampColor = rgb(0.39, 0.45, 0.55);
      const stampSize = 5;

      const labelText = "E-Approval No: ";
      const fullText = `${labelText}${memoNumberText}`;
      const tw = sf.widthOfTextAtSize(fullText, stampSize);
      pg.drawText(fullText, {
        x: PAGE_W - MARGIN - tw,
        y: stampY,
        font: sf,
        size: stampSize,
        color: stampColor,
      });
      stampY -= 8;

      if (hasConditionStampComm) {
        const label = `Approved with conditions (${condActionsCountComm})`;
        const lw = sf.widthOfTextAtSize(label, stampSize);
        pg.drawText(label, {
          x: PAGE_W - MARGIN - lw - 2,
          y: stampY,
          font: sf,
          size: stampSize,
          color: stampColor,
        });
        stampY -= 8;
      }

      if (hasExtraStampComm) {
        const ew = sf.widthOfTextAtSize(extraLabelComm, stampSize);
        pg.drawText(extraLabelComm, {
          x: PAGE_W - MARGIN - ew,
          y: stampY,
          font: sf,
          size: stampSize,
          color: stampColor,
        });
        stampY -= 8;
      }

      if (hasTerminateStampComm > 0) {
        const label = "Terminated";
        const lw = sf.widthOfTextAtSize(label, stampSize);
        pg.drawText(label, {
          x: PAGE_W - MARGIN - lw - 2,
          y: stampY,
          font: sf,
          size: stampSize,
          color: stampColor,
        });
      }
    } catch { }
  };
  stampMemoNum(page);

  // Draw page border and header
  const drawPageBorder = (pg: PDFPage, withHeader: boolean) => {
    // Outer border (full page)
    pg.drawRectangle({
      x: MARGIN,
      y: MARGIN + 20,
      width: CONTENT_W,
      height: PAGE_H - MARGIN - MARGIN - 20,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.8, 0.8, 0.8),
      borderWidth: 1,
    });

    if (withHeader) {
      // Header section with comment icon
      const headerH = 40;
      const headerY = PAGE_H - MARGIN - headerH;

      pg.drawRectangle({
        x: MARGIN,
        y: headerY,
        width: CONTENT_W,
        height: headerH,
        color: rgb(0.98, 0.98, 0.98),
      });

      // Comment icon (speech bubble)
      const iconX = MARGIN + 25;
      const iconY = PAGE_H - MARGIN - 20;

      // Outer rectangle
      pg.drawRectangle({
        x: iconX - 8,
        y: iconY - 6,
        width: 16,
        height: 12,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.3, 0.3, 0.3),
        borderWidth: 1.5,
      });

      // Inner lines (3 horizontal lines to represent text)
      const lineY1 = iconY + 2;
      const lineY2 = iconY;
      const lineY3 = iconY - 2;
      const lineStartX = iconX - 6;
      const lineEndX = iconX + 6;

      pg.drawLine({
        start: { x: lineStartX, y: lineY1 },
        end: { x: lineEndX, y: lineY1 },
        thickness: 1,
        color: rgb(0.3, 0.3, 0.3),
      });
      pg.drawLine({
        start: { x: lineStartX, y: lineY2 },
        end: { x: lineEndX, y: lineY2 },
        thickness: 1,
        color: rgb(0.3, 0.3, 0.3),
      });
      pg.drawLine({
        start: { x: lineStartX, y: lineY3 },
        end: { x: lineEndX, y: lineY3 },
        thickness: 1,
        color: rgb(0.3, 0.3, 0.3),
      });

      // Title
      pg.drawText("Comments", {
        x: iconX + 15,
        y: PAGE_H - MARGIN - 25,
        font,
        size: 12,
        color: rgb(0.1, 0.1, 0.1),
      });

      // Horizontal line below header
      pg.drawLine({
        start: { x: MARGIN, y: headerY },
        end: { x: MARGIN + CONTENT_W, y: headerY },
        thickness: 1,
        color: rgb(0.8, 0.8, 0.8),
      });
    }
  };

  const ensureSpace = (needH: number) => {
    if (cursorY - needH < MARGIN + 20) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      cursorY = PAGE_H - MARGIN;
      stampMemoNum(page);
      drawPageBorder(page, false); // Draw border without header on new pages
      isFirstPage = false;
    }
  };

  cursorY -= 10;
  ensureSpace(60);

  // Draw initial page border with header
  drawPageBorder(page, true);
  // Draw initial page border with header
  drawPageBorder(page, true);

  cursorY -= 50; // Space after header

  const IMG_THUMB = 70;
  const IMG_GAP = 6;
  const IMGS_PER_ROW = 6;
  const FILE_ROW_H = 30;

  const fmtDateTime = (v: unknown): string => {
    if (!v) return "-";
    const d = new Date(v as any);
    if (isNaN(d.getTime())) return "-";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mon = months[d.getMonth()];
    const day = d.getDate();
    const year = d.getFullYear();
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${mon} ${day}, ${year}, ${h}:${m}:${s} ${ampm}`;
  };

  const makeSignLabel = (u: {
    name?: string | null;
    lastname?: string | null;
    nickname?: string | null;
  }) => {
    const base = [u?.name, u?.lastname].filter(Boolean).join(" ").trim();
    const s = u?.nickname ? `${base} (${u.nickname})` : base || (u?.name ?? "");
    return cleanText(s);
  };

  for (let ci = 0; ci < comments.length; ci++) {
    const c = comments[ci];
    const userName = makeSignLabel(c.user);
    const dateStr = fmtDateTime(c.createdAt);
    const commentText = cleanText(c.comment);
    const commentLines = commentText ? wrapTextFk(fkFont, font, `: ${commentText}`, 9, CONTENT_W - 50) : [];

    // Attachments
    const imgAttachments = (c.attachments ?? []).filter((a: any) => a.mimetype?.startsWith("image/"));
    const fileAttachments = (c.attachments ?? []).filter((a: any) => !a.mimetype?.startsWith("image/"));
    const imgRowCount = imgAttachments.length > 0 ? Math.ceil(imgAttachments.length / IMGS_PER_ROW) : 0;
    const imageH = imgRowCount * (IMG_THUMB + IMG_GAP);
    const fileH = fileAttachments.length * FILE_ROW_H;

    const itemH = 25 + commentLines.length * LINE_H + imageH + fileH;
    ensureSpace(itemH + 25);

    let cy = cursorY;

    // User icon (person in circle)
    const userIconX = MARGIN + 25;
    const userIconY = cy - 5;

    // Outer circle (border)
    page.drawCircle({
      x: userIconX,
      y: userIconY,
      size: 7,
      borderColor: rgb(0.2, 0.2, 0.2),
      borderWidth: 1,
      color: rgb(1, 1, 1),
    });

    // Head (small circle)
    page.drawCircle({
      x: userIconX,
      y: userIconY + 1.5,
      size: 2,
      color: rgb(0.2, 0.2, 0.2),
    });

    // Body/shoulders (larger circle at bottom, partially visible)
    page.drawCircle({
      x: userIconX,
      y: userIconY - 3,
      size: 3.5,
      color: rgb(0.2, 0.2, 0.2),
    });

    // User name (bold)
    page.drawText(userName, {
      x: MARGIN + 35,
      y: cy - 8,
      font,
      size: 10,
      color: rgb(0.1, 0.1, 0.1),
    });

    // Date
    try {
      const nameW = font.widthOfTextAtSize(userName, 10);
      page.drawText(` At ${dateStr}`, {
        x: MARGIN + 35 + nameW,
        y: cy - 8,
        font,
        size: 8,
        color: rgb(0.5, 0.5, 0.5),
      });
    } catch { }

    cy -= 20;

    // Comment text — use shaped rendering for Thai GPOS support
    for (const line of commentLines) {
      drawShapedText(page, line, MARGIN + 25, cy, 9, fkFont, font, rgb(0.2, 0.2, 0.2));
      cy -= LINE_H;
    }

    // Embed images
    if (imgAttachments.length > 0) {
      cy -= 10;
      let imgX = MARGIN + 25;
      let imgColCount = 0;

      for (const att of imgAttachments) {
        try {
          const absPath = resolveAttPath(att.url);
          if (!fs.existsSync(absPath)) continue;

          const imgBytes = fs.readFileSync(absPath);
          let embeddedImg;

          if (att.mimetype === "image/png") {
            embeddedImg = await doc.embedPng(imgBytes);
          } else {
            try {
              embeddedImg = await doc.embedJpg(imgBytes);
            } catch {
              embeddedImg = await doc.embedPng(imgBytes);
            }
          }

          const scale = Math.min(IMG_THUMB / embeddedImg.width, IMG_THUMB / embeddedImg.height);
          const drawW = embeddedImg.width * scale;
          const drawH = embeddedImg.height * scale;

          if (imgColCount >= IMGS_PER_ROW) {
            imgX = MARGIN + 25;
            cy -= IMG_THUMB + IMG_GAP;
            imgColCount = 0;
          }

          page.drawImage(embeddedImg, {
            x: imgX,
            y: cy - drawH,
            width: drawW,
            height: drawH,
          });

          imgX += IMG_THUMB + IMG_GAP;
          imgColCount++;
        } catch (imgErr) {
          console.warn(`[pdf] failed to embed comment image: ${att.url}`, imgErr);
        }
      }
      cy -= IMG_THUMB + IMG_GAP;
    }

    // Render file attachments
    if (fileAttachments.length > 0) {
      cy -= 8;
      for (const att of fileAttachments) {
        try {
          const boxX = MARGIN + 25;
          const boxW = CONTENT_W * 0.5;
          const boxH = 28;

          page.drawRectangle({
            x: boxX,
            y: cy - boxH,
            width: boxW,
            height: boxH,
            color: rgb(1, 1, 1),
            borderColor: rgb(0.8, 0.8, 0.8),
            borderWidth: 1,
          });

          // File icon
          const iconX = boxX + 10;
          const iconY = cy - boxH + 7;
          page.drawRectangle({
            x: iconX,
            y: iconY,
            width: 12,
            height: 14,
            color: rgb(1, 1, 1),
            borderColor: rgb(0.5, 0.5, 0.5),
            borderWidth: 1,
          });

          const displayName = cleanText(att.filename || "attachment");
          const maxNameW = boxW - 45;
          let truncName = displayName;
          try {
            while (font.widthOfTextAtSize(truncName, 9) > maxNameW && truncName.length > 3) {
              truncName = truncName.slice(0, -4) + "...";
            }
          } catch { }
          page.drawText(truncName, {
            x: iconX + 18,
            y: cy - boxH + 10,
            font,
            size: 9,
            color: rgb(0.2, 0.2, 0.2),
          });

          cy -= FILE_ROW_H;
        } catch (fileErr) {
          console.warn(`[pdf] failed to render file attachment: ${att.url}`, fileErr);
        }
      }
    }

    cursorY = cy - 0;

    // Separator line between comments (except last)
    if (ci < comments.length - 1) {
      page.drawLine({
        start: { x: MARGIN + 20, y: cursorY },
        end: { x: MARGIN + CONTENT_W - 20, y: cursorY },
        thickness: 0.5,
        color: rgb(0.85, 0.85, 0.85),
      });
      cursorY -= 10;
    }
  }
}

async function appendConditionTerminateAndCommentPages(
  doc: PDFDocument,
  font: any,
  fkFont: any,
  memoId: number,
  memoNumberText: string,
  stampFont: any = null,
): Promise<void> {
  //console.log(`[PDF appendConditionTerminate] Called for memo ${memoId}`);

  // 1) Fetch approve-with-condition records
  const conditionActions = await prisma.memoApproverAction.findMany({
    where: {
      memoId,
      approveWithCondition: { not: null },
      status: { code: "approved" },
    },
    include: {
      loaUser: {
        select: {
          userId: true,
          level: true,
          user: { select: { id: true, name: true, lastname: true, nickname: true } },
        },
      },
      status: true,
    },
    orderBy: { actedAt: "asc" },
  });

  // 1.5) Fetch terminate actions
  const terminateActions = await prisma.memoApproverAction.findMany({
    where: {
      memoId,
      terminationReason: { not: null },
      status: { code: "terminated" },
    },
    include: {
      loaUser: {
        include: {
          user: { select: { id: true, name: true, lastname: true, nickname: true } },
        },
      },
      status: true,
    },
    orderBy: { actedAt: "asc" },
  });

  // Fallback: ถ้าไม่เจอใน memoApproverAction ให้ดึงจาก history
  if (terminateActions.length === 0) {
    const terminateHistory = await prisma.memoHistory.findFirst({
      where: {
        memoId,
        action: { contains: "terminated the memo:" },
      },
      include: {
        user: { select: { id: true, name: true, lastname: true, nickname: true } },
      },
      orderBy: { timestamp: "desc" },
    });

    if (terminateHistory) {
      const reasonMatch = terminateHistory.action.match(/terminated the memo:\s*(.+)/i);
      if (reasonMatch) {
        const reason = reasonMatch[1].trim();
        terminateActions.push({
          id: terminateHistory.id,
          memoId,
          loaUserId: 0,
          statusId: 0,
          version: 0,
          signatureImageId: null,
          signatureText: null,
          actedAt: terminateHistory.timestamp,
          createdAt: terminateHistory.timestamp,
          updatedAt: terminateHistory.timestamp,
          approveWithCondition: null,
          terminationReason: reason,
          actualActorId: null,
          loaUser: {
            id: 0,
            loaId: 0,
            userId: terminateHistory.userId,
            level: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            user: terminateHistory.user,
          },
          status: {
            id: 0,
            code: "terminated",
            label: "Terminated",
            isFinal: true,
            createdAt: new Date(),
            updatedAt: new Date(),
          },
        } as any);
      }
    }
  }

  // 2) Fetch comments with attachments
  const comments = await prisma.comment.findMany({
    where: { memoId },
    include: {
      user: { select: { id: true, name: true, lastname: true, nickname: true } },
      attachments: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // 3) Fetch extra approval lines with approvers and linked comment
  const extraLines = await prisma.extraApprovalLine.findMany({
    where: { memoId },
    include: {
      comment: {
        select: {
          comment: true,
          user: { select: { name: true, lastname: true, nickname: true } },
        },
      },
      approvers: {
        include: {
          user: { select: { name: true, lastname: true, nickname: true } },
          status: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  // Build extra approval label: "Extra Approval : Name Lastname (Nickname), ... (count)"
  const extraApproverNames = extraLines
    .flatMap((line) => line.approvers)
    .map((a) => {
      const parts = [a.user.name, a.user.lastname].filter(Boolean).join(" ");
      return a.user.nickname ? `${parts} (${a.user.nickname})` : parts;
    });
  // const extraLabel = extraApproverNames.length > 0
  //   ? `Extra Approval (${extraApproverNames.length}) : ${extraApproverNames.join(", ")} `
  //   : "";
  const extraLabel = extraApproverNames.length > 0
    ? `Extra Approval (${extraApproverNames.length})`
    : "";

  // Check if memo has terminate actions
  const hasTerminateActions = terminateActions.length > 0;

  //console.log(`[PDF appendConditionTerminate] conditionActions=${conditionActions.length}, terminateActions=${terminateActions.length}`);

  // Determine what content will actually be rendered on this page:
  // - Condition section only renders when there ARE conditions AND memo is NOT terminated
  // - Terminate section is disabled (commented out) — so terminate-only produces a blank page
  // - Extra approval section renders when there are extra lines
  const hasConditionContent = conditionActions.length > 0 && !hasTerminateActions;
  const hasExtraContent = extraLines.length > 0;

  if (!hasConditionContent && !hasExtraContent) {
    //console.log(`[PDF appendConditionTerminate] Skipping - no renderable content (terminate section disabled, conditions=${conditionActions.length}, hasTerminate=${hasTerminateActions}, extra=${extraLines.length})`);
    return;
  }

  //console.log(`[PDF appendConditionTerminate] Creating page for condition/extra (conditions=${conditionActions.length}, terminate=${terminateActions.length}, extra=${extraLines.length})`);
  
  // State
  let page = doc.addPage([PAGE_W, PAGE_H]);
  let cursorY = PAGE_H - MARGIN;

  // Status label for stamp
  const conditionCount = conditionActions.length;
  const statusLabel = hasTerminateActions
    ? "Terminated"
    : conditionCount > 0
      ? `Approved with conditions (${conditionCount})`
      : ""; // Don't show "Approved with condition" if there are no condition actions

  const sf = stampFont || font;
  const stampMemoNum = (pg: PDFPage) => {
    try {
      let stampY = PAGE_H - 10;
      const stampColor = rgb(0.39, 0.45, 0.55);
      const stampSize = 5;

      const labelText = "E-Approval No: ";
      const fullText = `${labelText}${memoNumberText}`;
      const tw = sf.widthOfTextAtSize(fullText, stampSize);
      pg.drawText(fullText, {
        x: PAGE_W - MARGIN - tw,
        y: stampY,
        font: sf,
        size: stampSize,
        color: stampColor,
      });
      stampY -= 8;

      // Only draw status label if it's not empty
      if (statusLabel) {
        const lw = sf.widthOfTextAtSize(statusLabel, stampSize);
        pg.drawText(statusLabel, {
          x: PAGE_W - MARGIN - lw,
          y: stampY,
          font: sf,
          size: stampSize,
          color: stampColor,
        });
        stampY -= 8;
      }

      if (extraLabel) {
        const ew = sf.widthOfTextAtSize(extraLabel, stampSize);
        pg.drawText(extraLabel, {
          x: PAGE_W - MARGIN - ew,
          y: stampY,
          font: sf,
          size: stampSize,
          color: stampColor,
        });
        stampY -= 8;
      }

    } catch { };
  };
  stampMemoNum(page);

  // ========== NO PAGE TITLE (cleaner design) ==========
  // Just add some top spacing
  cursorY -= 10;

  const ensureSpace = (needH: number) => {
    if (cursorY - needH < MARGIN + 20) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      cursorY = PAGE_H - MARGIN;
      stampMemoNum(page);
    }
  };

  // ---------- Helpers ----------
  const INNER_MARGIN = 14;
  const CARD_PAD = 12;
  const IMG_THUMB = 70;
  const IMG_GAP = 6;
  const IMGS_PER_ROW = 6;
  const FILE_ROW_H = 30;
  const GRAY = rgb(0.4, 0.4, 0.4);
  const LIGHT_GRAY = rgb(0.75, 0.75, 0.75);
  const DARK = rgb(0.1, 0.1, 0.1);
  const GREEN = rgb(0.13, 0.55, 0.13);

  /** Format date as "Feb 11, 2026, 11:48:03 AM" */
  const fmtDateTime = (v: unknown): string => {
    if (!v) return "-";
    const d = new Date(v as any);
    if (isNaN(d.getTime())) return "-";
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    const mon = months[d.getMonth()];
    const day = d.getDate();
    const year = d.getFullYear();
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, "0");
    const s = String(d.getSeconds()).padStart(2, "0");
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${mon} ${day}, ${year}, ${h}:${m}:${s} ${ampm}`;
  };

  /** Draw outer card border and return inner content area x */
  const drawCardBorder = (pg: PDFPage, y: number, h: number) => {
    pg.drawRectangle({
      x: MARGIN,
      y: y - h,
      width: CONTENT_W,
      height: h,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.2, 0.2, 0.2),
      borderWidth: 0.7,
    });
  };

  /** Resolve comment attachment file path */
  const resolveAttPath = (url: string) => {
    const diskName = path.basename((url || "").replace(/\\/g, "/"));
    return path.join(UPLOADS_DIR, "comments", diskName);
  };

  // Helper to draw simple card with shadow
  const drawCard = (pg: PDFPage, x: number, y: number, w: number, h: number, bgColor: any, borderColor: any) => {
    // Shadow layer
    pg.drawRectangle({
      x: x + 2,
      y: y - 2,
      width: w,
      height: h,
      color: rgb(0.88, 0.88, 0.88),
    });
    // Main card
    pg.drawRectangle({
      x,
      y,
      width: w,
      height: h,
      color: bgColor,
      borderColor,
      borderWidth: 1,
    });
  };

  // Helper to draw section header
  const drawSectionHeader = (pg: PDFPage, y: number, title: string, iconColor: any) => {
    const headerH = 32;
    const headerY = y - headerH;

    // Header background
    pg.drawRectangle({
      x: MARGIN,
      y: headerY,
      width: CONTENT_W,
      height: headerH,
      color: rgb(0.97, 0.97, 0.97),
      borderColor: rgb(0.85, 0.85, 0.85),
      borderWidth: 1,
    });

    // Left accent bar
    pg.drawRectangle({
      x: MARGIN,
      y: headerY,
      width: 4,
      height: headerH,
      color: iconColor,
    });

    // Title text
    pg.drawText(title, {
      x: MARGIN + 16,
      y: headerY + 10,
      font,
      size: 13,
      color: rgb(0.2, 0.2, 0.2),
    });

    return headerH;
  };

  // Helper to draw dashed line separator
  const drawDashedLine = (pg: PDFPage, y: number) => {
    const dashLength = 8;
    const gapLength = 4;
    let x = MARGIN;
    while (x < MARGIN + CONTENT_W) {
      pg.drawLine({
        start: { x, y },
        end: { x: Math.min(x + dashLength, MARGIN + CONTENT_W), y },
        thickness: 1,
        color: rgb(0.9, 0.5, 0.5),
      });
      x += dashLength + gapLength;
    }
  };

  // ======== Section: Approve With Condition ========
  // Skip this section if memo is terminated
  if (conditionActions.length > 0 && !hasTerminateActions) {
    ensureSpace(80);

    // Main container border
    const totalH = conditionActions.reduce((sum, cond) => {
      const condText = cleanText(cond.approveWithCondition ?? "");
      const condLines = wrapTextFk(fkFont, font, condText, 9, CONTENT_W - 40);
      return sum + 80 + condLines.length * LINE_H + 20;
    }, 50);

    ensureSpace(totalH);

    const containerY = cursorY;

    // Outer border
    page.drawRectangle({
      x: MARGIN,
      y: containerY - totalH,
      width: CONTENT_W,
      height: totalH,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.8, 0.8, 0.8),
      borderWidth: 1,
    });

    // Header section with green checkmark
    const headerH = 40;
    page.drawRectangle({
      x: MARGIN,
      y: containerY - headerH,
      width: CONTENT_W,
      height: headerH,
      color: rgb(0.98, 0.98, 0.98),
    });

    // Green checkmark circle
    const checkX = MARGIN + 25;
    const checkY = containerY - 20;
    page.drawCircle({
      x: checkX,
      y: checkY,
      size: 10,
      color: rgb(0.2, 0.7, 0.3),
    });

    // Checkmark symbol
    page.drawLine({
      start: { x: checkX - 4, y: checkY },
      end: { x: checkX - 1, y: checkY - 4 },
      thickness: 2,
      color: rgb(1, 1, 1),
    });
    page.drawLine({
      start: { x: checkX - 1, y: checkY - 4 },
      end: { x: checkX + 5, y: checkY + 4 },
      thickness: 2,
      color: rgb(1, 1, 1),
    });

    // Title
    page.drawText("Approved With Conditions", {
      x: checkX + 20,
      y: containerY - 25,
      font,
      size: 12,
      color: rgb(0.1, 0.1, 0.1),
    });

    // Horizontal line below header
    page.drawLine({
      start: { x: MARGIN, y: containerY - headerH },
      end: { x: MARGIN + CONTENT_W, y: containerY - headerH },
      thickness: 1,
      color: rgb(0.8, 0.8, 0.8),
    });

    cursorY -= headerH + 15;

    for (let i = 0; i < conditionActions.length; i++) {
      const cond = conditionActions[i];
      const userName = makeSignLabel(cond.loaUser?.user ?? { name: "Unknown" });
      // Convert 0-based level to 1-based for display
      const rawLevel = cond.loaUser?.level;
      const level = rawLevel != null && rawLevel >= 0 ? rawLevel + 1 : 1;
      const dateStr = fmtDateTime(cond.actedAt);
      const statusName = cond.status?.label ?? "Approved";
      const condText = cleanText(cond.approveWithCondition ?? "");
      const condLines = wrapTextFk(fkFont, font, condText, 9, CONTENT_W - 50);

      const itemH = 80 + condLines.length * LINE_H;
      ensureSpace(itemH + 20);

      let cy = cursorY;

      // Approved By + Level (same line)
      page.drawText("Approved By: ", {
        x: MARGIN + 20,
        y: cy,
        font,
        size: 9,
        color: rgb(0.2, 0.2, 0.2),
      });

      try {
        const labelW = font.widthOfTextAtSize("Approved By: ", 9);
        page.drawText(userName, {
          x: MARGIN + 20 + labelW,
          y: cy,
          font,
          size: 9,
          color: rgb(0.1, 0.1, 0.1),
        });

        const nameW = font.widthOfTextAtSize(userName, 9);
        page.drawText(`   Level: ${level}`, {
          x: MARGIN + 20 + labelW + nameW,
          y: cy,
          font,
          size: 9,
          color: rgb(0.2, 0.2, 0.2),
        });
      } catch { }

      cy -= 16;

      // Approved At
      page.drawText("Approved At: ", {
        x: MARGIN + 20,
        y: cy,
        font,
        size: 9,
        color: rgb(0.2, 0.2, 0.2),
      });

      try {
        const labelW = font.widthOfTextAtSize("Approved At: ", 9);
        page.drawText(dateStr, {
          x: MARGIN + 20 + labelW,
          y: cy,
          font,
          size: 9,
          color: rgb(0.1, 0.1, 0.1),
        });
      } catch { }

      cy -= 16;

      // Status with green badge
      page.drawText("Status: ", {
        x: MARGIN + 20,
        y: cy,
        font,
        size: 9,
        color: rgb(0.2, 0.2, 0.2),
      });

      try {
        const labelW = font.widthOfTextAtSize("Status: ", 9);
        page.drawText(statusName, {
          x: MARGIN + 20 + labelW,
          y: cy,
          font,
          size: 9,
          color: rgb(0.2, 0.7, 0.3),
        });
      } catch { }

      cy -= 16;

      // Approval Conditions label
      page.drawText("Approval Conditions:", {
        x: MARGIN + 20,
        y: cy,
        font,
        size: 9,
        color: rgb(0.2, 0.2, 0.2),
      });

      cy -= 14;

      // Condition text box with light gray background
      const boxH = condLines.length * LINE_H + 12;
      page.drawRectangle({
        x: MARGIN + 20,
        y: cy - boxH + 6,
        width: CONTENT_W - 40,
        height: boxH,
        color: rgb(0.96, 0.96, 0.96),
      });

      cy -= 6;

      for (const line of condLines) {
        drawShapedText(page, line, MARGIN + 28, cy, 9, fkFont, font, rgb(0.3, 0.3, 0.3));
        cy -= LINE_H;
      }

      cursorY = cy - 20;

      // Separator line between items (except last)
      if (i < conditionActions.length - 1) {
        page.drawLine({
          start: { x: MARGIN + 20, y: cursorY },
          end: { x: MARGIN + CONTENT_W - 20, y: cursorY },
          thickness: 0.5,
          color: rgb(0.85, 0.85, 0.85),
        });
        cursorY -= 15;
      }
    }

    cursorY -= 30;
  }

  // ======== Section: Terminate With Condition ========
  // DISABLED: Terminate condition now shows in History section only
  /*
  if (terminateActions.length > 0) {
    ensureSpace(80);

    // Calculate total height
    const totalH = terminateActions.reduce((sum, term) => {
      const reasonText = cleanText(term.terminationReason ?? "");
      const reasonLines = wrapText(font, reasonText, 9, CONTENT_W - 40);
      return sum + 80 + reasonLines.length * LINE_H + 20;
    }, 50);

    ensureSpace(totalH);

    const containerY = cursorY;

    // Outer border
    page.drawRectangle({
      x: MARGIN,
      y: containerY - totalH,
      width: CONTENT_W,
      height: totalH,
      color: rgb(1, 1, 1),
      borderColor: rgb(0.8, 0.8, 0.8),
      borderWidth: 1,
    });

    // Header section with red warning icon
    const headerH = 40;
    page.drawRectangle({
      x: MARGIN,
      y: containerY - headerH,
      width: CONTENT_W,
      height: headerH,
      color: rgb(0.98, 0.98, 0.98),
    });

    // Red warning triangle icon
    const iconX = MARGIN + 25;
    const iconY = containerY - 20;
    page.drawCircle({
      x: iconX,
      y: iconY,
      size: 10,
      color: rgb(0.9, 0.2, 0.2),
    });

    // Warning symbol (!)
    page.drawText("!", {
      x: iconX - 2,
      y: iconY - 4,
      font,
      size: 14,
      color: rgb(1, 1, 1),
    });

    // Title
    page.drawText("Terminate Condition", {
      x: iconX + 20,
      y: containerY - 25,
      font,
      size: 12,
      color: rgb(0.1, 0.1, 0.1),
    });

    // Horizontal line below header
    page.drawLine({
      start: { x: MARGIN, y: containerY - headerH },
      end: { x: MARGIN + CONTENT_W, y: containerY - headerH },
      thickness: 1,
      color: rgb(0.8, 0.8, 0.8),
    });

    cursorY -= headerH + 15;

    for (let i = 0; i < terminateActions.length; i++) {
      const term = terminateActions[i];
      const userName = makeSignLabel(term.loaUser?.user ?? { name: "Unknown" });
      // Convert 0-based level to 1-based for display
      const rawLevel = term.loaUser?.level;
      const level = rawLevel != null && rawLevel >= 0 ? rawLevel + 1 : 1;
      const dateStr = fmtDateTime(term.actedAt);
      const statusName = term.status?.label ?? "Terminated";
      const reasonText = cleanText(term.terminationReason ?? "");
      const reasonLines = wrapText(font, reasonText, 9, CONTENT_W - 50);

      const itemH = 80 + reasonLines.length * LINE_H;
      ensureSpace(itemH + 20);

      let cy = cursorY;

      // Terminated By + Level (same line)
      page.drawText("Terminated By: ", {
        x: MARGIN + 20,
        y: cy,
        font,
        size: 9,
        color: rgb(0.2, 0.2, 0.2),
      });

      try {
        const labelW = font.widthOfTextAtSize("Terminated By: ", 9);
        page.drawText(userName, {
          x: MARGIN + 20 + labelW,
          y: cy,
          font,
          size: 9,
          color: rgb(0.1, 0.1, 0.1),
        });

        const nameW = font.widthOfTextAtSize(userName, 9);
        page.drawText(`   Level: ${level}`, {
          x: MARGIN + 20 + labelW + nameW,
          y: cy,
          font,
          size: 9,
          color: rgb(0.2, 0.2, 0.2),
        });
      } catch { }

      cy -= 16;

      // Terminated At
      page.drawText("Terminated At: ", {
        x: MARGIN + 20,
        y: cy,
        font,
        size: 9,
        color: rgb(0.2, 0.2, 0.2),
      });

      try {
        const labelW = font.widthOfTextAtSize("Terminated At: ", 9);
        page.drawText(dateStr, {
          x: MARGIN + 20 + labelW,
          y: cy,
          font,
          size: 9,
          color: rgb(0.1, 0.1, 0.1),
        });
      } catch { }

      cy -= 16;

      // Status with red badge
      page.drawText("Status: ", {
        x: MARGIN + 20,
        y: cy,
        font,
        size: 9,
        color: rgb(0.2, 0.2, 0.2),
      });

      try {
        const labelW = font.widthOfTextAtSize("Status: ", 9);
        page.drawText(statusName, {
          x: MARGIN + 20 + labelW,
          y: cy,
          font,
          size: 9,
          color: rgb(0.9, 0.2, 0.2),
        });
      } catch { }

      cy -= 16;

      // Termination Condition label
      page.drawText("Termination Condition:", {
        x: MARGIN + 20,
        y: cy,
        font,
        size: 9,
        color: rgb(0.2, 0.2, 0.2),
      });

      cy -= 14;

      // Condition text box with light gray background
      const boxH = reasonLines.length * LINE_H + 12;
      page.drawRectangle({
        x: MARGIN + 20,
        y: cy - boxH + 6,
        width: CONTENT_W - 40,
        height: boxH,
        color: rgb(0.96, 0.96, 0.96),
      });

      cy -= 6;

      for (const line of reasonLines) {
        page.drawText(line, {
          x: MARGIN + 28,
          y: cy,
          font,
          size: 9,
          color: rgb(0.3, 0.3, 0.3),
        });
        cy -= LINE_H;
      }

      cursorY = cy - 20;

      // Separator line between items (except last)
      if (i < terminateActions.length - 1) {
        page.drawLine({
          start: { x: MARGIN + 20, y: cursorY },
          end: { x: MARGIN + CONTENT_W - 20, y: cursorY },
          thickness: 0.5,
          color: rgb(0.85, 0.85, 0.85),
        });
        cursorY -= 15;
      }
    }

    cursorY -= 30;
  }
  */

  // ======== Section: Extra Approval Lines ========
  if (extraLines.length > 0) {
    ensureSpace(60);

    for (const extra of extraLines) {
      for (const a of extra.approvers) {
        const aName = makeSignLabel(a.user);
        const aStatus = a.status?.name ?? "Waiting";
        const aDate = a.actedAt ? fmtDateTime(a.actedAt) : "";

        const commentText = extra.comment?.[0] ? cleanText(extra.comment[0].comment) : "";
        const commentLines = commentText ? wrapTextFk(fkFont, font, commentText, 9, CONTENT_W - 50) : [];

        // Calculate total height: header + content
        const headerH = 40;
        // Base content height for fields (Approved By, Approved At, Status)
        const baseContentH = 60; // 3 fields × 15pt + spacing
        // Add comment section height if there are comments
        const commentSectionH = commentLines.length > 0
          ? 14 + (commentLines.length * LINE_H + 10) + 5 // "Comment / Reason:" label + box + spacing
          : 0;
        const contentH = baseContentH + commentSectionH;
        const totalH = headerH + contentH;

        ensureSpace(totalH + 20);

        const containerY = cursorY;

        // Draw outer border for entire card (header + content)
        page.drawRectangle({
          x: MARGIN,
          y: containerY - totalH,
          width: CONTENT_W,
          height: totalH,
          color: rgb(1, 1, 1),
          borderColor: rgb(0.8, 0.8, 0.8),
          borderWidth: 1,
        });

        // Draw header background (lighter gray)
        page.drawRectangle({
          x: MARGIN,
          y: containerY - headerH,
          width: CONTENT_W,
          height: headerH,
          color: rgb(0.98, 0.98, 0.98),
          borderWidth: 0,
        });

        // Green circle with plus icon
        const iconX = MARGIN + 30;
        const iconY = containerY - 20;

        page.drawCircle({
          x: iconX,
          y: iconY,
          size: 10,
          color: rgb(0.2, 0.5, 0.9), // Blue color
        });

        // Plus symbol
        page.drawLine({
          start: { x: iconX - 5, y: iconY },
          end: { x: iconX + 5, y: iconY },
          thickness: 2,
          color: rgb(1, 1, 1),
        });
        page.drawLine({
          start: { x: iconX, y: iconY - 5 },
          end: { x: iconX, y: iconY + 5 },
          thickness: 2,
          color: rgb(1, 1, 1),
        });

        // Title
        page.drawText("Extra Approval Requests", {
          x: iconX + 20,
          y: containerY - 25,
          font,
          size: 12,
          color: rgb(0.1, 0.1, 0.1),
        });

        // Horizontal line below header
        page.drawLine({
          start: { x: MARGIN, y: containerY - headerH },
          end: { x: MARGIN + CONTENT_W, y: containerY - headerH },
          thickness: 1,
          color: rgb(0.8, 0.8, 0.8),
        });

        let cy = containerY - headerH - 15;

        // Approved By
        page.drawText("Approved By: ", {
          x: MARGIN + 20,
          y: cy,
          font,
          size: 9,
          color: rgb(0.2, 0.2, 0.2),
        });
        page.drawText(aName, {
          x: MARGIN + 95,
          y: cy,
          font,
          size: 9,
          color: rgb(0.1, 0.1, 0.1),
        });
        cy -= 15;

        // Approved At
        page.drawText("Approved At: ", {
          x: MARGIN + 20,
          y: cy,
          font,
          size: 9,
          color: rgb(0.2, 0.2, 0.2),
        });
        page.drawText(aDate || "-", {
          x: MARGIN + 95,
          y: cy,
          font,
          size: 9,
          color: rgb(0.1, 0.1, 0.1),
        });
        cy -= 15;

        // Status
        const statusColor = aStatus === "Approved" ? rgb(0.4, 0.7, 0.3) : aStatus === "Rejected" ? rgb(0.8, 0.2, 0.2) : rgb(0.6, 0.6, 0.6);
        page.drawText("Status: ", {
          x: MARGIN + 20,
          y: cy,
          font,
          size: 9,
          color: rgb(0.2, 0.2, 0.2),
        });
        page.drawText(aStatus, {
          x: MARGIN + 95,
          y: cy,
          font,
          size: 9,
          color: statusColor,
        });
        cy -= 18;

        // Comment / Reason
        if (commentLines.length > 0) {
          page.drawText("Comment / Reason:", {
            x: MARGIN + 20,
            y: cy,
            font,
            size: 9,
            color: rgb(0.2, 0.2, 0.2),
          });
          cy -= 14;

          // Draw comment box with light gray background
          const commentBoxH = commentLines.length * LINE_H + 10;
          page.drawRectangle({
            x: MARGIN + 20,
            y: cy - commentBoxH + 6,
            width: CONTENT_W - 40,
            height: commentBoxH,
            color: rgb(0.96, 0.96, 0.96),
          });

          cy -= 5;
          for (const line of commentLines) {
            drawShapedText(page, line, MARGIN + 35, cy, 9, fkFont, font, rgb(0.25, 0.25, 0.25));
            cy -= LINE_H;
          }
        }

        cursorY -= totalH + 15;
      }
    }

    cursorY -= 10;
  }

  // Note: Comments and History sections are now rendered separately in main function
}

/* ================================================================
 * COMMENT-ONLY PDF PAGES (general case — no condition/termination)
 * ================================================================ */

async function appendCommentOnlyPages(
  doc: PDFDocument,
  font: any,
  fkFont: any,
  memoId: number,
  memoNumberText: string,
  stampFont: any = null,
): Promise<void> {
  //console.log(`[PDF appendCommentOnly] Called for memo ${memoId}`);

  // Fetch comments with attachments
  const comments = await prisma.comment.findMany({
    where: { memoId },
    include: {
      user: { select: { id: true, name: true, lastname: true, nickname: true } },
      attachments: true,
    },
    orderBy: { createdAt: "asc" },
  });

  //console.log(`[PDF appendCommentOnly] Found ${comments.length} comments`);

  if (comments.length === 0) {
    //console.log(`[PDF appendCommentOnly] Skipping - no comments`);
    return;
  }

  const resolveAttPath = (url: string) => {
    const diskName = path.basename((url || "").replace(/\\/g, "/"));
    return path.join(UPLOADS_DIR, "comments", diskName);
  };

  // Render comments using the shared function
  await renderCommentsSection(doc, font, fkFont, comments, memoNumberText, resolveAttPath, stampFont, memoId);
}

/* ================================================================
 * WRAPPER FUNCTIONS สำหรับ backward compatibility
 * ================================================================ */

/**
 * สำหรับ email/archive - เฉพาะคนที่ approved
 */
export async function createSignedPdfBuffer(memoId: number): Promise<Buffer> {
  const merged = await renderPdfWithSignatures({
    memoId,
    mode: "final",
  });

  const pdfBytes = await merged.save();
  return Buffer.from(pdfBytes);
}

/**
 * สำหรับ download - รองรับ preview mode
 */
export async function createPdfForDownload(
  memoId: number,
  showDraft: boolean
): Promise<PDFDocument> {
  return renderPdfWithSignatures({
    memoId,
    mode: showDraft ? "preview" : "final",
  });
}