import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload } from '../../common/guards/jwt.guard';
import { ReplaceCcDto } from './dto/replace-cc.dto';

/**
 * MemoCcService
 *
 * Pure business logic — no HTTP, no req/res.
 * Mirrors Express memocc.controller.ts parity 100%.
 *
 * IMPORTANT: memocc routes involve /api/memos/:id/cc — these paths are still
 * sent to Nest (gateway excludes them). The memo core (create/submit/approve)
 * still runs on Express. This service ONLY manages CC recipients per memo.
 * No imports from memo Express services.
 */
@Injectable()
export class MemoCcService {
  constructor(private readonly prisma: PrismaService) {}

  private isAdmin(user: JwtPayload): boolean {
    const r = (user.role ?? '').toString().toUpperCase();
    const roles: string[] = (user as unknown as { roles?: string[] }).roles ?? [];
    return r === 'ADMIN' || roles.map((x) => x?.toUpperCase?.()).includes('ADMIN');
  }

  private async ensureMemoExists(memoId: number) {
    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { id: true, userId: true },
    });
    if (!memo) throw new NotFoundException('Memo not found');
    return memo;
  }

  private canManageCc(user: JwtPayload, memoOwnerId: number): boolean {
    return this.isAdmin(user) || user.id === memoOwnerId;
  }

  /**
   * GET /api/memos/:id/cc
   */
  async listCc(memoId: number) {
    await this.ensureMemoExists(memoId);

    const ccUsers = await this.prisma.memoCc.findMany({
      where: { memoId },
      orderBy: { createdAt: 'asc' },
      include: {
        user: {
          select: {
            id: true, name: true, lastname: true, nickname: true,
            email: true, profileImagePath: true,
          },
        },
      },
    });

    const users = ccUsers.map((r) => ({
      id: r.user.id,
      name: r.user.name,
      lastname: r.user.lastname ?? null,
      nickname: r.user.nickname ?? null,
      email: r.user.email,
      profileImagePath: r.user.profileImagePath ?? null,
      addedAt: r.createdAt,
    }));

    // Maintain backward compat: groups/groupIds are empty arrays
    return { users, groups: [], groupIds: [] };
  }

  /**
   * PUT /api/memos/:id/cc  { userIds, groupIds }
   */
  async replaceCc(user: JwtPayload, memoId: number, dto: ReplaceCcDto) {
    const rawUserIds = dto.userIds.map(Number);
    const rawGroupIds = dto.groupIds.map(Number);

    const memo = await this.ensureMemoExists(memoId);
    if (!this.canManageCc(user, memo.userId)) throw new ForbiddenException('Forbidden');

    // Fetch approvers to exclude from CC
    const actions = await this.prisma.memoApproverAction.findMany({
      where: { memoId },
      select: { assignedUserId: true, loaUserId: true },
    });

    const missingLoaIds = actions.filter((a) => a.assignedUserId == null).map((a) => a.loaUserId);
    let fallbackPivotUsers: number[] = [];
    if (missingLoaIds.length) {
      const pivots = await this.prisma.lineOfApprovalUserPivot.findMany({
        where: { id: { in: missingLoaIds } },
        select: { userId: true },
      });
      fallbackPivotUsers = pivots.map((p) => p.userId).filter((n): n is number => Number.isFinite(n));
    }

    const approverSet = new Set<number>([
      ...actions.map((a) => a.assignedUserId).filter((n): n is number => Number.isFinite(n as number)),
      ...fallbackPivotUsers,
    ]);

    let groupMemberIds: number[] = [];
    if (rawGroupIds.length) {
      const members = await this.prisma.ccGroupMember.findMany({
        where: { groupId: { in: rawGroupIds } },
        select: { userId: true },
      });
      groupMemberIds = members.map((m) => m.userId);
    }

    const newUserSet = new Set<number>(
      [...rawUserIds, ...groupMemberIds].filter(
        (u) => Number.isFinite(u) && u > 0 && u !== memo.userId && !approverSet.has(u),
      ),
    );

    const existingUsers = await this.prisma.memoCc.findMany({
      where: { memoId },
      select: { userId: true },
    });
    const oldUserSet = new Set(existingUsers.map((e) => e.userId));

    const usersToAdd = [...newUserSet].filter((u) => !oldUserSet.has(u));
    const usersToDel = [...oldUserSet].filter((u) => !newUserSet.has(u));

    await this.prisma.$transaction(async (tx) => {
      if (usersToDel.length) {
        await tx.memoCc.deleteMany({ where: { memoId, userId: { in: usersToDel } } });
      }
      if (usersToAdd.length) {
        await tx.memoCc.createMany({
          data: usersToAdd.map((u) => ({ memoId, userId: u })),
          skipDuplicates: true,
        });
      }
    });

    return {
      memoId,
      added: { users: usersToAdd },
      removed: { users: usersToDel },
      final: { userIds: [...newUserSet] },
    };
  }

  /**
   * POST /api/memos/:id/cc/:userId
   */
  async addCcOne(user: JwtPayload, memoId: number, targetUserId: number) {
    const memo = await this.ensureMemoExists(memoId);
    if (!this.canManageCc(user, memo.userId)) throw new ForbiddenException('Forbidden');

    if (targetUserId === memo.userId) throw new BadRequestException('Owner cannot be CC');

    const isApprover = await this.prisma.memoApproverAction.findFirst({
      where: { memoId, assignedUserId: targetUserId },
      select: { id: true },
    });
    if (isApprover) throw new BadRequestException('Approver cannot be CC');

    try {
      await this.prisma.memoCc.create({ data: { memoId, userId: targetUserId } });
      return { ok: true };
    } catch (e: unknown) {
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictException('Already CC');
      }
      throw e;
    }
  }

  /**
   * DELETE /api/memos/:id/cc/:userId
   */
  async removeCcOne(user: JwtPayload, memoId: number, targetUserId: number) {
    const memo = await this.ensureMemoExists(memoId);
    if (!this.canManageCc(user, memo.userId)) throw new ForbiddenException('Forbidden');

    await this.prisma.memoCc.delete({ where: { memoId_userId: { memoId, userId: targetUserId } } });
    return { ok: true };
  }

  /**
   * GET /api/memos/cc/me
   */
  async listMemosCcToMe(user: JwtPayload) {
    const memos = await this.prisma.masterMemo.findMany({
      where: { ccRecipients: { some: { userId: user.id } } },
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, name: true, lastname: true, nickname: true } },
        memoType: { select: { id: true, name: true } },
        statuses: {
          include: { status: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    return memos
      .filter((m) => (m.statuses[0]?.status?.name ?? '') !== 'Draft')
      .map((m) => ({
        id: m.id,
        subject: m.subject,
        memonumber: m.memonumber,
        owner: m.user,
        type: m.memoType?.name,
        latestStatus: m.statuses[0]?.status?.name ?? 'Processing',
        latestStatusAt: m.statuses[0]?.createdAt ?? null,
      }));
  }
}
