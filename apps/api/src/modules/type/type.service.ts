import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Pure business logic for GET /api/types.
 * Behavior parity with Express type.routes.ts inline handler.
 */
@Injectable()
export class TypeService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll() {
    return this.prisma.memoType.findMany();
  }
}
