/**
 * Unit tests for UserSignatureService
 *
 * คุณนิตตะ: TDD red→green cycle.
 * All Prisma calls are mocked — no real DB required.
 * file-type and sharp are mocked to isolate service logic.
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import * as fs from 'fs/promises';
import { UserSignatureService } from './user-signature.service';
import { PrismaService } from '../../prisma/prisma.service';

// ── Mock file-type (ESM-only — mocked as CommonJS-compatible module for tests) ──
jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn(),
}));

// ── Mock sharp ────────────────────────────────────────────────────────────────
jest.mock('sharp', () => {
  return jest.fn(() => ({
    metadata: jest.fn().mockResolvedValue({ width: 100, height: 100 }),
  }));
});

// ── Mock fs/promises ──────────────────────────────────────────────────────────
jest.mock('fs/promises', () => ({
  readFile: jest.fn(),
  unlink: jest.fn().mockResolvedValue(undefined),
}));

const mockPrisma = {
  userSignature: {
    findMany: jest.fn(),
    create: jest.fn(),
    delete: jest.fn(),
    findUnique: jest.fn(),
  },
  user: {
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
};

describe('UserSignatureService', () => {
  let service: UserSignatureService;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserSignatureService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<UserSignatureService>(UserSignatureService);
  });

  // ── listSignatures ─────────────────────────────────────────────────────────
  describe('listSignatures', () => {
    it('returns signatures list and defaultSignatureId', async () => {
      const signatures = [
        { id: 1, path: '/uploads/signatures/sig1.png', label: 'Main', createdAt: new Date() },
      ];
      mockPrisma.userSignature.findMany.mockResolvedValue(signatures);
      mockPrisma.user.findUnique.mockResolvedValue({ defaultSignatureId: 1 });

      const result = await service.listSignatures(42);

      expect(result.signatures).toEqual(signatures);
      expect(result.defaultSignatureId).toBe(1);
    });

    it('returns null defaultSignatureId when user has none set', async () => {
      mockPrisma.userSignature.findMany.mockResolvedValue([]);
      mockPrisma.user.findUnique.mockResolvedValue({ defaultSignatureId: null });

      const result = await service.listSignatures(42);
      expect(result.defaultSignatureId).toBeNull();
    });
  });

  // ── uploadSignature ────────────────────────────────────────────────────────
  describe('uploadSignature', () => {
    const fakeFile = {
      path: '/uploads/signatures/123-sig.png',
      originalname: 'sig.png',
      mimetype: 'image/png',
    } as Express.Multer.File;

    it('creates signature when PNG is valid', async () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      (fs.readFile as jest.Mock).mockResolvedValue(pngBuffer);

      // file-type returns image/png
      const fileTypeMod = jest.requireMock('file-type');
      (fileTypeMod.fileTypeFromBuffer as jest.Mock).mockResolvedValue({ ext: 'png', mime: 'image/png' });

      const createdSig = { id: 10, userId: 5, path: fakeFile.path, label: 'Test', createdAt: new Date() };
      mockPrisma.userSignature.create.mockResolvedValue(createdSig);

      const result = await service.uploadSignature(5, fakeFile, 'Test');

      expect(result).toEqual(createdSig);
      expect(mockPrisma.userSignature.create).toHaveBeenCalledWith({
        data: { userId: 5, path: fakeFile.path, label: 'Test' },
      });
    });

    it('rejects non-PNG files and deletes the file', async () => {
      const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff]);
      (fs.readFile as jest.Mock).mockResolvedValue(jpegBuffer);

      const fileTypeMod = jest.requireMock('file-type');
      (fileTypeMod.fileTypeFromBuffer as jest.Mock).mockResolvedValue({ ext: 'jpg', mime: 'image/jpeg' });

      await expect(service.uploadSignature(5, fakeFile)).rejects.toThrow(
        BadRequestException,
      );
      expect(fs.unlink).toHaveBeenCalledWith(fakeFile.path);
    });

    it('rejects corrupted PNG and deletes the file', async () => {
      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      (fs.readFile as jest.Mock).mockResolvedValue(pngBuffer);

      const fileTypeMod = jest.requireMock('file-type');
      (fileTypeMod.fileTypeFromBuffer as jest.Mock).mockResolvedValue({ ext: 'png', mime: 'image/png' });

      // sharp throws on corrupted image
      const sharpMock = require('sharp');
      (sharpMock as jest.Mock).mockImplementationOnce(() => ({
        metadata: jest.fn().mockRejectedValue(new Error('corrupted')),
      }));

      await expect(service.uploadSignature(5, fakeFile)).rejects.toThrow(
        BadRequestException,
      );
      expect(fs.unlink).toHaveBeenCalledWith(fakeFile.path);
    });

    it('rejects when file-type returns undefined (unknown type)', async () => {
      (fs.readFile as jest.Mock).mockResolvedValue(Buffer.from([0x00, 0x01]));

      const fileTypeMod = jest.requireMock('file-type');
      (fileTypeMod.fileTypeFromBuffer as jest.Mock).mockResolvedValue(undefined);

      await expect(service.uploadSignature(5, fakeFile)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  // ── setDefaultSignature ────────────────────────────────────────────────────
  describe('setDefaultSignature', () => {
    it('sets signatureId on user', async () => {
      mockPrisma.user.update.mockResolvedValue({});
      const result = await service.setDefaultSignature(5, 10);
      expect(result).toEqual({ ok: true });
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { defaultSignatureId: 10 },
      });
    });

    it('clears signatureId when null passed', async () => {
      mockPrisma.user.update.mockResolvedValue({});
      await service.setDefaultSignature(5, null);
      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 5 },
        data: { defaultSignatureId: null },
      });
    });
  });

  // ── deleteSignature ────────────────────────────────────────────────────────
  describe('deleteSignature', () => {
    it('deletes signature and clears defaultSignatureId', async () => {
      const sig = { path: '/uploads/signatures/123-sig.png', userId: 5 };
      mockPrisma.userSignature.delete.mockResolvedValue(sig);
      mockPrisma.user.updateMany.mockResolvedValue({ count: 0 });

      await service.deleteSignature(1);

      expect(mockPrisma.userSignature.delete).toHaveBeenCalledWith({
        where: { id: 1 },
        select: { path: true, userId: true },
      });
      expect(mockPrisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 5, defaultSignatureId: 1 },
        data: { defaultSignatureId: null },
      });
      expect(fs.unlink).toHaveBeenCalledWith(sig.path);
    });

    it('throws NotFoundException when signature does not exist', async () => {
      mockPrisma.userSignature.delete.mockRejectedValue(new Error('Record not found'));
      await expect(service.deleteSignature(999)).rejects.toThrow(NotFoundException);
    });
  });

  // ── getSignatureAbsPath ────────────────────────────────────────────────────
  describe('getSignatureAbsPath', () => {
    it('returns absolute path from DB', async () => {
      mockPrisma.userSignature.findUnique.mockResolvedValue({
        path: '/uploads/signatures/123-sig.png',
      });

      const result = await service.getSignatureAbsPath(1);
      expect(result).toBe('/uploads/signatures/123-sig.png');
    });

    it('throws NotFoundException when signature not found', async () => {
      mockPrisma.userSignature.findUnique.mockResolvedValue(null);
      await expect(service.getSignatureAbsPath(999)).rejects.toThrow(NotFoundException);
    });
  });
});
