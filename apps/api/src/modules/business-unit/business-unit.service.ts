import {
  Injectable,
  NotFoundException,
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { CreateBusinessUnitDto } from './dto/create-business-unit.dto';
import { UpdateBusinessUnitDto } from './dto/update-business-unit.dto';
import { BusinessUnit, Prisma } from '@prisma/client';

export type BusinessUnitWithDepartments = BusinessUnit & {
  departments: { id: number; name: string; businessUnitId: number | null }[];
};

/**
 * Pure business logic provider — no HTTP, no req/res.
 * Throws Nest exceptions; controller maps them to HTTP responses.
 *
 * Behavior parity with Express businessUnit.controller.ts.
 */
@Injectable()
export class BusinessUnitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminLog: AdminLogService,
  ) {}

  async findAll(): Promise<BusinessUnitWithDepartments[]> {
    return this.prisma.businessUnit.findMany({
      include: {
        departments: {
          where: { deletedAt: null },
          select: { id: true, name: true, businessUnitId: true },
        },
      },
    });
  }

  async findOne(id: number): Promise<BusinessUnit> {
    const unit = await this.prisma.businessUnit.findUnique({ where: { id } });
    if (!unit) {
      throw new NotFoundException('Business unit not found');
    }
    return unit;
  }

  async create(
    dto: CreateBusinessUnitDto,
    actorId: number | undefined,
  ): Promise<BusinessUnit> {
    const existing = await this.prisma.businessUnit.findUnique({
      where: { name: dto.name },
    });
    if (existing) {
      throw new ConflictException('Business unit with this name already exists');
    }

    try {
      const newUnit = await this.prisma.businessUnit.create({
        data: {
          name: dto.name,
          abbreviation: dto.abbreviation ?? null,
        },
      });

      if (actorId) {
        await this.adminLog.write(
          actorId,
          'BU_CREATE',
          'BUSINESS_UNIT',
          newUnit.id,
          newUnit.name,
          { abbreviation: newUnit.abbreviation },
        );
      }

      return newUnit;
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Business unit with this name already exists');
      }
      throw new InternalServerErrorException('Failed to create business unit');
    }
  }

  async update(
    id: number,
    dto: UpdateBusinessUnitDto,
    actorId: number | undefined,
  ): Promise<BusinessUnit> {
    const existing = await this.prisma.businessUnit.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Business unit not found');
    }

    const duplicate = await this.prisma.businessUnit.findFirst({
      where: { name: dto.name, id: { not: id } },
    });
    if (duplicate) {
      throw new ConflictException('Business unit with this name already exists');
    }

    try {
      const updated = await this.prisma.businessUnit.update({
        where: { id },
        data: {
          name: dto.name,
          abbreviation: dto.abbreviation ?? null,
        },
      });

      if (actorId) {
        const changes: Record<string, { old: unknown; new: unknown }> = {};
        if (existing.name !== updated.name) {
          changes['name'] = { old: existing.name, new: updated.name };
        }
        if (existing.abbreviation !== updated.abbreviation) {
          changes['abbreviation'] = {
            old: existing.abbreviation,
            new: updated.abbreviation,
          };
        }
        if (Object.keys(changes).length > 0) {
          await this.adminLog.write(
            actorId,
            'BU_UPDATE',
            'BUSINESS_UNIT',
            updated.id,
            updated.name,
            { changes } as unknown as Prisma.InputJsonValue,
          );
        }
      }

      return updated;
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Business unit with this name already exists');
      }
      throw new InternalServerErrorException('Failed to update business unit');
    }
  }

  async remove(id: number, actorId: number | undefined): Promise<void> {
    const existing = await this.prisma.businessUnit.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Business unit not found');
    }

    try {
      await this.prisma.businessUnit.delete({ where: { id } });

      if (actorId) {
        await this.adminLog.write(
          actorId,
          'BU_DELETE',
          'BUSINESS_UNIT',
          existing.id,
          existing.name,
          { abbreviation: existing.abbreviation },
        );
      }
    } catch {
      throw new InternalServerErrorException('Failed to delete business unit');
    }
  }
}
