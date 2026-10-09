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
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreateLineBody, ExtraApprovalService } from './extra-approval.service';

function parseId(raw: string, error: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new BadRequestException({ error });
  return id;
}

/**
 * Batch 7b — extra approval lines:
 *   POST   /api/memos/:id/extra-approval-lines
 *   GET    /api/memos/:id/extra-approval-lines
 *   GET    /api/memos/:id/extra-approval-lines/active
 *   POST   /api/memos/extra-approval-lines/active/bulk
 *   POST   /api/memos/:memoId/extra-approval-lines/:lineId/action
 *   POST   /api/memos/:memoId/extra-approval-lines/:lineId/append
 *   DELETE /api/memos/:memoId/extra-approval-lines/:lineId
 *   GET    /api/memos/:memoId/extra-approval-lines[/:lineId]/eligible-users?q=
 */
@Controller('api/memos')
@UseGuards(JwtAuthGuard)
export class ExtraApprovalController {
  constructor(private readonly extra: ExtraApprovalService) {}

  @Post('extra-approval-lines/active/bulk')
  @HttpCode(HttpStatus.OK)
  bulk(@Body() body: { memoIds?: unknown }, @CurrentUser() user: JwtPayload) {
    return this.extra.getActiveLinesBulk(user.id, body?.memoIds);
  }

  @Post(':id/extra-approval-lines')
  create(@Param('id') id: string, @Body() body: CreateLineBody, @CurrentUser() user: JwtPayload) {
    return this.extra.createLine(Number(id), user.id, body ?? {});
  }

  @Get(':id/extra-approval-lines')
  list(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.extra.listLines(parseId(id, 'Invalid memoId'), user.id);
  }

  @Get(':id/extra-approval-lines/active')
  active(@Param('id') id: string, @CurrentUser() user: JwtPayload) {
    return this.extra.getActiveLine(parseId(id, 'Invalid memoId'), user.id);
  }

  @Get(':memoId/extra-approval-lines/eligible-users')
  eligible(
    @Param('memoId') memoId: string,
    @Query('q') q: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    const id = parseId(memoId, 'memoId/lineId ไม่ถูกต้อง');
    return this.extra.searchEligibleUsers(id, null, user.id, String(q || '').trim());
  }

  @Get(':memoId/extra-approval-lines/:lineId/eligible-users')
  eligibleForLine(
    @Param('memoId') memoId: string,
    @Param('lineId') lineId: string,
    @Query('q') q: string | undefined,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.extra.searchEligibleUsers(
      parseId(memoId, 'memoId/lineId ไม่ถูกต้อง'),
      parseId(lineId, 'memoId/lineId ไม่ถูกต้อง'),
      user.id,
      String(q || '').trim(),
    );
  }

  @Post(':memoId/extra-approval-lines/:lineId/action')
  @HttpCode(HttpStatus.OK)
  act(
    @Param('memoId') memoId: string,
    @Param('lineId') lineId: string,
    @Body() body: { statusCode?: unknown },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.extra.act(
      parseId(memoId, 'Invalid memoId'),
      parseId(lineId, 'Invalid lineId'),
      user.id,
      body?.statusCode,
    );
  }

  @Post(':memoId/extra-approval-lines/:lineId/append')
  @HttpCode(HttpStatus.OK)
  append(
    @Param('memoId') memoId: string,
    @Param('lineId') lineId: string,
    @Body() body: { userIds?: unknown },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.extra.appendApprovers(Number(memoId), Number(lineId), user.id, body?.userIds);
  }

  @Delete(':memoId/extra-approval-lines/:lineId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('memoId') memoId: string,
    @Param('lineId') lineId: string,
    @CurrentUser() user: JwtPayload,
  ): Promise<void> {
    await this.extra.removeLine(
      parseId(memoId, 'Invalid memoId or lineId'),
      parseId(lineId, 'Invalid memoId or lineId'),
      user.id,
    );
  }
}
