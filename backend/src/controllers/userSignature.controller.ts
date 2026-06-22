import { RequestHandler } from "express";
import { prisma } from "../../prisma/client";
import fs from "fs/promises";
import sharp from "sharp";

const { fileTypeFromBuffer } = require("file-type") as {
  fileTypeFromBuffer: (
    buffer: Uint8Array | ArrayBuffer
  ) => Promise<{ ext: string; mime: string } | undefined>;
};

/* PUT /api/users/:id/default-signature   (ตั้งค่าเริ่มต้น) */
export const setDefaultSignature: RequestHandler = async (req, res) => {
  const userId = Number(req.params.id);

  const raw = req.body.signatureId;

  // อนุญาตให้เป็น null → แปลเป็น null จริง ๆ
  let signatureId: number | null;

  if (raw === null || raw === undefined || raw === "") {
    signatureId = null;
  } else {
    const n = Number(raw);
    if (Number.isNaN(n)) {
      res.status(400).json({ error: "Invalid signatureId" });
      return;
    }
    signatureId = n;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { defaultSignatureId: signatureId },
  });

  res.json({ ok: true });
};


/* GET /api/users/:id/signatures          (ลิสต์ไฟล์ทั้งหมด) */
export const listSignatures: RequestHandler = async (req, res) => {
  const userId = +req.params.id;

  // ดึง signatures
  const list = await prisma.userSignature.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
    select: { id: true, path: true, label: true, createdAt: true },
  });

  // ดึง defaultSignatureId ของ user
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { defaultSignatureId: true },
  });

  res.json({
    defaultSignatureId: user?.defaultSignatureId ?? null,
    signatures: list,
  });
};

// เปลี่ยน uploadSignature เป็นแบบนี้
export const uploadSignature: RequestHandler = async (req, res) => {
  const userId = +req.params.id;
  if (!req.file) {
    res.status(400).json({ error: "file required" });
    return;
  } 

  const savedPath = req.file.path;

  try {
    const fileBuffer = await fs.readFile(savedPath);

    // ตรวจชนิดไฟล์จากเนื้อไฟล์จริง (ยืนยัน PNG เท่านั้น)
    const ft = await fileTypeFromBuffer(fileBuffer);
    if (!ft || ft.mime !== "image/png") {
      await fs.unlink(savedPath).catch(() => {});
      res.status(400).json({ error: "PNG only" });
      return ;
    }

    // ตรวจความสมบูรณ์ของภาพ
    try {
      await sharp(fileBuffer).metadata();
    } catch {
      await fs.unlink(savedPath).catch(() => {});
      res.status(400).json({ error: "corrupted image" });
      return ;
    }

    const sig = await prisma.userSignature.create({
      data: {
        userId,
        path: savedPath,
        label: req.body.label ?? null,
      },
    });

     res.status(201).json(sig);
     return;
  } catch (e) {
    await fs.unlink(savedPath).catch(() => {});
    res.status(500).json({ error: "upload failed" });
    return ;
  }
};


/* DELETE /api/users/signatures/:sigId     (ลบไฟล์) */
export const deleteSignature: RequestHandler = async (req, res) => {
  const sigId = +req.params.sigId;

  const sig = await prisma.userSignature.delete({
    where: { id: sigId },
    select: { path: true, userId: true }, // ← ขอ userId มาด้วย
  });

  // ← เพิ่มบล็อกนี้: เคลียร์ defaultSignatureId ถ้าตรงกัน
  await prisma.user.updateMany({
    where: { id: sig.userId, defaultSignatureId: sigId },
    data: { defaultSignatureId: null },
  });

  try {
    await fs.unlink(sig.path);
  } catch (err: any) {
    console.warn(`Could not delete signature file ${sig.path}:`, err.message);
  }

  res.sendStatus(204);
};


/* GET /api/users/signatures/:sigId/file   (เสิร์ฟไฟล์ PNG/SVG) */
export const getSignatureFile: RequestHandler = async (req, res) => {
  const sig = await prisma.userSignature.findUnique({
    where: { id: +req.params.sigId },
    select: { path: true },
  });
  if (!sig) {
    res.sendStatus(404);
    return;
  }
  res.sendFile(sig.path);
};
