/**
 * Shrink uploaded PDFs (mostly 1–8 MB scans) with Ghostscript, in place.
 *
 * Safety rules: the result replaces the original only when it is clearly smaller
 * AND every page keeps its count, rotation and visual size (signature positions
 * are stored as page percentages). Anything unexpected keeps the original:
 * compression is an optimisation, never a reason for an upload to fail.
 *
 * Off switch: PDF_COMPRESS=off. Without a `gs` binary (local Windows dev) it is a no-op.
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import { Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';

const logger = new Logger('PdfCompress');

export const MIN_BYTES = 300 * 1024;
/** keep the result only if it saves at least this share */
export const MIN_SAVING = 0.1;
const TIMEOUT_MS = 60_000;
const MAX_PARALLEL = 2; // t3.medium, no swap

export const GS_ARGS = [
  '-sDEVICE=pdfwrite',
  '-dNOPAUSE',
  '-dBATCH',
  '-dQUIET',
  '-dSAFER',
  '-dCompatibilityLevel=1.5',
  // never let gs "fix" orientation: pages must keep /Rotate and size
  '-dAutoRotatePages=/None',
  '-dDetectDuplicateImages=true',
  '-dDownsampleColorImages=true',
  '-dColorImageDownsampleType=/Bicubic',
  '-dColorImageResolution=200',
  '-dDownsampleGrayImages=true',
  '-dGrayImageDownsampleType=/Bicubic',
  '-dGrayImageResolution=200',
  '-dDownsampleMonoImages=true',
  '-dMonoImageResolution=300',
  // only touch images clearly above the target
  '-dColorImageDownsampleThreshold=1.5',
  '-dGrayImageDownsampleThreshold=1.5',
  '-dJPEGQ=80',
];

type Geometry = { n: number; pages: Array<{ rot: number; w: number; h: number }> };

async function geometry(bytes: Uint8Array): Promise<Geometry> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return {
    n: doc.getPageCount(),
    pages: doc.getPages().map((p) => {
      const { width, height } = p.getCropBox();
      return { rot: ((p.getRotation().angle % 360) + 360) % 360, w: Math.abs(width), h: Math.abs(height) };
    }),
  };
}

/** same page count, and per page the same rotation and visual size (±0.5pt, rotation-aware) */
export function sameGeometry(a: Geometry, b: Geometry): boolean {
  if (a.n !== b.n) return false;
  const vis = (p: Geometry['pages'][number]) => (p.rot % 180 === 0 ? [p.w, p.h] : [p.h, p.w]);
  return a.pages.every((p, i) => {
    const [aw, ah] = vis(p);
    const [bw, bh] = vis(b.pages[i]);
    return Math.abs(aw - bw) <= 0.5 && Math.abs(ah - bh) <= 0.5;
  });
}

// ── tiny queue so a 50-file upload doesn't start 50 Ghostscripts ────────────
let running = 0;
const waiting: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

let gsMissing = false;
export const runGs = (input: string, output: string): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile('gs', [...GS_ARGS, `-sOutputFile=${output}`, input], { timeout: TIMEOUT_MS }, (err) =>
      err ? reject(err) : resolve(),
    );
  });

export type CompressResult = { compressed: boolean; size: number; reason?: string };

export async function compressPdfInPlace(
  absPath: string,
  deps: { gs?: typeof runGs } = {},
): Promise<CompressResult> {
  const gs = deps.gs ?? runGs;
  let size = 0;
  try {
    size = fs.statSync(absPath).size;
  } catch {
    return { compressed: false, size: 0, reason: 'missing' };
  }
  if (process.env.PDF_COMPRESS === 'off') return { compressed: false, size, reason: 'disabled' };
  if (gsMissing) return { compressed: false, size, reason: 'no-gs' };
  if (size < MIN_BYTES) return { compressed: false, size, reason: 'small' };

  const original = fs.readFileSync(absPath);
  // digitally signed: rewriting would break the signature
  if (original.includes('/ByteRange')) return { compressed: false, size, reason: 'signed' };

  let before: Geometry;
  try {
    before = await geometry(original); // throws on encrypted / broken files
  } catch {
    return { compressed: false, size, reason: 'unreadable' };
  }

  const tmp = `${absPath}.gs-${process.pid}-${Date.now()}.pdf`;
  try {
    await withSlot(() => gs(absPath, tmp));
    const out = fs.readFileSync(tmp);
    if (out.length > size * (1 - MIN_SAVING)) return { compressed: false, size, reason: 'not-smaller' };
    if (!sameGeometry(before, await geometry(out))) {
      logger.warn(`page geometry changed, kept original: ${absPath}`);
      return { compressed: false, size, reason: 'geometry' };
    }
    fs.renameSync(tmp, absPath);
    logger.log(`${absPath}: ${size} → ${out.length} bytes`);
    return { compressed: true, size: out.length };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // spawn ENOENT = no gs binary (an ENOENT reading tmp just means gs wrote nothing)
    if (e.code === 'ENOENT' && String(e.syscall ?? '').startsWith('spawn')) {
      gsMissing = true;
      logger.warn('ghostscript (gs) not found: PDF compression disabled');
      return { compressed: false, size, reason: 'no-gs' };
    }
    logger.warn(`compression failed, kept original: ${absPath}: ${e.message}`);
    return { compressed: false, size, reason: 'error' };
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/** Compress the PDFs among multer files and update their .size. Never throws. */
export async function compressUploadedPdfs(files: Express.Multer.File[]): Promise<void> {
  const pdfs = files.filter(
    (f) => f?.path && (f.mimetype === 'application/pdf' || /\.pdf$/i.test(f.originalname ?? '')),
  );
  await Promise.all(
    pdfs.map(async (f) => {
      if (f.size !== undefined && f.size < MIN_BYTES) return; // skip the disk read
      const r = await compressPdfInPlace(f.path);
      if (r.compressed) f.size = r.size;
    }),
  );
}

/** test hook */
export function __resetGsMissing(): void {
  gsMissing = false;
}
