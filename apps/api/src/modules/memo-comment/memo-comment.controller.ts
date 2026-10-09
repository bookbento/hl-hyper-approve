import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { Request } from 'express';
import { diskStorage } from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import {
  ALLOWED_DOC_EXTS,
  ALLOWED_DOC_MIMES,
  ALLOWED_IMAGE_EXTS,
  ALLOWED_IMAGE_MIMES,
  COMMENTS_DIR,
  FILE_SIZE_LIMIT,
  OFFICE_EXT_OCTET,
  sanitizeName,
} from '../../common/upload/upload.config';
import { MemoCommentService } from './memo-comment.service';

const MAX_COMMENT_FILES = 6;
const UNSUPPORTED_FILE_MESSAGE = 'Only image, PDF, Word, Excel, and PowerPoint files are allowed';

// Mirrors uploadToDisk in backend/src/middlewares/upload.ts (comments branch).
const commentStorage = diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync(COMMENTS_DIR, { recursive: true });
    cb(null, COMMENTS_DIR);
  },
  filename: (_req, file, cb) => cb(null, `${Date.now()}-${sanitizeName(file.originalname)}`),
});

function commentFileFilter(
  _req: Request,
  file: Express.Multer.File,
  cb: (error: Error | null, acceptFile: boolean) => void,
): void {
  const ext = (path.extname(file.originalname || '') || '').toLowerCase();
  const mt = (file.mimetype || '').toLowerCase();
  const allowed =
    ALLOWED_IMAGE_EXTS.has(ext) ||
    ALLOWED_DOC_EXTS.has(ext) ||
    ALLOWED_IMAGE_MIMES.has(mt) ||
    ALLOWED_DOC_MIMES.has(mt) ||
    (mt === 'application/octet-stream' && OFFICE_EXT_OCTET.has(ext));
  if (!allowed) {
    return cb(
      new BadRequestException({ message: UNSUPPORTED_FILE_MESSAGE, error: 'UNSUPPORTED_FILE_TYPE' }),
      false,
    );
  }
  cb(null, true);
}

function parseId(raw: string, error: string): number {
  const id = Number(raw);
  if (isNaN(id)) throw new BadRequestException({ error });
  return id;
}

function hostOf(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

@Controller()
@UseGuards(JwtAuthGuard)
export class MemoCommentController {
  constructor(private readonly comments: MemoCommentService) {}

  @Get('api/memos/:id/comments')
  async getComments(@Param('id') id: string, @Req() req: Request) {
    return this.comments.getComments(parseId(id, 'Invalid memo ID'), hostOf(req));
  }

  // Oversized files surface as 413 (Nest's multer mapping), which the
  // frontend already turns into "File size too large".
  @Post('api/memos/:id/comments')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FilesInterceptor('files', MAX_COMMENT_FILES, {
      storage: commentStorage,
      fileFilter: commentFileFilter,
      limits: { fileSize: FILE_SIZE_LIMIT },
    }),
  )
  async addComment(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @UploadedFiles() files: Express.Multer.File[] | undefined,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const memoId = parseId(id, 'Invalid memo ID');
    return this.comments.addComment({
      memoId,
      userId: user.id,
      content: (typeof body['content'] === 'string' ? body['content'] : '').trim(),
      files: files ?? [],
      rawMentions: body['mentionUserIds'] ?? body['mentions'],
      host: hostOf(req),
    });
  }

  @Delete('api/comments/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteComment(@Param('commentId') commentId: string, @CurrentUser() user: JwtPayload) {
    await this.comments.deleteComment(parseId(commentId, 'Invalid comment ID'), user.id);
  }
}
