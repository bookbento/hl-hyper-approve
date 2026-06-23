import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { CcGroupService } from './cc-group.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { RenameGroupDto } from './dto/rename-group.dto';
import { ReplaceMembersDto } from './dto/replace-members.dto';
import { BulkUpdateDto } from './dto/bulk-update.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/guards/jwt.guard';

/**
 * Mirrors Express /api/cc-groups routes:
 *   GET  /search       authenticate (any logged-in user)
 *   GET  /basic-info   authenticate (any logged-in user)
 *   GET  /             authenticate (any logged-in user)
 *   POST /             authenticate + admin|dcc
 *   POST /bulk-update  authenticate + admin|dcc
 *   GET  /:id          authenticate + admin|dcc
 *   PUT  /:id          authenticate + admin|dcc
 *   PUT  /:id/members  authenticate + admin|dcc (owner or admin/dcc check in service)
 *   DELETE /:id        authenticate + admin|dcc (owner or admin/dcc check in service)
 */
@Controller('api/cc-groups')
@UseGuards(JwtAuthGuard)
export class CcGroupController {
  constructor(private readonly service: CcGroupService) {}

  @Get('search')
  search(
    @Query('q') q: string = '',
    @Query('limit') limit: string = '10',
  ) {
    return this.service.searchCcGroups({ q, limit: parseInt(limit, 10) });
  }

  @Get('basic-info')
  basicInfo(@Query('ids') ids: string = '') {
    return this.service.getGroupsBasicInfo(ids);
  }

  @Get()
  listMyGroups(@CurrentUser() user: JwtPayload) {
    return this.service.listMyGroups(user);
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles('admin', 'dcc')
  @HttpCode(HttpStatus.CREATED)
  createGroup(
    @Body() dto: CreateGroupDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.createGroup(dto, user);
  }

  @Post('bulk-update')
  @UseGuards(RolesGuard)
  @Roles('admin', 'dcc')
  bulkUpdate(
    @Body() dto: BulkUpdateDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.bulkUpdateMembers(user, dto);
  }

  @Get(':id')
  @UseGuards(RolesGuard)
  @Roles('admin', 'dcc')
  getGroup(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.getGroup(user, id);
  }

  @Put(':id')
  @UseGuards(RolesGuard)
  @Roles('admin', 'dcc')
  renameGroup(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RenameGroupDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.renameGroup(user, id, dto);
  }

  @Put(':id/members')
  @UseGuards(RolesGuard)
  @Roles('admin', 'dcc')
  replaceMembers(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ReplaceMembersDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.replaceGroupMembers(user, id, dto);
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles('admin', 'dcc')
  deleteGroup(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.deleteGroup(user, id);
  }
}
