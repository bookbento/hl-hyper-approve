/**
 * LoaManagementController
 *
 * Mirrors Express loa_management.routes.ts parity 100%:
 *   GET  /api/approver-lines                            — all lines (admin table)
 *   GET  /api/approver-lines/:userId                    — lines for a specific user
 *   GET  /api/approver-lines/:lineId/memo-types         — memo types for a line
 *   PUT  /api/approver-lines/:id                        — update slots for a line
 *   POST /api/approvers/replace                         — replace approver
 *   POST /api/approvers/bulk-update                     — bulk update (replace/flexible/remove)
 *   POST /api/approvers/bulk-signature-update           — bulk signature toggle
 *   POST /api/approvers/bulk-reorder                    — bulk reorder level
 *   POST /api/approval-lines/:id/update-approvers       — alias for update slots
 *
 * Security: JwtAuthGuard + ADMIN or DCC role (checked in service).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { LoaManagementService } from './loa-management.service';
import { BulkUpdateApproverDto } from './dto/bulk-update-approver.dto';
import { ReplaceApproverDto } from './dto/replace-approver.dto';
import { UpdateApproversForLineDto } from './dto/update-approvers-for-line.dto';

@Controller()
@UseGuards(JwtAuthGuard)
export class LoaManagementController {
  constructor(private readonly service: LoaManagementService) {}

  // GET /api/approver-lines
  @Get('api/approver-lines')
  getAllApproverLines(
    @CurrentUser() user: JwtPayload,
    @Query('businessUnitId') businessUnitId?: string,
  ) {
    const buId = businessUnitId ? Number(businessUnitId) : null;
    return this.service.getAllApproverLines(user, buId);
  }

  // GET /api/approver-lines/:userId
  @Get('api/approver-lines/:userId')
  getApproverLines(
    @CurrentUser() user: JwtPayload,
    @Param('userId', ParseIntPipe) userId: number,
  ) {
    return this.service.getApproverLines(user, userId);
  }

  // GET /api/approver-lines/:lineId/memo-types
  // NOTE: This route conflicts with :userId — Nest resolves by registration order.
  // The route is registered with a more specific path so it won't clash.
  @Get('api/approver-lines/:lineId/memo-types')
  getMemoTypesForLine(
    @CurrentUser() user: JwtPayload,
    @Param('lineId', ParseIntPipe) lineId: number,
  ) {
    return this.service.getMemoTypesForLine(user, lineId);
  }

  // PUT /api/approver-lines/:id
  @Put('api/approver-lines/:id')
  @HttpCode(HttpStatus.OK)
  updateApproversForLine(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateApproversForLineDto,
  ) {
    return this.service.updateApproversForLine(user, id, dto);
  }

  // POST /api/approvers/replace
  @Post('api/approvers/replace')
  @HttpCode(HttpStatus.OK)
  replaceApprover(@CurrentUser() user: JwtPayload, @Body() dto: ReplaceApproverDto) {
    return this.service.replaceApprover(user, dto);
  }

  // POST /api/approvers/bulk-update
  @Post('api/approvers/bulk-update')
  @HttpCode(HttpStatus.OK)
  bulkUpdateApprover(@CurrentUser() user: JwtPayload, @Body() dto: BulkUpdateApproverDto) {
    return this.service.bulkUpdateApprover(user, dto);
  }

  // POST /api/approvers/bulk-signature-update
  @Post('api/approvers/bulk-signature-update')
  @HttpCode(HttpStatus.OK)
  bulkUpdateSignature(@CurrentUser() user: JwtPayload, @Body() dto: BulkUpdateApproverDto) {
    return this.service.bulkUpdateSignature(user, dto);
  }

  // POST /api/approvers/bulk-reorder
  @Post('api/approvers/bulk-reorder')
  @HttpCode(HttpStatus.OK)
  bulkReorderApprover(@CurrentUser() user: JwtPayload, @Body() dto: BulkUpdateApproverDto) {
    return this.service.bulkReorderApprover(user, dto);
  }

  // POST /api/approval-lines/:id/update-approvers (legacy alias)
  @Post('api/approval-lines/:id/update-approvers')
  @HttpCode(HttpStatus.OK)
  updateApproversForLineLegacy(
    @CurrentUser() user: JwtPayload,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateApproversForLineDto,
  ) {
    return this.service.updateApproversForLine(user, id, dto);
  }
}
