import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApprovalRequirement, ApprovalSlotType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { JwtPayload } from '../../common/guards/jwt.guard';
import { BulkUpdateApproverDto } from './dto/bulk-update-approver.dto';
import { ReplaceApproverDto } from './dto/replace-approver.dto';
import { UpdateApproversForLineDto } from './dto/update-approvers-for-line.dto';

const VALID_SLOT_TYPES: ApprovalSlotType[] = [
  'FIXED_USER',
  'DEPARTMENT_HEAD',
  'MEMO_REQUESTER',
  'FLEXIBLE_SLOT',
];

function isApprovalSlotType(v: unknown): v is ApprovalSlotType {
  return VALID_SLOT_TYPES.includes(v as ApprovalSlotType);
}

function hasRole(user: JwtPayload, target: string): boolean {
  const primary = (user.role ?? '').toString().toUpperCase();
  if (primary === target) return true;
  const roles: string[] = (user as unknown as { roles?: string[] }).roles ?? [];
  return roles.some((r) => (r ?? '').toUpperCase() === target);
}

function isAdmin(user: JwtPayload): boolean {
  return hasRole(user, 'ADMIN');
}

function isDcc(user: JwtPayload): boolean {
  return hasRole(user, 'DCC');
}

function isAdminOrDcc(user: JwtPayload): boolean {
  return isAdmin(user) || isDcc(user);
}

/**
 * LOA Management Service
 *
 * Pure business logic — no HTTP, no req/res.
 * Mirrors loa_management.controller.ts (Express) parity 100%.
 */
@Injectable()
export class LoaManagementService {
  private readonly logger = new Logger(LoaManagementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminLog: AdminLogService,
  ) {}

  private assertAdminOrDcc(user: JwtPayload): void {
    if (!isAdminOrDcc(user)) {
      throw new ForbiddenException('Only ADMIN/DCC can perform this action');
    }
  }

  /** GET /api/approver-lines/:userId */
  async getApproverLines(user: JwtPayload, userId: number) {
    this.assertAdminOrDcc(user);

    const pivots = await this.prisma.lineOfApprovalUserPivot.findMany({
      where: { slotType: 'FIXED_USER', userId },
      include: {
        lineOfApproval: {
          select: {
            id: true,
            name: true,
            businessUnit: { select: { name: true } },
            memoTypes: {
              select: {
                id: true,
                name: true,
                abbreviation: true,
                businessUnit: { select: { name: true } },
                department: { select: { name: true } },
              },
            },
          },
        },
      },
      orderBy: [{ lineOfApprovalId: 'asc' }, { level: 'asc' }],
    });

    if (pivots.length === 0) return [];

    const lineIds = Array.from(
      new Set(
        pivots
          .map((p) => p.lineOfApprovalId)
          .filter((id): id is number => id != null),
      ),
    );

    const allSlots = await this.prisma.lineOfApprovalUserPivot.findMany({
      where: { lineOfApprovalId: { in: lineIds } },
      include: {
        user: {
          select: { id: true, name: true, lastname: true, nickname: true },
        },
      },
    });

    const slotMap = this.buildSlotMap(allSlots, userId);

    return pivots.map((p) => {
      const lo = p.lineOfApproval;
      const firstType = lo?.memoTypes?.[0];
      const slotsForLine = p.lineOfApprovalId != null ? slotMap.get(p.lineOfApprovalId) ?? [] : [];

      return {
        pivotId: p.id,
        lineOfApprovalId: p.lineOfApprovalId,
        lineName: lo?.name ?? null,
        level: p.level,
        businessUnitName: firstType?.businessUnit?.name ?? lo?.businessUnit?.name ?? null,
        departmentName: firstType?.department?.name ?? null,
        memoTypeName: firstType?.name ?? null,
        memoTypeAbbr: firstType?.abbreviation ?? null,
        slots: slotsForLine,
      };
    });
  }

  /** GET /api/approver-lines (all lines) */
  async getAllApproverLines(user: JwtPayload, selectedBuId?: number | null) {
    this.assertAdminOrDcc(user);

    let lineWhereFilter: Prisma.LineOfApprovalWhereInput = {};
    let memoTypeWhereFilter: Prisma.MemoTypeWhereInput = {};

    if (isDcc(user) && !isAdmin(user)) {
      const dccUser = await this.prisma.user.findUnique({
        where: { id: user.id },
        select: {
          businessUnitId: true,
          departmentId: true,
          dccManagementAccess: { select: { businessUnitId: true } },
        },
      });

      const dccBuId = dccUser?.businessUnitId ?? null;
      const dccDeptId = dccUser?.departmentId ?? null;
      const additionalBuIds = (dccUser?.dccManagementAccess ?? []).map((a) => a.businessUnitId);
      const manageableBuIds = dccBuId
        ? [dccBuId, ...additionalBuIds.filter((id) => id !== dccBuId)]
        : additionalBuIds;

      const lineOrConditions: Prisma.LineOfApprovalWhereInput[] = [];
      const memoTypeOrConditions: Prisma.MemoTypeWhereInput[] = [];

      if (selectedBuId && manageableBuIds.includes(selectedBuId)) {
        lineOrConditions.push({ businessUnitId: selectedBuId });
        memoTypeOrConditions.push({ businessUnitId: selectedBuId });
      } else if (manageableBuIds.length > 0) {
        lineOrConditions.push({ businessUnitId: { in: manageableBuIds } });
        memoTypeOrConditions.push({ businessUnitId: { in: manageableBuIds } });
      }

      if (dccDeptId != null) {
        memoTypeOrConditions.push({ departmentId: dccDeptId });
      }
      memoTypeOrConditions.push({ forEveryone: true });

      if (lineOrConditions.length > 0) lineWhereFilter = { OR: lineOrConditions };
      if (memoTypeOrConditions.length > 0) memoTypeWhereFilter = { OR: memoTypeOrConditions };
    }

    const allLines = await this.prisma.lineOfApproval.findMany({
      where: lineWhereFilter,
      select: {
        id: true,
        name: true,
        businessUnitId: true,
        businessUnit: { select: { id: true, name: true } },
        memoTypes: {
          where: memoTypeWhereFilter,
          select: {
            id: true, name: true, abbreviation: true, businessUnitId: true,
            departmentId: true, forEveryone: true,
            businessUnit: { select: { id: true, name: true } },
            department: { select: { id: true, name: true } },
          },
        },
      },
    });

    let additionalLineIds: number[] = [];
    if (isDcc(user) && !isAdmin(user)) {
      const linesWithMatchingMemoTypes = await this.prisma.lineOfApproval.findMany({
        where: { memoTypes: { some: memoTypeWhereFilter } },
        select: { id: true },
      });
      additionalLineIds = linesWithMatchingMemoTypes.map((l) => l.id);
    }

    const existingLineIds = new Set(allLines.map((l) => l.id));
    if (additionalLineIds.length > 0) {
      const additionalLines = await this.prisma.lineOfApproval.findMany({
        where: { id: { in: additionalLineIds.filter((id) => !existingLineIds.has(id)) } },
        select: {
          id: true, name: true, businessUnitId: true,
          businessUnit: { select: { id: true, name: true } },
          memoTypes: {
            where: memoTypeWhereFilter,
            select: {
              id: true, name: true, abbreviation: true, businessUnitId: true,
              departmentId: true, forEveryone: true,
              businessUnit: { select: { id: true, name: true } },
              department: { select: { id: true, name: true } },
            },
          },
        },
      });
      allLines.push(...additionalLines);
    }

    const allLineIds = allLines.map((l) => l.id);
    const pivots = await this.prisma.lineOfApprovalUserPivot.findMany({
      where: { lineOfApprovalId: { in: allLineIds } },
      include: {
        lineOfApproval: {
          select: {
            id: true, name: true,
            businessUnit: { select: { name: true } },
            memoTypes: {
              where: memoTypeWhereFilter,
              select: {
                id: true, name: true, abbreviation: true,
                businessUnit: { select: { name: true } },
                department: { select: { name: true } },
              },
            },
          },
        },
        user: { select: { id: true, name: true, lastname: true, nickname: true } },
      },
      orderBy: [{ lineOfApprovalId: 'asc' }, { level: 'asc' }],
    });

    const slotMap = this.buildSlotMap(pivots, null);

    const linesWithPivots = Array.from(slotMap.entries()).map(([lineId, slots]) => {
      const anyPivot = pivots.find((p) => p.lineOfApprovalId === lineId);
      const lo = anyPivot?.lineOfApproval;
      const firstType = lo?.memoTypes?.[0];

      return {
        pivotId: anyPivot?.id ?? 0,
        lineOfApprovalId: lineId,
        lineName: lo?.name ?? null,
        level: anyPivot?.level ?? 0,
        businessUnitName: firstType?.businessUnit?.name ?? lo?.businessUnit?.name ?? null,
        departmentName: firstType?.department?.name ?? null,
        memoTypeName: firstType?.name ?? null,
        memoTypeAbbr: firstType?.abbreviation ?? null,
        slots,
      };
    });

    const lineIdsWithPivots = new Set(slotMap.keys());
    const linesWithoutPivots = allLines
      .filter((line) => !lineIdsWithPivots.has(line.id))
      .map((line) => {
        const firstType = line.memoTypes?.[0];
        return {
          pivotId: 0,
          lineOfApprovalId: line.id,
          lineName: line.name ?? null,
          level: 0,
          businessUnitName: firstType?.businessUnit?.name ?? line.businessUnit?.name ?? null,
          departmentName: firstType?.department?.name ?? null,
          memoTypeName: firstType?.name ?? null,
          memoTypeAbbr: firstType?.abbreviation ?? null,
          slots: [],
        };
      });

    return [...linesWithPivots, ...linesWithoutPivots];
  }

  /** GET /api/approver-lines/:lineId/memo-types */
  async getMemoTypesForLine(user: JwtPayload, lineId: number) {
    this.assertAdminOrDcc(user);

    return this.prisma.memoType.findMany({
      where: { approvalLineId: lineId },
      select: {
        id: true, name: true, abbreviation: true, description: true, isActive: true,
        businessUnit: { select: { id: true, name: true } },
        department: { select: { id: true, name: true } },
        createdAt: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  /** POST /api/approvers/bulk-update */
  async bulkUpdateApprover(user: JwtPayload, dto: BulkUpdateApproverDto) {
    this.assertAdminOrDcc(user);

    const {
      fromUserId, toUserId, action = 'replace',
      businessUnitId, memoTypeId,
      affectTemplates = true, affectRunningMemos = true, affectCcGroups = false,
      dryRun = false, lineOfApprovalIds,
    } = dto;

    const fromId = Number(fromUserId);
    if (!Number.isFinite(fromId)) throw new BadRequestException('Invalid fromUserId');
    if (!['replace', 'flexible', 'remove'].includes(action)) {
      throw new BadRequestException("Invalid action. Must be 'replace', 'flexible', or 'remove'");
    }
    if (action === 'replace') {
      const toId = Number(toUserId);
      if (!Number.isFinite(toId) || fromId === toId) {
        throw new BadRequestException('Invalid toUserId for replace action');
      }
    }

    const fromUser = await this.prisma.user.findUnique({ where: { id: fromId }, select: { id: true, name: true } });
    if (!fromUser) throw new BadRequestException('From user not found');

    let toUser: { id: number; name: string } | null = null;
    if (action === 'replace') {
      toUser = await this.prisma.user.findUnique({ where: { id: Number(toUserId) }, select: { id: true, name: true } });
      if (!toUser) throw new BadRequestException('To user not found');
    }

    const lineScope: Prisma.LineOfApprovalWhereInput = {};
    if (businessUnitId != null) lineScope.businessUnitId = Number(businessUnitId);
    const memoTypeScope = memoTypeId != null ? { memoTypes: { some: { id: Number(memoTypeId) } } } : {};
    const lineIdsFilter = this.buildLineIdsFilter(lineOfApprovalIds);

    if (affectTemplates && action === 'replace') {
      await this.validateNoConflictSameLevel(fromId, Number(toUserId), lineIdsFilter, lineScope, memoTypeScope);
    }

    const result = { templatePivotsChanged: 0, templatePivotsDeletedAsDup: 0, memoApproversChanged: 0, ccMembersChanged: 0 };

    if (dryRun) {
      if (affectTemplates) {
        result.templatePivotsChanged = await this.prisma.lineOfApprovalUserPivot.count({
          where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter, lineOfApproval: { ...lineScope, ...memoTypeScope } },
        });
      }
      if (affectCcGroups && action === 'replace') {
        result.ccMembersChanged = await this.prisma.ccGroupMember.count({ where: { userId: fromId } });
      }
      return { dryRun: true, ...result, fromUser, toUser, action };
    }

    let affectedLineIds: number[] = [];

    await this.prisma.$transaction(async (tx) => {
      if (affectTemplates) {
        const pivots = await tx.lineOfApprovalUserPivot.findMany({
          where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter, lineOfApproval: { ...lineScope, ...memoTypeScope } },
          select: { id: true, lineOfApprovalId: true, level: true, isSigReq: true, roleDescription: true },
        });

        affectedLineIds = Array.from(new Set(pivots.map((p) => p.lineOfApprovalId).filter((id): id is number => id != null)));

        for (const p of pivots) {
          if (action === 'replace') {
            const dup = await tx.lineOfApprovalUserPivot.findFirst({
              where: { lineOfApprovalId: p.lineOfApprovalId, level: p.level, slotType: 'FIXED_USER', userId: Number(toUserId) },
              select: { id: true },
            });
            if (dup) {
              await tx.lineOfApprovalUserPivot.delete({ where: { id: p.id } });
              result.templatePivotsDeletedAsDup++;
            } else {
              await tx.lineOfApprovalUserPivot.update({ where: { id: p.id }, data: { userId: Number(toUserId) } });
              result.templatePivotsChanged++;
            }
          } else if (action === 'flexible') {
            await tx.lineOfApprovalUserPivot.update({ where: { id: p.id }, data: { userId: null, slotType: 'FLEXIBLE_SLOT' } });
            result.templatePivotsChanged++;
          } else if (action === 'remove') {
            await tx.lineOfApprovalUserPivot.delete({ where: { id: p.id } });
            result.templatePivotsChanged++;
          }
        }
      }

      if (affectCcGroups && action === 'replace') {
        const { count } = await tx.ccGroupMember.updateMany({ where: { userId: fromId }, data: { userId: Number(toUserId) } });
        result.ccMembersChanged += count;
      }
    });

    const lineNames = await this.fetchLineNames(affectedLineIds);
    let logAction = 'LOA_BULK_UPDATE';
    if (action === 'replace') logAction = 'LOA_REPLACE_APPROVER';
    else if (action === 'remove') logAction = 'LOA_REMOVE_APPROVER';
    else if (action === 'flexible') logAction = 'LOA_CHANGE_APPROVER_TO_FLEXIBLE';

    await this.adminLog.write(
      user.id, logAction, 'LOA', fromId,
      action === 'replace' ? `${(fromUser as {name: string}).name} -> ${(toUser as {name: string} | null)?.name}` : (fromUser as {name: string}).name,
      { action, fromUserId: fromId, toUserId: action === 'replace' ? Number(toUserId) : undefined, affectedLines: lineNames },
    );

    return { ok: true, ...result, fromUser, toUser, action };
  }

  /** POST /api/approvers/replace */
  async replaceApprover(user: JwtPayload, dto: ReplaceApproverDto) {
    this.assertAdminOrDcc(user);

    const fromId = Number(dto.fromUserId);
    const toId = Number(dto.toUserId);
    if (!Number.isFinite(fromId) || !Number.isFinite(toId) || fromId === toId) {
      throw new BadRequestException('Invalid fromUserId / toUserId');
    }

    const [fromUser, toUser] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: fromId }, select: { id: true, name: true } }),
      this.prisma.user.findUnique({ where: { id: toId }, select: { id: true, name: true } }),
    ]);
    if (!fromUser || !toUser) throw new BadRequestException('User not found');

    const lineScope: Prisma.LineOfApprovalWhereInput = {};
    if (dto.businessUnitId != null) lineScope.businessUnitId = Number(dto.businessUnitId);
    const memoTypeScope = dto.memoTypeId != null ? { memoTypes: { some: { id: Number(dto.memoTypeId) } } } : {};
    const lineIdsFilter = this.buildLineIdsFilter(dto.lineOfApprovalIds);

    if (dto.affectTemplates !== false) {
      const targetPivots = await this.prisma.lineOfApprovalUserPivot.findMany({
        where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter, lineOfApproval: { ...lineScope, ...memoTypeScope } },
        select: { lineOfApprovalId: true },
      });

      const targetLineIds = Array.from(new Set(targetPivots.map((p) => p.lineOfApprovalId).filter((id): id is number => id != null)));
      if (targetLineIds.length === 0) {
        throw new BadRequestException('No approval lines to update for the selected approver under the current filters.');
      }

      const conflictPivots = await this.prisma.lineOfApprovalUserPivot.findMany({
        where: { slotType: 'FIXED_USER', userId: toId, lineOfApprovalId: { in: targetLineIds } },
        include: { lineOfApproval: { select: { id: true, name: true } } },
      });

      if (conflictPivots.length > 0) {
        const conflictDetails = conflictPivots
          .map((c) => `${c.lineOfApproval?.name ?? `Line ID ${c.lineOfApprovalId}`} (L${(c.level ?? 0) + 1})`)
          .join(', ');
        throw new BadRequestException({
          message: `Cannot replace approver because the new approver is already assigned in these lines/levels: ${conflictDetails}. If you want to move positions, please edit them directly in the Line management page.`,
          conflictLines: conflictPivots.map((c) => ({ lineOfApprovalId: c.lineOfApprovalId, lineName: c.lineOfApproval?.name ?? null, level: c.level })),
        });
      }
    }

    const result = { templatePivotsChanged: 0, templatePivotsDeletedAsDup: 0, memoApproversChanged: 0, ccMembersChanged: 0 };

    if (dto.dryRun) {
      if (dto.affectTemplates !== false) {
        result.templatePivotsChanged = await this.prisma.lineOfApprovalUserPivot.count({
          where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter, lineOfApproval: { ...lineScope, ...memoTypeScope } },
        });
      }
      if (dto.affectCcGroups) {
        result.ccMembersChanged = await this.prisma.ccGroupMember.count({ where: { userId: fromId } });
      }
      return { dryRun: true, ...result, fromUser, toUser };
    }

    let affectedLineIds: number[] = [];
    await this.prisma.$transaction(async (tx) => {
      if (dto.affectTemplates !== false) {
        const pivots = await tx.lineOfApprovalUserPivot.findMany({
          where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter, lineOfApproval: { ...lineScope, ...memoTypeScope } },
          select: { id: true, lineOfApprovalId: true, level: true, isSigReq: true },
        });
        affectedLineIds = Array.from(new Set(pivots.map((p) => p.lineOfApprovalId).filter((id): id is number => id != null)));

        for (const p of pivots) {
          const dup = await tx.lineOfApprovalUserPivot.findFirst({
            where: { lineOfApprovalId: p.lineOfApprovalId, level: p.level, slotType: 'FIXED_USER', userId: toId },
            select: { id: true },
          });
          if (dup) {
            await tx.lineOfApprovalUserPivot.delete({ where: { id: p.id } });
            result.templatePivotsDeletedAsDup++;
          } else {
            await tx.lineOfApprovalUserPivot.update({ where: { id: p.id }, data: { userId: toId } });
            result.templatePivotsChanged++;
          }
        }
      }
      if (dto.affectCcGroups) {
        const { count } = await tx.ccGroupMember.updateMany({ where: { userId: fromId }, data: { userId: toId } });
        result.ccMembersChanged += count;
      }
    });

    const lineNames = await this.fetchLineNames(affectedLineIds);
    await this.adminLog.write(user.id, 'LOA_REPLACE_APPROVER', 'LOA', fromId, `${fromUser.name} -> ${toUser.name}`, { fromUserId: fromId, toUserId: toId, affectedLines: lineNames });

    return { ok: true, ...result, fromUser, toUser };
  }

  /** POST /api/approvers/bulk-signature-update */
  async bulkUpdateSignature(user: JwtPayload, dto: BulkUpdateApproverDto) {
    this.assertAdminOrDcc(user);

    const { fromUserId, action = 'enable', businessUnitId, memoTypeId, affectTemplates = true, dryRun = false, lineOfApprovalIds } = dto;
    const fromId = Number(fromUserId);
    if (!Number.isFinite(fromId)) throw new BadRequestException('Invalid fromUserId');
    if (!['enable', 'disable'].includes(action)) throw new BadRequestException("Invalid action. Must be 'enable' or 'disable'");

    const fromUser = await this.prisma.user.findUnique({ where: { id: fromId }, select: { id: true, name: true } });
    if (!fromUser) throw new BadRequestException('User not found');

    const lineScope: Prisma.LineOfApprovalWhereInput = {};
    if (businessUnitId != null) lineScope.businessUnitId = Number(businessUnitId);
    const memoTypeScope = memoTypeId != null ? { memoTypes: { some: { id: Number(memoTypeId) } } } : {};
    const lineIdsFilter = this.buildLineIdsFilter(lineOfApprovalIds);

    const result = { templatePivotsChanged: 0 };

    if (dryRun) {
      if (affectTemplates) {
        result.templatePivotsChanged = await this.prisma.lineOfApprovalUserPivot.count({
          where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter, lineOfApproval: { ...lineScope, ...memoTypeScope } },
        });
      }
      return { dryRun: true, ...result, fromUser, action };
    }

    let affectedLineIds: number[] = [];
    await this.prisma.$transaction(async (tx) => {
      if (affectTemplates) {
        const pivots = await tx.lineOfApprovalUserPivot.findMany({
          where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter, lineOfApproval: { ...lineScope, ...memoTypeScope } },
          select: { id: true, lineOfApprovalId: true, isSigReq: true },
        });
        affectedLineIds = Array.from(new Set(pivots.map((p) => p.lineOfApprovalId).filter((id): id is number => id != null)));
        const targetSig = action === 'enable';
        for (const p of pivots) {
          if (p.isSigReq !== targetSig) {
            await tx.lineOfApprovalUserPivot.update({ where: { id: p.id }, data: { isSigReq: targetSig } });
            result.templatePivotsChanged++;
          }
        }
      }
    });

    const lineNames = await this.fetchLineNames(affectedLineIds);
    await this.adminLog.write(user.id, 'LOA_UPDATE_SIGNATURE', 'LOA', fromId, `${fromUser.name} (${action})`, { fromUserId: fromId, action, affectedLines: lineNames });

    return { ok: true, ...result, fromUser, action };
  }

  /** POST /api/approvers/bulk-reorder */
  async bulkReorderApprover(user: JwtPayload, dto: BulkUpdateApproverDto) {
    this.assertAdminOrDcc(user);

    const { fromUserId, action, affectTemplates = true, dryRun = false, lineOfApprovalIds } = dto;
    const fromId = Number(fromUserId);
    if (!Number.isFinite(fromId)) throw new BadRequestException('Invalid fromUserId');
    if (!['moveToFirst', 'plusOne', 'minusOne', 'moveToLast'].includes(action ?? '')) {
      throw new BadRequestException("Invalid action. Must be 'moveToFirst', 'plusOne', 'minusOne', or 'moveToLast'");
    }

    const fromUser = await this.prisma.user.findUnique({ where: { id: fromId }, select: { id: true, name: true } });
    if (!fromUser) throw new BadRequestException('User not found');

    const lineIdsFilter = this.buildLineIdsFilter(lineOfApprovalIds);
    const result = { templatePivotsChanged: 0, slotsSkipped: 0 };

    if (dryRun) {
      if (affectTemplates) {
        result.templatePivotsChanged = await this.prisma.lineOfApprovalUserPivot.count({ where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter } });
      }
      return { dryRun: true, ...result, fromUser, action };
    }

    let affectedLineIds: number[] = [];
    await this.prisma.$transaction(async (tx) => {
      if (affectTemplates) {
        const pivots = await tx.lineOfApprovalUserPivot.findMany({
          where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter },
          select: { id: true, lineOfApprovalId: true, level: true },
        });
        affectedLineIds = Array.from(new Set(pivots.map((p) => p.lineOfApprovalId).filter((id): id is number => id != null)));

        const pivotsByLine = new Map<number, typeof pivots>();
        for (const p of pivots) {
          if (p.lineOfApprovalId == null) continue;
          const arr = pivotsByLine.get(p.lineOfApprovalId) ?? [];
          arr.push(p);
          if (!pivotsByLine.has(p.lineOfApprovalId)) pivotsByLine.set(p.lineOfApprovalId, arr);
        }

        for (const [lineId, linePivots] of pivotsByLine) {
          const allSlotsInLine = await tx.lineOfApprovalUserPivot.findMany({ where: { lineOfApprovalId: lineId }, select: { level: true } });
          if (allSlotsInLine.length === 0) continue;

          const levels = allSlotsInLine.map((s) => s.level);
          const minLevel = Math.min(...levels);
          const maxLevel = Math.max(...levels);

          for (const pivot of linePivots) {
            const currentLevel = pivot.level;
            let newLevel: number;
            switch (action) {
              case 'moveToFirst': newLevel = minLevel - 1; break;
              case 'plusOne': newLevel = currentLevel + 1; break;
              case 'minusOne': newLevel = currentLevel - 1; break;
              case 'moveToLast': newLevel = maxLevel + 1; break;
              default: newLevel = currentLevel;
            }
            if (newLevel === currentLevel) { result.slotsSkipped++; continue; }
            await tx.lineOfApprovalUserPivot.update({ where: { id: pivot.id }, data: { level: newLevel } });
            result.templatePivotsChanged++;
          }
        }
      }
    });

    const lineNames = await this.fetchLineNames(affectedLineIds);
    await this.adminLog.write(user.id, 'LOA_UPDATE_LEVEL', 'LOA', fromId, `${fromUser.name} (${action})`, { fromUserId: fromId, action, affectedLines: lineNames });

    return { ok: true, ...result, fromUser, action };
  }

  /** PUT /api/approver-lines/:id and POST /api/approval-lines/:id/update-approvers */
  async updateApproversForLine(user: JwtPayload, lineId: number, dto: UpdateApproversForLineDto) {
    this.assertAdminOrDcc(user);

    const { lineName, slots } = dto;
    if (!Array.isArray(slots)) throw new BadRequestException('slots must be an array');

    // Fetch old pivots for logging
    const oldPivots = await this.prisma.lineOfApprovalUserPivot.findMany({
      where: { lineOfApprovalId: lineId },
      include: { user: { select: { id: true, name: true, lastname: true, email: true } } },
      orderBy: [{ level: 'asc' }, { id: 'asc' }],
    });

    const oldLevelGroups = new Map<number, typeof oldPivots>();
    for (const p of oldPivots) {
      const list = oldLevelGroups.get(p.level) ?? [];
      list.push(p);
      if (!oldLevelGroups.has(p.level)) oldLevelGroups.set(p.level, list);
    }

    const oldLevelDetails = Array.from(oldLevelGroups.entries())
      .sort(([a], [b]) => a - b)
      .map(([lvl, lvlSlots]) => {
        const approvers = lvlSlots.map((s) => {
          const sigSuffix = s.isSigReq ? ' (SigReq)' : ' (NoSigReq)';
          if (s.slotType === 'FIXED_USER' && s.user) {
            const name = `${s.user.name} ${s.user.lastname ?? ''}`.trim() || s.user.email;
            return `${name}${sigSuffix}`;
          }
          return `${s.slotType}${sigSuffix}`;
        }).join(', ');
        return `Level ${lvl + 1}: ${approvers || 'No Approvers'}`;
      });

    const normalized: Prisma.LineOfApprovalUserPivotCreateManyInput[] = [];
    const approvalRequirementByLevel = new Map<number, ApprovalRequirement>();
    const placeholderAtLevel = new Map<number, ApprovalSlotType>();
    const fixedAtLevel = new Set<number>();
    const seen = new Set<string>();

    for (const s of slots) {
      const level = Number(s?.level);
      if (!Number.isFinite(level) || level < 0) continue;

      const userId = s?.userId == null ? null : Number(s.userId);
      const rawType = s?.slotType ?? null;
      const isSigReq = !!s?.isSigReq;
      const rawApprovalReq = s?.approvalRequirement;
      const approvalRequirement: ApprovalRequirement = rawApprovalReq === 'ANY' ? 'ANY' : 'ALL';

      const existingReq = approvalRequirementByLevel.get(level);
      if (existingReq && existingReq !== approvalRequirement) {
        throw new BadRequestException(`Level ${level}: All slots at the same level must have the same approval requirement`);
      }
      approvalRequirementByLevel.set(level, approvalRequirement);

      let slotType: ApprovalSlotType | null = null;
      if (isApprovalSlotType(rawType)) slotType = rawType;
      else if (userId != null) slotType = 'FIXED_USER';
      else continue;

      if (slotType !== 'FIXED_USER') {
        if (userId != null) throw new BadRequestException(`Level ${level}: ${slotType} must not have userId`);
        if (fixedAtLevel.has(level)) throw new BadRequestException(`Level ${level} already has FIXED_USER; cannot add ${slotType}`);
        const existing = placeholderAtLevel.get(level);
        if (existing && existing !== slotType) throw new BadRequestException(`Level ${level} has multiple placeholder slots (${existing} and ${slotType})`);
        placeholderAtLevel.set(level, slotType);
        const key = `${slotType}|${level}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const roleDescription = typeof s?.roleDescription === 'string' ? s.roleDescription.trim() : null;
        normalized.push({ lineOfApprovalId: lineId, level, userId: null, slotType, isSigReq, roleDescription, approvalRequirement });
        continue;
      }

      if (userId == null) continue;
      if (placeholderAtLevel.has(level)) throw new BadRequestException(`Level ${level} is ${placeholderAtLevel.get(level)}; cannot add FIXED_USER`);
      fixedAtLevel.add(level);
      const key = `${slotType}|${level}|${userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const roleDescription = typeof s?.roleDescription === 'string' ? s.roleDescription.trim() : null;
      normalized.push({ lineOfApprovalId: lineId, level, userId, slotType: 'FIXED_USER', isSigReq, roleDescription, approvalRequirement });
    }

    const existingLine = await this.prisma.lineOfApproval.findUnique({ where: { id: lineId }, select: { name: true } });

    await this.prisma.$transaction(async (tx) => {
      if (typeof lineName === 'string' && lineName.trim()) {
        await tx.lineOfApproval.update({ where: { id: lineId }, data: { name: lineName.trim() } });
      }
      await tx.lineOfApprovalUserPivot.deleteMany({ where: { lineOfApprovalId: lineId } });
      if (normalized.length > 0) {
        await tx.lineOfApprovalUserPivot.createMany({ data: normalized });
      }
    });

    const userIds = normalized.map((s) => s.userId).filter((id): id is number => id !== null);
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, lastname: true, email: true } });
    const userMap = new Map(users.map((u) => [u.id, u]));

    const levelDetails = Array.from(approvalRequirementByLevel.entries())
      .sort(([a], [b]) => a - b)
      .map(([lvl]) => {
        const approversAtLevel = normalized
          .filter((s) => s.level === lvl && s.userId !== null)
          .map((s) => {
            const u = userMap.get(s.userId!);
            const sigSuffix = s.isSigReq ? ' (SigReq)' : ' (NoSigReq)';
            const name = u ? `${u.name} ${u.lastname ?? ''}`.trim() || u.email : `User ID ${s.userId}`;
            return `${name}${sigSuffix}`;
          });
        const placeholders = normalized
          .filter((s) => s.level === lvl && s.slotType !== 'FIXED_USER')
          .map((s) => `${s.slotType}${s.isSigReq ? ' (SigReq)' : ' (NoSigReq)'}`);
        return `Level ${lvl + 1}: ${[...approversAtLevel, ...placeholders].join(', ') || 'No Approvers'}`;
      });

    const logPayload: Record<string, unknown> = {};
    const oldStr = oldLevelDetails.join('|');
    const newStr = levelDetails.join('|');
    if (oldStr !== newStr) { logPayload['old_levels'] = oldLevelDetails; logPayload['levels'] = levelDetails; }
    const newName = typeof lineName === 'string' ? lineName.trim() : existingLine?.name;
    if (existingLine?.name !== newName) { logPayload['oldName'] = existingLine?.name; logPayload['newName'] = newName; }

    if (Object.keys(logPayload).length > 0) {
      await this.adminLog.write(user.id, 'LOA_UPDATE_LEVEL', 'LOA', lineId, newName ?? `Line ${lineId}`, logPayload as import("@prisma/client").Prisma.InputJsonValue);
    }

    return { ok: true, saved: normalized.length };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private buildLineIdsFilter(lineOfApprovalIds?: number[]): Prisma.LineOfApprovalUserPivotWhereInput {
    return Array.isArray(lineOfApprovalIds) && lineOfApprovalIds.length > 0
      ? { lineOfApprovalId: { in: lineOfApprovalIds.map((id) => Number(id)) } }
      : {};
  }

  private buildSlotMap(
    slots: Array<{
      lineOfApprovalId: number | null;
      level: number;
      userId: number | null;
      slotType: ApprovalSlotType | null;
      isSigReq: boolean | null;
      roleDescription: string | null;
      approvalRequirement: ApprovalRequirement;
      user?: { id: number; name: string; lastname: string | null; nickname: string | null } | null;
    }>,
    targetUserId: number | null,
  ) {
    const slotMap = new Map<number, Array<{
      level: number; userId: number | null; userName: string | null;
      isTarget: boolean; slotType: ApprovalSlotType | null;
      isSigReq: boolean; roleDescription: string | null;
      approvalRequirement: ApprovalRequirement;
    }>>();

    for (const s of slots) {
      if (s.lineOfApprovalId == null) continue;
      const fullName = [s.user?.name, s.user?.lastname].filter(Boolean).join(' ');
      const displayName = s.user?.nickname && fullName
        ? `${fullName} (${s.user.nickname})`
        : fullName || s.user?.nickname || null;

      const dto = {
        level: s.level,
        userId: s.userId,
        userName: displayName,
        isTarget: targetUserId !== null && s.userId === targetUserId && s.slotType === 'FIXED_USER',
        slotType: s.slotType ?? null,
        isSigReq: s.isSigReq ?? false,
        roleDescription: s.roleDescription ?? null,
        approvalRequirement: s.approvalRequirement ?? 'ALL',
      };

      const arr = slotMap.get(s.lineOfApprovalId) ?? [];
      arr.push(dto);
      if (!slotMap.has(s.lineOfApprovalId)) slotMap.set(s.lineOfApprovalId, arr);
    }

    return slotMap;
  }

  private async fetchLineNames(lineIds: number[]): Promise<string[]> {
    if (lineIds.length === 0) return [];
    const lines = await this.prisma.lineOfApproval.findMany({
      where: { id: { in: lineIds } },
      select: { name: true },
      orderBy: { id: 'asc' },
    });
    return lines.map((l) => l.name);
  }

  private async validateNoConflictSameLevel(
    fromId: number,
    toId: number,
    lineIdsFilter: Prisma.LineOfApprovalUserPivotWhereInput,
    lineScope: Prisma.LineOfApprovalWhereInput,
    memoTypeScope: Prisma.LineOfApprovalWhereInput,
  ) {
    const targetPivots = await this.prisma.lineOfApprovalUserPivot.findMany({
      where: { slotType: 'FIXED_USER', userId: fromId, ...lineIdsFilter, lineOfApproval: { ...lineScope, ...memoTypeScope } },
      select: { lineOfApprovalId: true, level: true },
    });

    const targetLineIds = Array.from(new Set(targetPivots.map((p) => p.lineOfApprovalId).filter((id): id is number => id != null)));
    if (targetLineIds.length === 0) throw new BadRequestException('No approval lines to update for the selected approver under the current filters.');

    const targetLineLevels = new Set(targetPivots.map((p) => `${p.lineOfApprovalId}-${p.level}`));
    const conflictPivots = await this.prisma.lineOfApprovalUserPivot.findMany({
      where: { slotType: 'FIXED_USER', userId: toId, lineOfApprovalId: { in: targetLineIds } },
      include: { lineOfApproval: { select: { id: true, name: true } } },
    });

    const actualConflicts = conflictPivots.filter((c) => targetLineLevels.has(`${c.lineOfApprovalId}-${c.level}`));
    if (actualConflicts.length > 0) {
      const conflictDetails = actualConflicts
        .map((c) => `${c.lineOfApproval?.name ?? `Line ID ${c.lineOfApprovalId}`} (L${(c.level ?? 0) + 1})`)
        .join(', ');
      throw new BadRequestException({
        message: `Cannot replace approver because the new approver is already assigned at the same level in these lines: ${conflictDetails}. If you want to move positions, please edit them directly in the Line management page.`,
        conflictLines: actualConflicts.map((c) => ({ lineOfApprovalId: c.lineOfApprovalId, lineName: c.lineOfApproval?.name ?? null, level: c.level })),
      });
    }
  }
}
