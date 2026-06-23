/**
 * Shared file upload configuration for NestJS.
 *
 * Mirrors backend/src/middlewares/upload.ts so that Nest and Express
 * read/write to the SAME uploads directory on disk.
 *
 * UPLOADS_DIR resolution order:
 *   1. process.env.UPLOADS_DIR (absolute → use as-is, relative → resolve from monorepo root)
 *   2. Default: <monorepo-root>/uploads
 *
 * The monorepo root is resolved by walking up from __dirname until we find
 * a directory that contains pnpm-workspace.yaml (or apps/ + backend/ siblings).
 * This approach is identical to backend's findAncestorDir strategy but looks
 * for the workspace root rather than the "backend" directory, keeping the
 * two apps aligned on the same parent folder.
 *
 * Security (คุณอิเอริ review):
 *   - All user-supplied paths are sanitised before use.
 *   - resolveSafeUploadPath() enforces that resolved abs paths stay under UPLOADS_DIR.
 *   - sanitizeName() strips dangerous characters from original filenames.
 */

import * as path from 'path';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Root resolution
// ---------------------------------------------------------------------------

/**
 * Walk up from `start` until we find a directory that looks like the
 * monorepo root (contains pnpm-workspace.yaml or has both apps/ and backend/).
 */
function findMonorepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (let i = 0; i < 15; i++) {
    const hasWorkspace = fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'));
    const hasApps = fs.existsSync(path.join(dir, 'apps'));
    const hasBackend = fs.existsSync(path.join(dir, 'backend'));
    if (hasWorkspace || (hasApps && hasBackend)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: 4 levels up from dist/src/common/upload → monorepo root
  return path.resolve(start, '../../../../..');
}

const MONOREPO_ROOT = findMonorepoRoot(__dirname);
const DEFAULT_UPLOADS = path.join(MONOREPO_ROOT, 'uploads');

function resolveUploadsDir(): string {
  const env = (process.env['UPLOADS_DIR'] ?? '').trim();
  if (!env) return DEFAULT_UPLOADS;
  return path.isAbsolute(env) ? env : path.resolve(MONOREPO_ROOT, env);
}

export const UPLOADS_DIR = resolveUploadsDir();
export const SIG_DIR = path.join(UPLOADS_DIR, 'signatures');
export const COMMENTS_DIR = path.join(UPLOADS_DIR, 'comments');
export const ATTACHED_DIR = path.join(UPLOADS_DIR, 'attached');
export const PROFILES_DIR = path.join(UPLOADS_DIR, 'profiles');

// Ensure all directories exist at module load time (mirrors Express upload.ts)
[UPLOADS_DIR, SIG_DIR, COMMENTS_DIR, ATTACHED_DIR, PROFILES_DIR].forEach((p) =>
  fs.mkdirSync(p, { recursive: true }),
);

// ---------------------------------------------------------------------------
// File name helpers
// ---------------------------------------------------------------------------

/** Sanitise an original filename — strip dangerous chars, normalise unicode. */
export function sanitizeName(name: string): string {
  return name.normalize('NFC').replace(/[^\w.\-]+/g, '_');
}

/**
 * Convert an absolute path under UPLOADS_DIR to the DB-storable relative form.
 * Result is always "uploads/<subfolder>/<filename>" with forward slashes.
 * Mirrors backend/src/middlewares/upload.ts toPublicUploadPath().
 */
export function toPublicUploadPath(absPath: string): string {
  let rel = path.relative(UPLOADS_DIR, absPath);
  rel = rel.replace(/\\/g, '/');
  rel = rel.replace(/^\/+/, '');
  rel = rel.replace(/^(?:uploads\/)+/i, '');
  return `uploads/${rel}`;
}

// ---------------------------------------------------------------------------
// File filter sets (shared across modules)
// ---------------------------------------------------------------------------

export const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
export const ALLOWED_IMAGE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
]);

export const ALLOWED_DOC_EXTS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.rtf',
  '.ppt',
  '.pptx',
  '.pps',
  '.ppsx',
  '.xls',
  '.xlsx',
  '.csv',
  '.ods',
]);
export const ALLOWED_DOC_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/csv',
  'application/csv',
  'text/x-csv',
  'application/vnd.oasis.opendocument.spreadsheet',
]);

/** Extensions that browsers may send with application/octet-stream MIME. */
export const OFFICE_EXT_OCTET = new Set([
  '.doc',
  '.docx',
  '.rtf',
  '.ppt',
  '.pptx',
  '.pps',
  '.ppsx',
  '.xls',
  '.xlsx',
  '.csv',
  '.ods',
]);

export const FILE_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB

// ---------------------------------------------------------------------------
// Path traversal guard
// ---------------------------------------------------------------------------

/**
 * Resolve a user-supplied relative path under UPLOADS_DIR.
 * Throws with status 400 if the resolved path escapes UPLOADS_DIR.
 *
 * Mirrors resolveSafeUploadPath() in backend/src/routes/file.routes.ts.
 */
export function resolveSafeUploadPath(relPath: string): { abs: string; rel: string } {
  const uploadsRoot = path.resolve(UPLOADS_DIR);
  // Strip leading slashes so the input is treated as relative (not absolute).
  // An absolute path would cause path.resolve to ignore uploadsRoot entirely.
  const cleaned = String(relPath).replace(/^\/+/, '');
  // Resolve the path canonically — path.resolve handles ".." sequences.
  // The boundary check below catches any remaining traversal attempts.
  const abs = path.resolve(uploadsRoot, cleaned);

  const inRoot = abs === uploadsRoot || abs.startsWith(uploadsRoot + path.sep);
  if (!inRoot) {
    const err = new Error('Path traversal detected');
    (err as NodeJS.ErrnoException & { status?: number }).status = 400;
    throw err;
  }
  // Compute rel after resolving so it is clean and canonical
  const rel = path.relative(uploadsRoot, abs).replace(/\\/g, '/');
  return { abs, rel };
}

/**
 * Coerce a raw path from a URL (may include full URL, "uploads/" prefix, etc.)
 * to a clean relative path under UPLOADS_DIR.
 * Mirrors coerceToRelative() in backend/src/routes/file.routes.ts.
 */
export function coerceToRelative(raw: string): string {
  let s = raw.trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    /* ignore decode errors */
  }
  s = s.replace(/^\/+/, '');

  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      s = (u.pathname || '').replace(/^\/+/, '');
    } catch {
      s = s.replace(/^https?:\/\/[^/]+/i, '').replace(/^\/+/, '');
    }
  }

  // Strip leading "uploads/" prefix
  s = s.replace(/^uploads\//i, '');
  return s;
}
