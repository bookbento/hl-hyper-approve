import { BadRequestException, Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MemoPdfService, PdfResponse, parseMemoId } from './memo-pdf.service';

function sendPdf(res: Response, pdf: PdfResponse): void {
  res
    .header('Content-Type', 'application/pdf')
    .header('Content-Disposition', pdf.contentDisposition)
    .header('Content-Length', String(pdf.body.length))
    .send(pdf.body);
}

/**
 * Batch 8a — memo PDF downloads:
 *   GET /api/memos/:id/download[?preview=1][&inline=1]
 *   GET /api/memos/:id/download/:filename   (filename is cosmetic, same output)
 *   GET /api/memos/:id/raw
 *   GET /api/memos/:id/pdf[?fileId=]
 */
@Controller('api/memos')
@UseGuards(JwtAuthGuard)
export class MemoPdfController {
  constructor(private readonly pdf: MemoPdfService) {}

  @Get(':id/download')
  async download(
    @Param('id') id: string,
    @Query('preview') preview: string | undefined,
    @Query('inline') inline: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(
      res,
      await this.pdf.downloadMerged(user.id, parseMemoId(id), {
        preview: String(preview ?? '') === '1',
        inline: String(inline ?? '') === '1',
      }),
    );
  }

  @Get(':id/download/:filename')
  async downloadNamed(
    @Param('id') id: string,
    @Query('preview') preview: string | undefined,
    @Query('inline') inline: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ): Promise<void> {
    return this.download(id, preview, inline, user, res);
  }

  @Get(':id/raw')
  async raw(
    @Param('id') id: string,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ): Promise<void> {
    sendPdf(res, await this.pdf.downloadRaw(user.id, parseMemoId(id)));
  }

  @Get(':id/pdf')
  async mainFile(
    @Param('id') id: string,
    @Query('fileId') rawFileId: string | undefined,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response,
  ): Promise<void> {
    const memoId = parseMemoId(id);
    const fileId = rawFileId ? Number(rawFileId) : undefined;
    if (rawFileId && Number.isNaN(fileId)) {
      throw new BadRequestException({ error: 'Invalid fileId' });
    }
    const file = await this.pdf.getMainFile(user.id, memoId, fileId);
    res
      .header('Content-Type', 'application/pdf')
      .header('Access-Control-Expose-Headers', 'Content-Disposition')
      .header('Content-Disposition', file.contentDisposition)
      .sendFile(file.absolutePath);
  }
}
