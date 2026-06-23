import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Req,
  Res,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { UserService } from './user.service';
import { JwtAuthGuard, JwtPayload } from '../../common/guards/jwt.guard';
import { SelfOrAdminGuard } from '../../common/guards/self-or-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SetDelegationDto } from './dto/set-delegation.dto';
import { UpdateNotificationPreferenceDto } from './dto/update-notification-preference.dto';
import { UpdateBuAccessDto } from './dto/update-bu-access.dto';
import { memoryStorage } from 'multer';

/**
 * Mirrors Express /api/users routes.
 * Note: /api/users/:id/signatures, /:id/default-signature, /signatures/:sigId routes
 * are still proxied to Express (userSignature — file upload batch).
 *
 * Route order follows Express user.routes.ts to ensure correct matching:
 * - Specific paths (check-email, search, basic-info, archived, me/*) before /:id
 * - /me/notification-preferences before /:id dynamic
 */
@Controller('api/users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  // ── public / check ────────────────────────────────────────────────────────

  @Get('check-email')
  checkEmail(
    @Query('email') email: string,
    @Query('excludeId') excludeId?: string,
  ) {
    return this.userService.checkEmailExists(email, excludeId ? Number(excludeId) : undefined);
  }

  @Get('search')
  @UseGuards(JwtAuthGuard)
  searchUsers(
    @Query('q') q: string = '',
    @Query('limit') limit: string = '10',
    @Query('exclude') exclude: string = '',
  ) {
    const excludeIds = exclude
      ? exclude.split(',').map(Number).filter((n) => !isNaN(n))
      : [];
    return this.userService.searchUsers(q, Number(limit), excludeIds);
  }

  @Get('basic-info')
  @UseGuards(JwtAuthGuard)
  getUsersBasicInfo(@Query('ids') ids: string) {
    return this.userService.getUsersBasicInfo(ids);
  }

  @Get('archived')
  @UseGuards(JwtAuthGuard)
  getArchivedUsers() {
    return this.userService.getArchivedUsers();
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  getAllUsers() {
    return this.userService.getAllUsers();
  }

  // ── notification preferences (me) — must precede /:id ────────────────────

  @Get('me/notification-preferences')
  @UseGuards(JwtAuthGuard)
  getNotificationPreferences(@CurrentUser() user: JwtPayload) {
    return this.userService.getNotificationPreferences(user.id);
  }

  @Put('me/notification-preferences/bulk')
  @UseGuards(JwtAuthGuard)
  updateBulkNotificationPreferences(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UpdateNotificationPreferenceDto,
  ) {
    return this.userService.updateAllNotificationPreferences(user.id, dto.emailEnabled);
  }

  @Put('me/notification-preferences/:typeId')
  @UseGuards(JwtAuthGuard)
  updateSingleNotificationPreference(
    @CurrentUser() user: JwtPayload,
    @Param('typeId', ParseIntPipe) typeId: number,
    @Body() dto: UpdateNotificationPreferenceDto,
  ) {
    return this.userService.updateNotificationPreference(user.id, typeId, dto.emailEnabled);
  }

  // ── bulk ──────────────────────────────────────────────────────────────────

  @Post('bulk')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  bulkGetUsers(@Body('ids') ids: number[]) {
    return this.userService.bulkGetUsers(ids);
  }

  // ── CRUD by :id ───────────────────────────────────────────────────────────

  @Get(':id')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  getUserById(@Param('id', ParseIntPipe) id: number) {
    return this.userService.getUserById(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('image', { storage: memoryStorage() }))
  async createUser(
    @Req() req: Request & { body: Record<string, any>; file?: Express.Multer.File },
    @CurrentUser() user: JwtPayload,
  ) {
    if (req.body && 'id' in req.body) {
      delete (req.body as any)['id'];
    }

    const profileImagePath = req.file
      ? (() => {
          const p = (req.file.path || req.file.filename || '').replace(/\\/g, '/');
          const m = p.match(/(?:^|\/)profiles\/(.+)$/);
          return m ? `profiles/${m[1]}` : `profiles/${p.split('/').pop() || ''}`;
        })()
      : null;

    return this.userService.createUser(req.body, user.id, profileImagePath);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  @UseInterceptors(FileInterceptor('image', { storage: memoryStorage() }))
  async updateUser(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request & { body: Record<string, any>; file?: Express.Multer.File },
    @CurrentUser() user: JwtPayload,
  ) {
    return this.userService.updateUser(id, req.body, user.id, req.file);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteUser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.userService.deleteUser(id, user.id);
  }

  @Post(':id/restore')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async restoreUser(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.userService.restoreUser(id, user.id);
  }

  @Put(':id/change-password')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  changePassword(
    @Param('id', ParseIntPipe) id: number,
    @Body('current') current: string,
    @Body('next') next: string,
  ) {
    return this.userService.changePassword(id, current, next);
  }

  @Put(':id/profile-image')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage() }))
  async uploadProfileImage(
    @Param('id', ParseIntPipe) id: number,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('No file uploaded');
    const p = (file.path || file.filename || '').replace(/\\/g, '/');
    const m = p.match(/(?:^|\/)profiles\/(.+)$/);
    const imagePath = m ? `profiles/${m[1]}` : `profiles/${p.split('/').pop() || ''}`;
    return this.userService.updateProfileImage(id, imagePath);
  }

  @Post(':id/force-password-reset')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  forcePasswordReset(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.userService.forcePasswordReset(id, user.id);
  }

  @Post(':id/clear-first-login')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  clearFirstLogin(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.userService.clearFirstLogin(id, user.id);
  }

  // ── delegation ────────────────────────────────────────────────────────────

  @Put(':id/delegation')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  setDelegation(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SetDelegationDto,
  ) {
    return this.userService.setDelegation(
      id,
      dto.delegatedToUserId,
      dto.delegationStartDate,
      dto.delegationEndDate,
    );
  }

  @Get(':id/delegation')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  getDelegation(@Param('id', ParseIntPipe) id: number) {
    return this.userService.getDelegation(id);
  }

  @Delete(':id/delegation')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  clearDelegation(@Param('id', ParseIntPipe) id: number) {
    return this.userService.clearDelegation(id);
  }

  // ── Business Unit Access ──────────────────────────────────────────────────

  @Get(':id/business-unit-access')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  getUserBuAccess(@Param('id', ParseIntPipe) id: number) {
    return this.userService.getUserBusinessUnitAccess(id);
  }

  @Put(':id/business-unit-access')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  updateUserBuAccess(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBuAccessDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.userService.updateUserBusinessUnitAccess(id, dto.businessUnitIds, user.id);
  }

  @Get(':id/accessible-business-units')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  getAccessibleBusinessUnits(@Param('id', ParseIntPipe) id: number) {
    return this.userService.getAccessibleBusinessUnits(id);
  }

  // ── DCC Management Access ─────────────────────────────────────────────────

  @Get(':id/dcc-management-access')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  getDccAccess(@Param('id', ParseIntPipe) id: number) {
    return this.userService.getDCCManagementAccess(id);
  }

  @Put(':id/dcc-management-access')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  updateDccAccess(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBuAccessDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.userService.updateDCCManagementAccess(id, dto.businessUnitIds, user.id, user.role);
  }

  @Get(':id/manageable-business-units')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  getManageableBusinessUnits(@Param('id', ParseIntPipe) id: number) {
    return this.userService.getManageableBusinessUnits(id);
  }
}
