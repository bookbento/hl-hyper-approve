import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { AdminLogReadService } from './admin-log-read.service';
import { CreateLogDto } from './dto/create-log.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/guards/jwt.guard';

/**
 * Mirrors Express /api/admin-logs routes:
 *   GET  /      authenticate + authorizeAdminLogRead (admin all; dcc restricted modules)
 *   GET  /all   authenticate + authorizeAdmin (admin only)
 *   POST /      authenticate + authorizeAdmin
 *
 * DCC module restriction is enforced inside AdminLogReadService.getLogsByModule().
 */
@Controller('api/admin-logs')
@UseGuards(JwtAuthGuard)
export class AdminLogController {
  constructor(private readonly service: AdminLogReadService) {}

  @Get()
  getLogsByModule(
    @Query('module') module: string = '',
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '50',
    @Query('search') search: string = '',
    @Query('actionType') actionType: string = '',
    @Query('startDate') startDate: string = '',
    @Query('endDate') endDate: string = '',
    @Query('targetId') targetId: string = '',
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getLogsByModule(user, {
      module,
      page: Math.max(1, parseInt(page, 10) || 1),
      limit: Math.min(100, Math.max(1, parseInt(limit, 10) || 50)),
      search: search.trim() || undefined,
      actionType: actionType.trim() || undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      targetId: targetId ? parseInt(targetId, 10) : null,
    });
  }

  @Get('all')
  @UseGuards(RolesGuard)
  @Roles('admin')
  getAllLogs(
    @Query('page') page: string = '1',
    @Query('limit') limit: string = '50',
  ) {
    return this.service.getAllLogs({
      page: Math.max(1, parseInt(page, 10) || 1),
      limit: Math.min(100, Math.max(1, parseInt(limit, 10) || 50)),
    });
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin')
  @HttpCode(HttpStatus.OK)
  async createLog(
    @Body() dto: CreateLogDto,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.createLog(dto, user.id);
    return { success: true };
  }
}
