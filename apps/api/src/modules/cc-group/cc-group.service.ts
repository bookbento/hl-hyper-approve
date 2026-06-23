import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { CreateGroupDto } from './dto/create-group.dto';
import { RenameGroupDto } from './dto/rename-group.dto';
import { ReplaceMembersDto } from './dto/replace-members.dto';
import { BulkUpdateDto } from './dto/bulk-update.dto';
import { JwtPayload } from '../../common/guards/jwt.guard';
import { Prisma } from '@prisma/client';

/** User select shape used across queries */
const USER_SELECT = {
  id: true,
  name: true,
  lastname: true,
  nickname: true,
  email: true,
  profileImagePath: true,
  department: { select: { id: true, name: true } },
  businessUnit: { select: { id: true, name: true } },
} as const;

/**
 * Mirrors isAdminOrDcc from Express ccGroup.controller.ts
 */
function isAdminOrDcc(user: JwtPayload): boolean {
  const role = (user.role ?? '').toUpperCase();
  return role === 'ADMIN' || role === 'DCC';
}

/**
 * Pure business logic — no HTTP, no req/res.
 * Throws Nest exceptions; controller maps them to HTTP responses.
 *
 * Behavior parity with Express ccGroup.controller.ts.
 */
@Injectable()
export class CcGroupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly adminLog: AdminLogService,
  ) {}

  private async assertOwnerOrAdmin(user: JwtPayload, groupId: number): Promise<void> {
    const g = await this.prisma.ccGroup.findUnique({
      where: { id: groupId },
      select: { ownerId: true },
    });
    if (!g) throw new NotFoundException('Group not found');
    if (!isAdminOrDcc(user) && g.ownerId !== user.id) {
      throw new ForbiddenException();
    }
  }

  async listMyGroups(user: JwtPayload) {
    const where: Prisma.CcGroupWhereInput = isAdminOrDcc(user)
      ? {}
      : { ownerId: user.id };

    const rows = await this.prisma.ccGroup.findMany({
      where,
      orderBy: { updatedAt: 'desc' },
      include: {
        members: {
          include: { user: { select: USER_SELECT } },
        },
      },
    });

    return rows.map((g) => ({
      id: g.id,
      name: g.name,
      members: g.members.map((m) => ({
        id: m.user.id,
        userId: m.userId,
        name: m.user.name,
        lastname: m.user.lastname,
        nickname: m.user.nickname,
        email: m.user.email,
        profileImagePath: m.user.profileImagePath,
        department: m.user.department,
        businessUnit: m.user.businessUnit,
      })),
    }));
  }

  async createGroup(dto: CreateGroupDto, user: JwtPayload) {
    const ownerId = user.id;
    const name = dto.name.trim();
    const memberIds = Array.isArray(dto.memberIds) ? dto.memberIds.map(Number) : [];

    try {
      const group = await this.prisma.ccGroup.create({
        data: {
          name,
          ownerId,
          members: memberIds.length
            ? {
                createMany: {
                  data: [...new Set(memberIds)].map((uid) => ({ userId: uid })),
                },
              }
            : undefined,
        },
        include: { members: true },
      });

      let memberNames: string[] = [];
      if (memberIds.length) {
        const users = await this.prisma.user.findMany({
          where: { id: { in: [...new Set(memberIds)] } },
          select: { id: true, name: true, lastname: true, email: true },
        });
        memberNames = users.map((u) => `${u.name} ${u.lastname ?? ''}`.trim() || u.email);
      }

      await this.adminLog.write(
        ownerId,
        'CC_GROUP_CREATE',
        'CC_GROUP',
        group.id,
        group.name,
        { members: memberNames } as Prisma.InputJsonValue,
      );

      return { id: group.id, name: group.name, memberCount: group.members.length };
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('You already have a group with this name');
      }
      throw error;
    }
  }

  async getGroup(user: JwtPayload, groupId: number) {
    await this.assertOwnerOrAdmin(user, groupId);

    const g = await this.prisma.ccGroup.findUnique({
      where: { id: groupId },
      include: {
        members: {
          include: { user: { select: USER_SELECT } },
        },
      },
    });
    if (!g) throw new NotFoundException('Group not found');

    return {
      id: g.id,
      name: g.name,
      members: g.members.map((m) => ({
        id: m.user.id,
        userId: m.userId,
        name: m.user.name,
        lastname: m.user.lastname,
        nickname: m.user.nickname,
        email: m.user.email,
        profileImagePath: m.user.profileImagePath,
        department: m.user.department,
        businessUnit: m.user.businessUnit,
      })),
    };
  }

  async renameGroup(user: JwtPayload, groupId: number, dto: RenameGroupDto) {
    await this.assertOwnerOrAdmin(user, groupId);
    const name = dto.name.trim();

    try {
      const oldGroup = await this.prisma.ccGroup.findUnique({ where: { id: groupId } });
      const updated = await this.prisma.ccGroup.update({
        where: { id: groupId },
        data: { name },
      });

      if (oldGroup?.name !== updated.name) {
        await this.adminLog.write(
          user.id,
          'CC_RENAME',
          'CC_GROUP',
          updated.id,
          updated.name,
          { oldName: oldGroup?.name, newName: updated.name } as Prisma.InputJsonValue,
        );
      }

      return { id: updated.id, name: updated.name };
    } catch (error: unknown) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('You already have a group with this name');
      }
      throw error;
    }
  }

  async replaceGroupMembers(user: JwtPayload, groupId: number, dto: ReplaceMembersDto) {
    await this.assertOwnerOrAdmin(user, groupId);

    const userIds: number[] = Array.isArray(dto.userIds)
      ? dto.userIds.map(Number).filter((n) => isFinite(n) && n > 0)
      : [];
    const uniq = [...new Set(userIds)];

    // Validate user IDs exist
    const existingUsers = await this.prisma.user.findMany({
      where: { id: { in: uniq } },
      select: { id: true },
    });
    const validUserIds = existingUsers.map((u) => u.id);

    // Fetch current members for comparison
    const currentMembers = await this.prisma.ccGroupMember.findMany({
      where: { groupId },
      select: { userId: true },
    });
    const currentMemberIds = currentMembers.map((m) => m.userId);

    const oldSet = new Set(currentMemberIds);
    const newSet = new Set(validUserIds);
    let hasChanged = oldSet.size !== newSet.size;
    if (!hasChanged) {
      for (const uid of newSet) {
        if (!oldSet.has(uid)) { hasChanged = true; break; }
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.ccGroupMember.deleteMany({ where: { groupId } });
      if (validUserIds.length) {
        await tx.ccGroupMember.createMany({
          data: validUserIds.map((uid) => ({ groupId, userId: uid })),
          skipDuplicates: true,
        });
      }
    });

    const count = await this.prisma.ccGroupMember.count({ where: { groupId } });

    if (hasChanged) {
      const group = await this.prisma.ccGroup.findUnique({ where: { id: groupId }, select: { name: true } });
      const allIds = Array.from(new Set([...currentMemberIds, ...validUserIds]));
      const allUsers = await this.prisma.user.findMany({
        where: { id: { in: allIds } },
        select: { id: true, name: true, lastname: true, email: true },
      });
      const userMap = new Map(allUsers.map((u) => [u.id, u]));
      const getName = (uid: number) => {
        const u = userMap.get(uid);
        return u ? `${u.name} ${u.lastname ?? ''}`.trim() || u.email : `ID:${uid}`;
      };

      await this.adminLog.write(
        user.id,
        'CC_UPDATE_MEMBERS',
        'CC_GROUP',
        groupId,
        group?.name ?? '',
        {
          old_members: currentMemberIds.map(getName),
          new_members: validUserIds.map(getName),
          added: validUserIds.filter((x) => !oldSet.has(x)).map(getName),
          removed: currentMemberIds.filter((x) => !newSet.has(x)).map(getName),
        } as Prisma.InputJsonValue,
      );
    }

    return { id: groupId, memberCount: count };
  }

  async deleteGroup(user: JwtPayload, groupId: number) {
    await this.assertOwnerOrAdmin(user, groupId);

    const group = await this.prisma.ccGroup.findUnique({
      where: { id: groupId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, lastname: true, email: true } } },
        },
      },
    });

    await this.prisma.ccGroup.delete({ where: { id: groupId } });

    if (group) {
      const memberNames = group.members.map((m) => {
        const u = m.user;
        return `${u.name} ${u.lastname ?? ''}`.trim() || u.email;
      });
      await this.adminLog.write(
        user.id,
        'CC_GROUP_DELETE',
        'CC_GROUP',
        groupId,
        group.name,
        { members: memberNames } as Prisma.InputJsonValue,
      );
    }

    return { ok: true };
  }

  async searchCcGroups(query: { q?: string; limit?: number }) {
    const qRaw = (query.q ?? '').trim();
    const limitRaw = query.limit ?? 10;
    const limit = Math.max(1, Math.min(isFinite(limitRaw) ? limitRaw : 10, 50));

    const include = {
      _count: { select: { members: true } },
      members: {
        include: {
          user: {
            select: {
              id: true,
              name: true,
              lastname: true,
              nickname: true,
              email: true,
              profileImagePath: true,
              department: { select: { name: true } },
            },
          },
        },
      },
    } satisfies Prisma.CcGroupInclude;

    const where = qRaw.length > 0
      ? { name: { contains: qRaw, mode: 'insensitive' as const } }
      : {};

    const groups = await this.prisma.ccGroup.findMany({
      where,
      take: limit,
      orderBy: { name: 'asc' },
      include,
    });

    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g._count.members,
      memberIds: g.members.map((m) => m.userId),
      previewMembers: g.members.map((m) => ({
        id: m.user.id,
        name: m.user.name,
        lastname: m.user.lastname,
        nickname: m.user.nickname,
        email: m.user.email,
        profileImagePath: m.user.profileImagePath ?? null,
        team: null as string | null,
        department: m.user.department?.name ?? null,
      })),
    }));
  }

  async getGroupsBasicInfo(idsParam: string) {
    if (!idsParam) return [];

    const ids = idsParam
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => isFinite(n) && n > 0);

    if (ids.length === 0) return [];

    const groups = await this.prisma.ccGroup.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        name: true,
        members: { select: { userId: true } },
      },
    });

    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      memberIds: g.members.map((m) => m.userId),
    }));
  }

  async bulkUpdateMembers(user: JwtPayload, dto: BulkUpdateDto) {
    const { action, fromUserId, toUserId, groupIds } = dto;
    const actorId = user.id;

    if (action === 'replace' && !toUserId) {
      throw new BadRequestException('toUserId is required for replace action');
    }

    const groups = await this.prisma.ccGroup.findMany({
      where: {
        id: { in: groupIds.map(Number) },
        ...(!isAdminOrDcc(user) ? { ownerId: actorId } : {}),
      },
      select: { id: true, name: true },
    });

    const validGroupIds = groups.map((g) => g.id);
    if (validGroupIds.length === 0) {
      throw new ForbiddenException('No valid groups found or permission denied');
    }

    let changedCount = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const groupId of validGroupIds) {
        const deleteResult = await tx.ccGroupMember.deleteMany({
          where: { groupId, userId: Number(fromUserId) },
        });
        if (deleteResult.count > 0) {
          if (action === 'replace' && toUserId) {
            await tx.ccGroupMember.createMany({
              data: [{ groupId, userId: Number(toUserId) }],
              skipDuplicates: true,
            });
          }
          changedCount++;
        }
      }
    });

    if (changedCount > 0) {
      const userIds = action === 'replace'
        ? [Number(fromUserId), Number(toUserId)]
        : [Number(fromUserId)];
      const users = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, lastname: true, email: true },
      });
      const userMap = new Map(users.map((u) => [u.id, u]));
      const getName = (uid: number) => {
        const u = userMap.get(uid);
        return u ? `${u.name} ${u.lastname ?? ''}`.trim() || u.email : `ID:${uid}`;
      };

      await this.adminLog.write(
        actorId,
        action === 'replace' ? 'CC_GROUP_BULK_REPLACE' : 'CC_GROUP_BULK_REMOVE',
        'CC_GROUP',
        validGroupIds[0],
        `Bulk update on ${validGroupIds.length} groups`,
        {
          action,
          groupsAffected: validGroupIds.length,
          groupNames: groups.map((g) => g.name),
          fromUser: getName(Number(fromUserId)),
          ...(toUserId ? { toUser: getName(Number(toUserId)) } : {}),
        } as Prisma.InputJsonValue,
      );
    }

    return { ok: true, groupsUpdated: validGroupIds.length, changedCount };
  }
}
