import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

/**
 * Shared provider that writes admin audit log entries.
 *
 * Mirrors Express `createAdminLog` helper in
 * backend/src/controllers/adminLog.controller.ts:
 *   - non-throwing (errors are logged, never propagate to callers)
 *   - same schema fields: actorId, actionType, module, targetId,
 *     targetName, details
 */
@Injectable()
export class AdminLogService {
  private readonly logger = new Logger(AdminLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Write one audit log entry.  Safe to call without awaiting in
   * fire-and-forget style — it never throws.
   */
  async write(
    actorId: number,
    actionType: string,
    module: string,
    targetId: number | null | undefined,
    targetName: string | null | undefined,
    details: Prisma.InputJsonValue | null,
  ): Promise<void> {
    try {
      await this.prisma.adminLog.create({
        data: {
          actorId,
          actionType,
          module,
          targetId: targetId ?? null,
          targetName: targetName ?? null,
          details:
            details !== null && details !== undefined
              ? (details as Prisma.InputJsonValue)
              : Prisma.JsonNull,
        },
      });
    } catch (error: unknown) {
      // Matches Express behavior: logging must not break main operations.
      this.logger.error('Failed to create admin log', error);
    }
  }
}
