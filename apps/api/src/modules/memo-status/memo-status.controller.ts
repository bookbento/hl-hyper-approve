import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ActBody, MemoStatusService, SignatureActionBody, StatusBody } from './memo-status.service';
import { MemoRecallService } from './memo-recall.service';
import { ApproverStatusService } from './approver-status.service';
import { EmailActionService } from './email-action.service';

type FileIdBody = { fileId?: unknown };

/**
 * Batch 8b — approve / status / recall (all need login):
 *   POST /api/memos/:id/action-signature   approve/reject with signature or condition
 *   POST /api/memos/:id/action             approve without signature (and legacy codes)
 *   POST /api/memos/:id/status             terminate / recall / reject / publish / draft / approved
 *   GET  /api/memos/:id/actions
 *   GET  /api/memos/:id/approver-status
 *   POST /api/memos/approver-status/bulk
 *   POST /api/memos/:id/recall | recall-preserve | recall-clear
 */
@Controller('api/memos')
@UseGuards(JwtAuthGuard)
export class MemoStatusController {
  constructor(
    private readonly status: MemoStatusService,
    private readonly recall: MemoRecallService,
    private readonly approverStatus: ApproverStatusService,
  ) {}

  @Post('approver-status/bulk')
  @HttpCode(HttpStatus.OK)
  bulk(@Body() body: { memoIds?: unknown }, @CurrentUser() user: JwtPayload) {
    return this.approverStatus.getBulk(user.id, body?.memoIds);
  }

  @Get(':id/approver-status')
  approverStatusOne(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.approverStatus.getOne(Number(id), user.id);
  }

  @Get(':id/actions')
  actions(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.status.getMemoActions(Number(id), user.id);
  }

  @Post(':id/action-signature')
  @HttpCode(HttpStatus.OK)
  actionSignature(
    @Param('id') id: string,
    @Body() body: SignatureActionBody,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.status.approveWithSignature(Number(id), user.id, body ?? {});
  }

  @Post(':id/action')
  @HttpCode(HttpStatus.OK)
  act(@Param('id') id: string, @Body() body: ActBody, @CurrentUser() user: JwtPayload) {
    return this.status.act(Number(id), user.id, body ?? {});
  }

  @Post(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() body: StatusBody,
    @CurrentUser() user: JwtPayload,
    @Res({ passthrough: true }) res: Response,
  ) {
    const [code, payload] = await this.status.updateStatus(Number(id), user.id, body ?? {});
    res.status(code);
    return payload;
  }

  @Post(':id/recall')
  recallLegacy(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.recall.recallLegacy(Number(id), user.id);
  }

  @Post(':id/recall-preserve')
  @HttpCode(HttpStatus.OK)
  recallPreserve(
    @Param('id') id: string,
    @Body() body: FileIdBody,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.recall.recallPreserve(Number(id), user.id, body?.fileId);
  }

  @Post(':id/recall-clear')
  @HttpCode(HttpStatus.OK)
  recallClear(@Param('id') id: string, @Body() body: FileIdBody, @CurrentUser() user: JwtPayload) {
    return this.recall.recallClear(Number(id), user.id, body?.fileId);
  }
}

/** GET /api/memos/action/email — no login; the signed token is the credential. */
@Controller('api/memos')
export class EmailActionController {
  constructor(private readonly emailAction: EmailActionService) {}

  @Get('action/email')
  async handle(
    @Query('token') token: unknown,
    @Query('action') action: unknown,
    @Res() res: Response,
  ) {
    const result = await this.emailAction.handle(token, action);
    if ('redirect' in result) {
      res.redirect(result.redirect);
      return;
    }
    res.status(result.status);
    if (result.html) res.type('html').send(result.html);
    else res.end();
  }
}
