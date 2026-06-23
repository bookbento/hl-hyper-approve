/**
 * Unit tests for upload.config.ts
 *
 * คุณนิตตะ: TDD — tests written first, cover:
 *   - UPLOADS_DIR resolution (default and env override)
 *   - sanitizeName strips dangerous chars
 *   - toPublicUploadPath produces consistent DB-safe relative path
 *   - resolveSafeUploadPath rejects path traversal
 *   - coerceToRelative handles full URLs, encoded paths, uploads/ prefix
 */

import * as path from 'path';
import {
  UPLOADS_DIR,
  sanitizeName,
  toPublicUploadPath,
  resolveSafeUploadPath,
  coerceToRelative,
} from './upload.config';

describe('upload.config', () => {
  // ── UPLOADS_DIR ────────────────────────────────────────────────────────────
  describe('UPLOADS_DIR', () => {
    it('should be an absolute path', () => {
      expect(path.isAbsolute(UPLOADS_DIR)).toBe(true);
    });

    it('should end with "uploads"', () => {
      expect(path.basename(UPLOADS_DIR)).toBe('uploads');
    });
  });

  // ── sanitizeName ───────────────────────────────────────────────────────────
  describe('sanitizeName', () => {
    it('strips spaces and replaces with underscore', () => {
      expect(sanitizeName('my file name.png')).toBe('my_file_name.png');
    });

    it('strips special characters into single underscore per run', () => {
      // The regex /[^\w.\-]+/g collapses consecutive special chars into one '_'
      // 'file<>:"/\\|?*.txt' has one run of specials between 'file' and '.txt'
      expect(sanitizeName('file<>:"/\\|?*.txt')).toBe('file_.txt');
    });

    it('normalises unicode NFC', () => {
      // composed and decomposed forms of "é"
      const composed = 'é';
      const decomposed = 'é';
      expect(sanitizeName(decomposed + '.png')).toBe(sanitizeName(composed + '.png'));
    });

    it('preserves safe characters', () => {
      expect(sanitizeName('report-2024_v1.pdf')).toBe('report-2024_v1.pdf');
    });
  });

  // ── toPublicUploadPath ─────────────────────────────────────────────────────
  describe('toPublicUploadPath', () => {
    it('converts absolute path under UPLOADS_DIR to uploads/... form', () => {
      const abs = path.join(UPLOADS_DIR, 'attached', '12345-file.pdf');
      expect(toPublicUploadPath(abs)).toBe('uploads/attached/12345-file.pdf');
    });

    it('always uses forward slashes', () => {
      const abs = path.join(UPLOADS_DIR, 'signatures', 'sig.png');
      const result = toPublicUploadPath(abs);
      expect(result).not.toContain('\\');
    });

    it('does not double-prefix "uploads/"', () => {
      const abs = path.join(UPLOADS_DIR, 'profiles', 'avatar.jpg');
      const result = toPublicUploadPath(abs);
      expect(result.match(/uploads\//g)?.length).toBe(1);
    });
  });

  // ── resolveSafeUploadPath ──────────────────────────────────────────────────
  describe('resolveSafeUploadPath', () => {
    it('resolves a normal relative path', () => {
      const { abs, rel } = resolveSafeUploadPath('attached/test.pdf');
      expect(path.isAbsolute(abs)).toBe(true);
      expect(abs).toContain(UPLOADS_DIR);
      expect(rel).toBe('attached/test.pdf');
    });

    it('throws on path traversal attempt (../)', () => {
      expect(() => resolveSafeUploadPath('../etc/passwd')).toThrow('Path traversal detected');
    });

    it('throws on deeply nested traversal', () => {
      expect(() => resolveSafeUploadPath('attached/../../etc/passwd')).toThrow(
        'Path traversal detected',
      );
    });

    it('strips leading slashes', () => {
      const { rel } = resolveSafeUploadPath('/signatures/file.png');
      expect(rel).toBe('signatures/file.png');
    });
  });

  // ── coerceToRelative ───────────────────────────────────────────────────────
  describe('coerceToRelative', () => {
    it('strips "uploads/" prefix', () => {
      expect(coerceToRelative('uploads/attached/file.pdf')).toBe('attached/file.pdf');
    });

    it('extracts path from full HTTP URL', () => {
      const result = coerceToRelative(
        'https://example.com/uploads/profiles/avatar.png',
      );
      expect(result).toBe('profiles/avatar.png');
    });

    it('decodes percent-encoded characters', () => {
      expect(coerceToRelative('signatures%2Ffile.png')).toBe('signatures/file.png');
    });

    it('strips leading slashes', () => {
      expect(coerceToRelative('/signatures/file.png')).toBe('signatures/file.png');
    });

    it('returns empty string for empty input', () => {
      expect(coerceToRelative('')).toBe('');
    });

    it('handles URL with query string', () => {
      const result = coerceToRelative(
        'https://example.com/uploads/attached/report.pdf?v=1',
      );
      // URL parser strips the query — result should be path only
      expect(result).toContain('attached/report.pdf');
    });
  });
});
