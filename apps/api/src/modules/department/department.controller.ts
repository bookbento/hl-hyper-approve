import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { DepartmentService } from './department.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { SelfOrAdminGuard } from '../../common/guards/self-or-admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/guards/jwt.guard';

/**
 * Mirrors Express /api/departments routes:
 *   GET    /              public (no auth)
 *   GET    /archived      JwtAuthGuard + SelfOrAdminGuard (admin only in practice)
 *   GET    /:id           JwtAuthGuard + SelfOrAdminGuard
 *   POST   /              JwtAuthGuard + SelfOrAdminGuard
 *   PUT    /:id           JwtAuthGuard + SelfOrAdminGuard
 *   DELETE /:id           JwtAuthGuard + SelfOrAdminGuard
 *   PUT    /restore/:id   JwtAuthGuard + SelfOrAdminGuard
 */
@Controller('api/departments')
export class DepartmentController {
  constructor(private readonly service: DepartmentService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get('archived')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  findArchived() {
    return this.service.findArchived();
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateDepartmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.create(dto, user.id);
  }

  @Put('restore/:id')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async restore(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.restore(id, user.id);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateDepartmentDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user.id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, SelfOrAdminGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    await this.service.remove(id, user.id);
  }
}
