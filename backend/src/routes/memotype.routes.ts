// src/routes/memotype.routes.ts
import { Router } from 'express'
import {
  getAllMEMOTypes,
  getMEMOTypeById,
  createMEMOType,
  updateMEMOType,
  deleteMEMOType,
  deleteMEMOTypeFile,
  getMEMOTypesCount,
} from '../controllers/memotype.controller'
import { authenticate } from '../middlewares/auth.middleware'
import { uploadToMemory, handleUploadError } from '../middlewares/upload';

const router = Router();
router.get("/count", authenticate, getMEMOTypesCount);  // Add count endpoint before generic routes
router.get("/", authenticate, getAllMEMOTypes);     // 🟢 protect
router.get("/:id", authenticate, getMEMOTypeById);  // (ถ้าอยากให้แค่ login ถึงดูได้)
router.post(
   "/",
   authenticate,
   handleUploadError(uploadToMemory.array("files", 20)),  // <<<< สำคัญ
   createMEMOType
 );
router.put("/:id", authenticate, handleUploadError(uploadToMemory.array("files", 20)), updateMEMOType);
router.delete("/:id", authenticate, deleteMEMOType); // DELETE /api/memotypes/:id
router.delete("/:typeId/files/:fileId", authenticate, deleteMEMOTypeFile);

export default router;
