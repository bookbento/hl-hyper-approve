import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Batch 7a — PDF overlay positions:
 *   POST /api/memos/signature
 *   POST /api/memos/date
 *   POST /api/memos/note
 *
 * Ported as-is from backend/src/services/memoPdf.service.ts: the body is
 * written straight through (including userId from the body, not the token).
 * The current frontend does not call these endpoints.
 */
@Controller('api/memos')
@UseGuards(JwtAuthGuard)
export class MemoPositionController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('signature')
  @HttpCode(HttpStatus.CREATED)
  saveSignaturePosition(@Body() body: Record<string, any>) {
    const { memoId, fileId, userId, page, x, y } = body;
    return this.prisma.signaturePosition.create({ data: { memoId, fileId, userId, page, x, y } });
  }

  @Post('date')
  @HttpCode(HttpStatus.CREATED)
  saveDatePosition(@Body() body: Record<string, any>) {
    const { memoId, fileId, userId, page, x, y, date } = body;
    return this.prisma.datePosition.create({
      data: { memoId, fileId, userId, page, x, y, date: new Date(date) },
    });
  }

  @Post('note')
  @HttpCode(HttpStatus.CREATED)
  saveNotePosition(@Body() body: Record<string, any>) {
    const { memoId, fileId, page, x, y, text } = body;
    return this.prisma.notePosition.create({ data: { memoId, fileId, page, x, y, text } });
  }
}
