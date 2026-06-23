import { Controller, Get } from '@nestjs/common';
import { TypeService } from './type.service';

/**
 * Mirrors Express GET /api/types — public, no auth required.
 */
@Controller('api/types')
export class TypeController {
  constructor(private readonly service: TypeService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }
}
