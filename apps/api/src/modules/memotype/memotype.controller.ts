/**
 * MemotypeController
 *
 * Mirrors backend/src/routes/memotype.routes.ts exactly:
 *   GET    /api/memotypes/count       — count active/total types
 *   GET    /api/memotypes             — list types (visibility filter)
 *   GET    /api/memotypes/:id         — get single type
 *   POST   /api/memotypes             — create type + approval line (file upload)
 *   PUT    /api/memotypes/:id         — update type + approval line (file upload)
 *   DELETE /api/memotypes/:id         — delete type
 *   DELETE /api/memotypes/:typeId/files/:fileId — delete file
 *
 * Security:
 *   - JwtAuthGuard on all routes.
 *   - File uploads: memory storage (mirrors Express uploadToMemory).
 *   - File validation delegated to Express multer middleware via FileFilter —
 *     same MIME/ext sets as backend/src/middlewares/upload.ts.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UseInterceptors,
  UploadedFiles,
  ForbiddenException,
  Req,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import * as path from 'path';
import { Request } from 'express';
import { MemotypeService } from './memotype.service';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ALLOWED_DOC_EXTS,
  ALLOWED_DOC_MIMES,
  ALLOWED_IMAGE_EXTS,
  ALLOWED_IMAGE_MIMES,
  OFFICE_EXT_OCTET,
  FILE_SIZE_LIMIT,
} from '../../common/upload/upload.config';

// File filter that mirrors Express handleUploadError(uploadToMemory.array("files", 20))
function memoTypeFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
): void {
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  const mime = (file.mimetype || '').toLowerCase();
  const isImage = ALLOWED_IMAGE_EXTS.has(ext) && ALLOWED_IMAGE_MIMES.has(mime);
  const isDoc = ALLOWED_DOC_EXTS.has(ext) && (ALLOWED_DOC_MIMES.has(mime) || mime === 'application/octet-stream');
  const isOfficeExt = OFFICE_EXT_OCTET.has(ext) && mime === 'application/octet-stream';
  if (isImage || isDoc || isOfficeExt) {
    return cb(null, true);
  }
  cb(new Error('Only image, PDF, Word, Excel, and PowerPoint files are allowed'), false);
}

@Controller()
@UseGuards(JwtAuthGuard)
export class MemotypeController {
  constructor(private readonly service: MemotypeService) {}

  // GET /api/memotypes/count  (must be before /:id)
  @Get('api/memotypes/count')
  getCount(@CurrentUser() user: JwtPayload) {
    return this.service.getCount(user);
  }

  // GET /api/memotypes
  @Get('api/memotypes')
  findAll(
    @CurrentUser() user: JwtPayload,
    @Query('includeInactive') includeInactive?: string,
    @Query('context') context?: string,
    @Query('businessUnitId') businessUnitId?: string,
  ) {
    const buId = businessUnitId ? Number(businessUnitId) : null;
    return this.service.findAll(
      user,
      includeInactive === 'true',
      context === 'management' ? 'management' : 'creation',
      buId,
    );
  }

  // GET /api/memotypes/:id
  @Get('api/memotypes/:id')
  findById(
    @CurrentUser() user: JwtPayload,
    @Param('id') idParam: string,
    @Query('context') context?: string,
    @Query('includeDeleted') includeDeleted?: string,
  ) {
    const id = Number(idParam);
    if (Number.isNaN(id)) throw new BadRequestException('Invalid type ID');
    return this.service.findById(
      user,
      id,
      context === 'management' ? 'management' : 'creation',
      includeDeleted === 'true',
    );
  }

  // POST /api/memotypes
  @Post('api/memotypes')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: memoryStorage(),
      limits: { fileSize: FILE_SIZE_LIMIT },
      fileFilter: memoTypeFileFilter,
    }),
  )
  async createMEMOType(
    @CurrentUser() user: JwtPayload,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    return this.service.createMEMOType(user, body, files || []);
  }

  // PUT /api/memotypes/:id
  @Put('api/memotypes/:id')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: memoryStorage(),
      limits: { fileSize: FILE_SIZE_LIMIT },
      fileFilter: memoTypeFileFilter,
    }),
  )
  async updateMEMOType(
    @CurrentUser() user: JwtPayload,
    @Param('id') idParam: string,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    const id = Number(idParam);
    if (Number.isNaN(id)) throw new BadRequestException('Invalid type ID');
    return this.service.updateMEMOType(user, id, body, files || []);
  }

  // DELETE /api/memotypes/:id
  @Delete('api/memotypes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMEMOType(
    @CurrentUser() user: JwtPayload,
    @Param('id') idParam: string,
  ) {
    const id = Number(idParam);
    if (Number.isNaN(id)) throw new BadRequestException('Invalid type ID');
    await this.service.deleteMEMOType(user, id);
  }

  // DELETE /api/memotypes/:typeId/files/:fileId
  @Delete('api/memotypes/:typeId/files/:fileId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteMEMOTypeFile(
    @CurrentUser() user: JwtPayload,
    @Param('typeId') typeIdParam: string,
    @Param('fileId') fileIdParam: string,
  ) {
    const typeId = Number(typeIdParam);
    const fileId = Number(fileIdParam);
    if (!Number.isFinite(typeId) || !Number.isFinite(fileId)) {
      throw new BadRequestException('Invalid id');
    }
    await this.service.deleteMEMOTypeFile(user, typeId, fileId);
  }
}
