/**
 * MemoQueryController (Nest)
 *
 * Handles READ/query memo endpoints migrated from Express memo.routes.ts (Batch 6a).
 * All routes require JwtAuthGuard.
 *
 * CRITICAL PATH ORDERING:
 * Static paths must be declared BEFORE parameterized paths to prevent Nest
 * routing /:id matching literal segments like "awaiting-approval".
 *
 * Order:
 *   1. POST  /api/memos/search             — searchMemos
 *   2. POST  /api/memos/search/stats       — searchMemoStats
 *   3. POST  /api/memos/users-delegation-info
 *   4. GET   /api/memos/awaiting-approval  — static, before /:id
 *   5. GET   /api/memos/current-approvers  — static, before /:id
 *   6. GET   /api/memos/search-for-reference — static, before /:id
 *   7. GET   /api/memos                    — list
 *   8. GET   /api/memos/:id                — single memo (LAST among flat /:id routes)
 *   9. GET   /api/memos/:id/references
 *  10. PUT   /api/memos/:id/references
 *  11. GET   /api/memos/:id/reference-content/:referenceId
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MemoQueryService } from './memo-query.service';
import { MemoSearchNestService } from './memo-search.service';
import { MemoReferenceNestService } from './memo-reference.service';
import { SearchMemosDto } from './dto/search-memos.dto';
import { SearchStatsDto } from './dto/search-stats.dto';
import { UsersDelegationInfoDto } from './dto/users-delegation-info.dto';
import { UpdateReferencesDto } from './dto/update-references.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class MemoQueryController {
  constructor(
    private readonly memoQuery: MemoQueryService,
    private readonly memoSearch: MemoSearchNestService,
    private readonly memoReference: MemoReferenceNestService,
  ) {}

  // ── 1. POST /api/memos/search ───────────────────────────────────────────────
  @Post('api/memos/search')
  @HttpCode(HttpStatus.OK)
  async searchMemos(
    @Body() dto: SearchMemosDto,
    @CurrentUser() user: JwtPayload,
    @Req() req: Request,
  ) {
    const pageSize = dto.pageSize;
    if (
      pageSize !== undefined &&
      pageSize !== 'all' &&
      (typeof pageSize !== 'number' || pageSize < 1 || pageSize > 100)
    ) {
      return { error: "pageSize must be 1-100 or 'all'" };
    }

    const hostUrl = `${req.protocol}://${req.get('host') ?? ''}`;
    return this.memoSearch.searchMemos(dto as any, user.id, hostUrl);
  }

  // ── 2. POST /api/memos/search/stats ────────────────────────────────────────
  @Post('api/memos/search/stats')
  @HttpCode(HttpStatus.OK)
  async searchMemoStats(
    @Body() dto: SearchStatsDto,
    @CurrentUser() user: JwtPayload,
  ) {
    const statCounts = await this.memoSearch.getCachedStatCounts(
      user.id,
      dto.forceRefresh,
    );
    return { statCounts };
  }

  // ── 3. POST /api/memos/users-delegation-info ────────────────────────────────
  @Post('api/memos/users-delegation-info')
  @HttpCode(HttpStatus.OK)
  async getUsersDelegationInfo(@Body() dto: UsersDelegationInfoDto) {
    return this.memoQuery.getUsersDelegationInfo(dto.userIds);
  }

  // ── 4. GET /api/memos/awaiting-approval — MUST be before /:id ───────────────
  @Get('api/memos/awaiting-approval')
  async getAwaitingApproval(@CurrentUser() user: JwtPayload) {
    return this.memoQuery.getAwaitingApproval(user.id);
  }

  // ── 5. GET /api/memos/current-approvers — MUST be before /:id ───────────────
  @Get('api/memos/current-approvers')
  async getCurrentApprovers(@CurrentUser() user: JwtPayload) {
    return this.memoQuery.getCurrentApprovers(user.id);
  }

  // ── 6. GET /api/memos/search-for-reference — MUST be before /:id ────────────
  @Get('api/memos/search-for-reference')
  async searchMemosForReference(
    @CurrentUser() user: JwtPayload,
    @Query('q') q = '',
    @Query('exclude') exclude = '',
    @Query('limit') limit = '10',
  ) {
    return this.memoReference.searchMemosForReference(
      user.id,
      String(q).trim(),
      String(exclude),
      Number(limit),
    );
  }

  // ── 7. GET /api/memos ───────────────────────────────────────────────────────
  @Get('api/memos')
  async getAllMemos(@CurrentUser() user: JwtPayload, @Req() req: Request) {
    const hostUrl = `${req.protocol}://${req.get('host') ?? ''}`;
    return this.memoQuery.getAllMemos(user.id, hostUrl);
  }

  // ── 8. GET /api/memos/:id ────────────────────────────────────────────────────
  // MUST be after all static /api/memos/* routes
  @Get('api/memos/:id')
  async getMemoById(
    @Param('id') idParam: string,
    @CurrentUser() user: JwtPayload,
    @Query('token') token?: string,
  ) {
    const memoId = Number(idParam);
    if (isNaN(memoId)) throw new NotFoundException('Memo not found');
    return this.memoQuery.getMemoById(memoId, user.id, token);
  }

  // ── 9. GET /api/memos/:id/references ────────────────────────────────────────
  @Get('api/memos/:id/references')
  async getMemoReferences(
    @Param('id', ParseIntPipe) memoId: number,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.memoReference.getMemoReferences(memoId, user.id);
  }

  // ── 10. PUT /api/memos/:id/references ───────────────────────────────────────
  @Put('api/memos/:id/references')
  @HttpCode(HttpStatus.OK)
  async updateMemoReferences(
    @Param('id', ParseIntPipe) memoId: number,
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateReferencesDto,
  ) {
    return this.memoReference.updateMemoReferences(memoId, user.id, dto.referenceIds);
  }

  // ── 11. GET /api/memos/:id/reference-content/:referenceId ───────────────────
  @Get('api/memos/:id/reference-content/:referenceId')
  async getReferenceMemoContent(
    @Param('id', ParseIntPipe) memoId: number,
    @Param('referenceId', ParseIntPipe) referenceId: number,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.memoReference.getReferenceMemoContent(memoId, referenceId, user.id);
  }
}
