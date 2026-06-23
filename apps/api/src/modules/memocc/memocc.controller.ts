/**
 * MemoCcController
 *
 * Mirrors Express memocc.routes.ts parity 100%:
 *   GET    /api/memos/cc/me          — list memos where I'm CC
 *   GET    /api/memos/:id/cc         — list CC users of a memo
 *   PUT    /api/memos/:id/cc         — replace CC (bulk)
 *   POST   /api/memos/:id/cc/:userId — add one CC user
 *   DELETE /api/memos/:id/cc/:userId — remove one CC user
 *
 * IMPORTANT: /api/memos/cc/me must be declared before /api/memos/:id/cc
 * so Nest does not treat "cc" as a numeric :id parameter.
 *
 * Security: JwtAuthGuard on all routes.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MemoCcService } from './memocc.service';
import { ReplaceCcDto } from './dto/replace-cc.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class MemoCcController {
  constructor(private readonly service: MemoCcService) {}

  // GET /api/memos/cc/me — MUST be before /api/memos/:id/cc
  @Get('api/memos/cc/me')
  listMemosCcToMe(@CurrentUser() user: JwtPayload) {
    return this.service.listMemosCcToMe(user);
  }

  // GET /api/memos/:id/cc
  @Get('api/memos/:id/cc')
  listCc(@Param('id', ParseIntPipe) memoId: number) {
    return this.service.listCc(memoId);
  }

  // PUT /api/memos/:id/cc
  @Put('api/memos/:id/cc')
  @HttpCode(HttpStatus.OK)
  replaceCc(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) memoId: number,
    @Body() dto: ReplaceCcDto,
  ) {
    return this.service.replaceCc(user, memoId, dto);
  }

  // POST /api/memos/:id/cc/:userId
  @Post('api/memos/:id/cc/:userId')
  @HttpCode(HttpStatus.CREATED)
  addCcOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) memoId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.service.addCcOne(user, memoId, userId);
  }

  // DELETE /api/memos/:id/cc/:userId
  @Delete('api/memos/:id/cc/:userId')
  @HttpCode(HttpStatus.OK)
  removeCcOne(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) memoId: number,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.service.removeCcOne(user, memoId, userId);
  }
}
