import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { CreateDepartmentDto } from './dto/create-department.dto';
import { UpdateDepartmentDto } from './dto/update-department.dto';
import { Prisma } from '@prisma/client';

/**
 * Pure business logic — no HTTP, no req/res.
 * Throws Nest exceptions; controller maps them to HTTP responses.
 *
 * Behavior parity with Express department.controller.ts.
 */
@Injectable()
export class DepartmentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminLog: AdminLogService,
  ) {}

  async findAll() {
    return this.prisma.department.findMany({
      where: { deletedAt: null },
      include: {
        businessUnit: { select: { id: true, name: true } },
      },
    });
  }

  async findArchived() {
    return this.prisma.department.findMany({
      where: { deletedAt: { not: null } },
      include: {
        businessUnit: { select: { id: true, name: true } },
      },
      orderBy: { deletedAt: 'desc' },
    });
  }

  async findOne(id: number) {
    const dept = await this.prisma.department.findUnique({
      where: { id },
      include: {
        businessUnit: { select: { id: true, name: true } },
      },
    });
    if (!dept) {
      throw new NotFoundException('Department not found');
    }
    return dept;
  }

  async create(dto: CreateDepartmentDto, actorId: number | undefined) {
    const newDept = await this.prisma.department.create({
      data: {
        name: dto.name,
        abbreviation: dto.abbreviation,
        businessUnitId: dto.businessUnitId ?? null,
      },
      include: {
        businessUnit: { select: { id: true, name: true } },
      },
    });

    if (actorId) {
      await this.adminLog.write(
        actorId,
        'DEPARTMENT_CREATE',
        'DEPARTMENT',
        newDept.id,
        newDept.name,
        {
          abbreviation: newDept.abbreviation,
          businessUnitId: newDept.businessUnitId,
          businessUnitName: newDept.businessUnit?.name ?? null,
        } as Prisma.InputJsonValue,
      );
    }

    return newDept;
  }

  async update(id: number, dto: UpdateDepartmentDto, actorId: number | undefined) {
    const existing = await this.prisma.department.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Department not found');
    }

    const updated = await this.prisma.department.update({
      where: { id },
      data: {
        name: dto.name,
        abbreviation: dto.abbreviation,
        businessUnitId: dto.businessUnitId ?? null,
      },
      include: {
        businessUnit: { select: { id: true, name: true } },
      },
    });

    if (actorId) {
      const changes: Record<string, { old: unknown; new: unknown }> = {};

      if (existing.name !== updated.name) {
        changes['name'] = { old: existing.name, new: updated.name };
      }
      if (existing.abbreviation !== updated.abbreviation) {
        changes['abbreviation'] = { old: existing.abbreviation, new: updated.abbreviation };
      }
      if (existing.businessUnitId !== updated.businessUnitId) {
        const oldBu = existing.businessUnitId
          ? await this.prisma.businessUnit.findUnique({
              where: { id: existing.businessUnitId },
            })
          : null;

        changes['businessUnit'] = {
          old: oldBu?.name ?? null,
          new: updated.businessUnit?.name ?? null,
        };
      }

      if (Object.keys(changes).length > 0) {
        await this.adminLog.write(
          actorId,
          'DEPARTMENT_UPDATE',
          'DEPARTMENT',
          updated.id,
          updated.name,
          { changes } as unknown as Prisma.InputJsonValue,
        );
      }
    }

    return updated;
  }

  async remove(id: number, actorId: number | undefined): Promise<void> {
    const existing = await this.prisma.department.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Department not found');
    }
    if (existing.deletedAt) {
      throw new NotFoundException('Department not found');
    }

    await this.prisma.department.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    if (actorId) {
      const buName = existing.businessUnitId
        ? (
            await this.prisma.businessUnit.findUnique({
              where: { id: existing.businessUnitId },
            })
          )?.name ?? null
        : null;

      await this.adminLog.write(
        actorId,
        'DEPARTMENT_ARCHIVE',
        'DEPARTMENT',
        existing.id,
        existing.name,
        {
          abbreviation: existing.abbreviation,
          businessUnitId: existing.businessUnitId,
          businessUnitName: buName,
        } as Prisma.InputJsonValue,
      );
    }
  }

  async restore(id: number, actorId: number | undefined): Promise<void> {
    const existing = await this.prisma.department.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Department not found');
    }
    if (!existing.deletedAt) {
      throw new BadRequestException('Department is not archived');
    }

    await this.prisma.department.update({
      where: { id },
      data: { deletedAt: null },
    });

    if (actorId) {
      const buName = existing.businessUnitId
        ? (
            await this.prisma.businessUnit.findUnique({
              where: { id: existing.businessUnitId },
            })
          )?.name ?? null
        : null;

      await this.adminLog.write(
        actorId,
        'DEPARTMENT_RESTORE',
        'DEPARTMENT',
        existing.id,
        existing.name,
        {
          abbreviation: existing.abbreviation,
          businessUnitId: existing.businessUnitId,
          businessUnitName: buName,
        } as Prisma.InputJsonValue,
      );
    }
  }
}
