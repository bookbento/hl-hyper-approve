import {
  Injectable,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { CreateLogDto } from './dto/create-log.dto';
import { Prisma } from '@prisma/client';
import { JwtPayload } from '../../common/guards/jwt.guard';

/** Modules that DCC is allowed to read */
const DCC_READABLE_MODULES = new Set(['MEMO_TYPE', 'CC_GROUP', 'LOA']);

/**
 * Read-side logic for admin logs (HTTP API).
 * Write-side is handled by AdminLogService (@Global).
 *
 * Behavior parity with Express adminLog.controller.ts:
 *   getLogsByModule, getAllLogs, createLog
 */
@Injectable()
export class AdminLogReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminLog: AdminLogService,
  ) {}

  /**
   * Enforces DCC module restriction.
   * Mirrors Express authorizeAdminLogRead middleware logic.
   */
  assertCanRead(user: JwtPayload, module: string): void {
    const role = (user.role ?? '').toLowerCase();
    if (role === 'admin') return;
    if (role !== 'dcc') {
      throw new ForbiddenException();
    }
    if (!DCC_READABLE_MODULES.has(module.toUpperCase())) {
      throw new ForbiddenException();
    }
  }

  async getLogsByModule(
    user: JwtPayload,
    query: {
      module?: string;
      page?: number;
      limit?: number;
      search?: string;
      actionType?: string;
      startDate?: string;
      endDate?: string;
      targetId?: number | null;
    },
  ) {
    const module = (query.module ?? '').toUpperCase();

    // Enforce DCC restriction
    this.assertCanRead(user, module);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const skip = (page - 1) * limit;

    const where: Prisma.AdminLogWhereInput = {};

    if (module) where.module = module;
    if (query.actionType) where.actionType = query.actionType;
    if (query.targetId != null && !isNaN(query.targetId)) where.targetId = query.targetId;

    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    if (query.search) {
      where.OR = [
        { targetName: { contains: query.search, mode: 'insensitive' } },
        { actionType: { contains: query.search, mode: 'insensitive' } },
        {
          actor: {
            OR: [
              { name: { contains: query.search, mode: 'insensitive' } },
              { lastname: { contains: query.search, mode: 'insensitive' } },
              { email: { contains: query.search, mode: 'insensitive' } },
            ],
          },
        },
      ];
    }

    const [logs, total] = await Promise.all([
      this.prisma.adminLog.findMany({
        where,
        include: {
          actor: { select: { id: true, name: true, lastname: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.adminLog.count({ where }),
    ]);

    const formattedLogs = logs.map((log) => ({
      ...log,
      createdAtFormatted: this.formatDate(log.createdAt),
    }));

    return {
      logs: formattedLogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getAllLogs(query: { page?: number; limit?: number }) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const skip = (page - 1) * limit;

    const [logs, total] = await Promise.all([
      this.prisma.adminLog.findMany({
        include: {
          actor: { select: { id: true, name: true, lastname: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.adminLog.count(),
    ]);

    const formattedLogs = logs.map((log) => ({
      ...log,
      createdAtFormatted: this.formatDate(log.createdAt),
    }));

    return {
      logs: formattedLogs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async createLog(dto: CreateLogDto, actorId: number): Promise<void> {
    await this.adminLog.write(
      actorId,
      dto.actionType,
      dto.module,
      dto.targetId ?? null,
      dto.targetName ?? null,
      (dto.details as Prisma.InputJsonValue) ?? null,
    );
  }

  private formatDate(date: Date): string {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    const seconds = String(d.getSeconds()).padStart(2, '0');
    return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
  }
}
