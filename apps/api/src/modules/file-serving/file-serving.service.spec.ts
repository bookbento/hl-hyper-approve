/**
 * Unit tests for FileServingService
 *
 * คุณอิเอริ + คุณนิตตะ: Focus on security-critical paths.
 * - Path traversal rejection
 * - Access control: profiles/types/signatures/memo-based
 * - 404 for missing files
 * - Proper status codes on all error paths
 */

import { Test, TestingModule } from '@nestjs/testing';
import { FileServingService } from './file-serving.service';
import { PrismaService } from '../../prisma/prisma.service';

// ── Mock fs ───────────────────────────────────────────────────────────────────
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  statSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

// ── Mock upload.config to control UPLOADS_DIR ─────────────────────────────────
jest.mock('../../common/upload/upload.config', () => ({
  UPLOADS_DIR: '/fake/uploads',
  resolveSafeUploadPath: jest.fn(),
  coerceToRelative: jest.fn(),
}));

import * as fs from 'fs';
import {
  resolveSafeUploadPath,
  coerceToRelative,
} from '../../common/upload/upload.config';

const mockPrisma = {
  userSignature: { findFirst: jest.fn() },
  memoApproverAction: { findFirst: jest.fn() },
  user: { findUnique: jest.fn() },
  masterMemo: { findUnique: jest.fn() },
  memoCc: { findFirst: jest.fn() },
  lineOfApprovalUserPivot: { findFirst: jest.fn() },
  extraApprover: { findFirst: jest.fn() },
  commentTag: { findFirst: jest.fn() },
  memoStatusPivot: { findFirst: jest.fn() },
  mainFile: { findFirst: jest.fn() },
  attachedFile: { findFirst: jest.fn() },
  commentAttachment: { findFirst: jest.fn() },
};

describe('FileServingService', () => {
  let service: FileServingService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FileServingService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<FileServingService>(FileServingService);
  });

  function setupFsFile(exists = true) {
    (fs.existsSync as jest.Mock).mockReturnValue(exists);
    (fs.statSync as jest.Mock).mockReturnValue({ isFile: () => true });
  }

  function setupSafeResolve(rel: string) {
    (coerceToRelative as jest.Mock).mockReturnValue(rel);
    (resolveSafeUploadPath as jest.Mock).mockReturnValue({
      abs: `/fake/uploads/${rel}`,
      rel,
    });
  }

  // ── Path traversal ─────────────────────────────────────────────────────────
  describe('path traversal protection', () => {
    it('rejects when resolveSafeUploadPath throws traversal error', async () => {
      (coerceToRelative as jest.Mock).mockReturnValue('../etc/passwd');
      (resolveSafeUploadPath as jest.Mock).mockImplementation(() => {
        const err = new Error('Path traversal detected');
        (err as any).status = 400;
        throw err;
      });

      await expect(service.resolveFile('../etc/passwd', 1)).rejects.toMatchObject({
        message: 'Path traversal detected',
        status: 400,
      });
    });

    it('rejects when coerced path is empty', async () => {
      (coerceToRelative as jest.Mock).mockReturnValue('');

      await expect(service.resolveFile('', 1)).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  // ── 404 handling ───────────────────────────────────────────────────────────
  describe('missing files', () => {
    it('returns 404 when file does not exist', async () => {
      setupSafeResolve('attached/missing.pdf');
      (fs.existsSync as jest.Mock).mockReturnValue(false);

      await expect(service.resolveFile('attached/missing.pdf', 1)).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  // ── profiles/ special folder ───────────────────────────────────────────────
  describe('profiles/ folder access', () => {
    it('allows any authenticated user to access profiles/', async () => {
      setupSafeResolve('profiles/avatar.png');
      setupFsFile();

      const result = await service.resolveFile('profiles/avatar.png', 42);
      expect(result).toBe('/fake/uploads/profiles/avatar.png');
    });
  });

  // ── types/ special folder ──────────────────────────────────────────────────
  describe('types/ folder access', () => {
    it('allows any authenticated user to access types/', async () => {
      setupSafeResolve('types/template.pdf');
      setupFsFile();

      const result = await service.resolveFile('types/template.pdf', 42);
      expect(result).toBe('/fake/uploads/types/template.pdf');
    });
  });

  // ── signatures/ special folder ─────────────────────────────────────────────
  describe('signatures/ folder access', () => {
    it('allows signature owner', async () => {
      setupSafeResolve('signatures/123-sig.png');
      setupFsFile();

      mockPrisma.userSignature.findFirst.mockResolvedValue({ id: 1, userId: 42 });

      const result = await service.resolveFile('signatures/123-sig.png', 42);
      expect(result).toBe('/fake/uploads/signatures/123-sig.png');
    });

    it('denies non-owner with no memo link', async () => {
      setupSafeResolve('signatures/123-sig.png');
      setupFsFile();

      // sig belongs to user 99, not user 42
      mockPrisma.userSignature.findFirst.mockResolvedValue({ id: 1, userId: 99 });
      mockPrisma.memoApproverAction.findFirst.mockResolvedValue(null);

      // Falls through to memo-based check — no memoId found
      mockPrisma.mainFile.findFirst.mockResolvedValue(null);
      mockPrisma.attachedFile.findFirst.mockResolvedValue(null);
      mockPrisma.commentAttachment.findFirst.mockResolvedValue(null);

      await expect(service.resolveFile('signatures/123-sig.png', 42)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('denies when signature not found in DB', async () => {
      setupSafeResolve('signatures/unknown.png');
      setupFsFile();

      mockPrisma.userSignature.findFirst.mockResolvedValue(null);

      // Falls through to memo-based check
      mockPrisma.mainFile.findFirst.mockResolvedValue(null);
      mockPrisma.attachedFile.findFirst.mockResolvedValue(null);
      mockPrisma.commentAttachment.findFirst.mockResolvedValue(null);

      await expect(service.resolveFile('signatures/unknown.png', 42)).rejects.toMatchObject({
        status: 403,
      });
    });
  });

  // ── Memo-based access ──────────────────────────────────────────────────────
  describe('memo-based access control', () => {
    it('allows memo owner to access attached file', async () => {
      setupSafeResolve('attached/report.pdf');
      setupFsFile();

      // No special folder match
      mockPrisma.mainFile.findFirst.mockResolvedValue(null);
      mockPrisma.attachedFile.findFirst.mockResolvedValue({ memoId: 10 });

      // canAccessMemo: user is memo owner
      mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ userId: 42, approvalLineId: null });
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 2 }); // non-draft

      const result = await service.resolveFile('attached/report.pdf', 42);
      expect(result).toBe('/fake/uploads/attached/report.pdf');
    });

    it('allows admin to access any memo file', async () => {
      setupSafeResolve('attached/secret.pdf');
      setupFsFile();

      mockPrisma.mainFile.findFirst.mockResolvedValue(null);
      mockPrisma.attachedFile.findFirst.mockResolvedValue({ memoId: 10 });

      mockPrisma.user.findUnique.mockResolvedValue({ role: 'admin' });
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ userId: 99, approvalLineId: null });
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 2 }); // non-draft

      const result = await service.resolveFile('attached/secret.pdf', 42);
      expect(result).toBe('/fake/uploads/attached/secret.pdf');
    });

    it('denies non-owner, non-admin with no relationship to memo', async () => {
      setupSafeResolve('attached/private.pdf');
      setupFsFile();

      mockPrisma.mainFile.findFirst.mockResolvedValue(null);
      mockPrisma.attachedFile.findFirst.mockResolvedValue({ memoId: 10 });

      mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ userId: 99, approvalLineId: null });
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 2 }); // non-draft
      mockPrisma.memoCc.findFirst.mockResolvedValue(null);
      mockPrisma.lineOfApprovalUserPivot.findFirst.mockResolvedValue(null);
      mockPrisma.memoApproverAction.findFirst.mockResolvedValue(null);
      mockPrisma.extraApprover.findFirst.mockResolvedValue(null);
      mockPrisma.commentTag.findFirst.mockResolvedValue(null);

      await expect(service.resolveFile('attached/private.pdf', 42)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('denies when file has no known memoId mapping', async () => {
      setupSafeResolve('attached/orphan.pdf');
      setupFsFile();

      mockPrisma.mainFile.findFirst.mockResolvedValue(null);
      mockPrisma.attachedFile.findFirst.mockResolvedValue(null);
      mockPrisma.commentAttachment.findFirst.mockResolvedValue(null);

      await expect(service.resolveFile('attached/orphan.pdf', 42)).rejects.toMatchObject({
        status: 403,
      });
    });

    it('allows access to MemoType template (memoId = -1)', async () => {
      setupSafeResolve('attached/template.pdf');
      setupFsFile();

      // MainFile with no memoId = template
      mockPrisma.mainFile.findFirst.mockResolvedValue({ memoId: null, memoTypeId: 5 });

      const result = await service.resolveFile('attached/template.pdf', 42);
      expect(result).toBe('/fake/uploads/attached/template.pdf');
    });

    it('allows CC user to access memo file', async () => {
      setupSafeResolve('attached/cc-file.pdf');
      setupFsFile();

      mockPrisma.mainFile.findFirst.mockResolvedValue(null);
      mockPrisma.attachedFile.findFirst.mockResolvedValue({ memoId: 10 });

      mockPrisma.user.findUnique.mockResolvedValue({ role: 'user' });
      mockPrisma.masterMemo.findUnique.mockResolvedValue({ userId: 99, approvalLineId: null });
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 2 });
      mockPrisma.memoCc.findFirst.mockResolvedValue({ id: 1 }); // is CC

      const result = await service.resolveFile('attached/cc-file.pdf', 42);
      expect(result).toBe('/fake/uploads/attached/cc-file.pdf');
    });
  });
});
