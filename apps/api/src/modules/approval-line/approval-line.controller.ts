/**
 * ApprovalLineController
 *
 * Mirrors backend/src/routes/approval-line.routes.ts exactly:
 *   GET    /api/teams                        — departments list
 *   GET    /api/approval-lines               — placeholder (no-op: same as Express)
 *   GET    /api/teams/:id/approval-lines     — placeholder (no-op: same as Express)
 *   POST   /api/approval-lines               — create
 *   PUT    /api/approval-lines/:id           — update
 *   DELETE /api/approval-lines/:id           — delete
 *   GET    /api/memos/:id/approvers          — get approvers for memo
 *   GET    /api/memos/:id/approval-line      — get approval line state for memo
 *   GET    /api/approval-requests/my         — list my pending approvals
 *
 * Security:
 *   - JwtAuthGuard on all routes (mirrors Express authenticate middleware).
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { ApprovalLineService } from './approval-line.service';
import { CreateApprovalLineDto } from './dto/create-approval-line.dto';
import { UpdateApprovalLineDto } from './dto/update-approval-line.dto';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller()
@UseGuards(JwtAuthGuard)
export class ApprovalLineController {
  constructor(private readonly service: ApprovalLineService) {}

  // GET /api/teams
  @Get('api/teams')
  getAllTeams() {
    return this.service.getAllTeams();
  }

  // GET /api/approval-lines (no handler body in Express — returns empty for now)
  @Get('api/approval-lines')
  getApprovalLines() {
    return [];
  }

  // GET /api/teams/:id/approval-lines (no handler body in Express — returns empty)
  @Get('api/teams/:id/approval-lines')
  getTeamApprovalLines(@Param('id', ParseIntPipe) _id: number) {
    return [];
  }

  // POST /api/approval-lines
  @Post('api/approval-lines')
  async createApprovalLine(
    @Body() dto: CreateApprovalLineDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.createApprovalLine(user, dto.name, dto.levels);
  }

  // PUT /api/approval-lines/:id
  @Put('api/approval-lines/:id')
  async updateApprovalLine(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateApprovalLineDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.updateApprovalLine(user, id, dto.name, dto.levels);
  }

  // DELETE /api/approval-lines/:id
  @Delete('api/approval-lines/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteApprovalLine(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.deleteApprovalLine(user, id);
  }

  // GET /api/memos/:id/approvers
  @Get('api/memos/:id/approvers')
  async getApprovers(@Param('id') idParam: string) {
    const memoId = Number(idParam);
    if (Number.isNaN(memoId)) throw new BadRequestException('Invalid memo ID');
    return this.service.getApprovers(memoId);
  }

  // GET /api/memos/:id/approval-line
  @Get('api/memos/:id/approval-line')
  async getApprovalLineByMemo(@Param('id') idParam: string) {
    const memoId = Number(idParam);
    if (Number.isNaN(memoId)) throw new BadRequestException('Invalid memo ID');
    return this.service.getApprovalLineByMemo(memoId);
  }

  // GET /api/approval-requests/my
  @Get('api/approval-requests/my')
  async listMyApprovalRequests(@CurrentUser() user: JwtPayload) {
    return this.service.listMyApprovalRequests(user.id);
  }
}
