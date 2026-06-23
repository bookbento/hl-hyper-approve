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
import { BusinessUnitService } from './business-unit.service';
import { CreateBusinessUnitDto } from './dto/create-business-unit.dto';
import { UpdateBusinessUnitDto } from './dto/update-business-unit.dto';
import { JwtAuthGuard } from '../../common/guards/jwt.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtPayload } from '../../common/guards/jwt.guard';

/**
 * Mirrors Express /api/business-units routes:
 *   GET    /              public
 *   GET    /:id           public
 *   POST   /              admin | dcc
 *   PUT    /:id           admin | dcc
 *   DELETE /:id           admin | dcc
 */
@Controller('api/business-units')
export class BusinessUnitController {
  constructor(private readonly service: BusinessUnitService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.service.findOne(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'dcc')
  @HttpCode(HttpStatus.CREATED)
  create(
    @Body() dto: CreateBusinessUnitDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.create(dto, user.id);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'dcc')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateBusinessUnitDto,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.update(id, dto, user.id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'dcc')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: JwtPayload,
  ) {
    return this.service.remove(id, user.id);
  }
}
