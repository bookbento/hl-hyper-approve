/**
 * ApprovalLineService
 *
 * Mirrors backend/src/controllers/approval-line.controller.ts exactly.
 * Handles: lineOfApproval + lineOfApprovalUserPivot CRUD + memo helpers.
 *
 * Key coupling note:
 *   - getApprovalLineByMemo depends on getRecallType logic (ported inline here
 *     from backend/src/controllers/memoStatus.controller.ts — memo service still
 *     owns the canonical copy, this is a read-only helper).
 *   - Never remove getRecallType from Express — memo service still uses it.
 */

import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminLogService } from '../../common/admin-log/admin-log.service';
import { JwtPayload } from '../../common/guards/jwt.guard';
import { ApprovalSlotType, ApprovalRequirement, Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Types mirrored from Express
// ---------------------------------------------------------------------------

type ApprovalUserRow = {
  level: number;
  isSigReq: boolean;
  user: { id: number; name: string };
};

interface LevelPayload {
  users: Array<{
    id?: number | null;
    isSigReq?: boolean;
    slotType?: string;
    roleDescription?: string | null;
    approvalRequirement?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers (mirrored from Express approval-line.controller.ts)
// ---------------------------------------------------------------------------

function filterValidUsers(
  rows: Array<{
    level: number;
    isSigReq: boolean;
    user: { id: number; name: string } | null;
  }>,
): ApprovalUserRow[] {
  return rows.filter((row): row is ApprovalUserRow => row.user !== null);
}

function formatLevels(rows: ApprovalUserRow[]) {
  const grouped: Record<
    number,
    { role: string; users: { id: number; name: string; isSigReq: boolean }[] }
  > = {};
  rows.forEach((p) => {
    if (!grouped[p.level]) {
      grouped[p.level] = { role: `Level ${p.level + 1}`, users: [] };
    }
    grouped[p.level].users.push({
      id: p.user.id,
      name: p.user.name,
      isSigReq: p.isSigReq,
    });
  });
  return Object.keys(grouped)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
    .map((lvl) => grouped[lvl]);
}

/** Ported from memoStatus.controller.ts (read-only helper, do not delete Express copy) */
async function getRecallType(
  prisma: PrismaService,
  memoId: number,
): Promise<'preserve' | 'clear' | 'none'> {
  const last = await prisma.memoHistory.findFirst({
    where: { memoId, statusId: 6 },
    orderBy: { timestamp: 'desc' },
    select: { action: true },
  });
  if (!last) return 'none';
  return (last.action ?? '').includes('(preserve)') ? 'preserve' : 'clear';
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ApprovalLineService {
  private readonly logger = new Logger(ApprovalLineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adminLog: AdminLogService,
  ) {}

  // ── GET /api/teams ──────────────────────────────────────────────────────────

  async getAllTeams() {
    return this.prisma.department.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        abbreviation: true,
        businessUnitId: true,
        businessUnit: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  // ── POST /api/approval-lines ────────────────────────────────────────────────

  async createApprovalLine(user: JwtPayload, name: string, levels: LevelPayload[]) {
    if (!name || !levels || !user?.id) {
      throw new BadRequestException('Missing required fields');
    }

    const newLine = await this.prisma.lineOfApproval.create({
      data: {
        name,
        userId: user.id,
        businessUnitId: user.businessUnitId ?? null,
      },
      select: { id: true, name: true },
    });

    // Create approval users separately to avoid nested relation TypeScript issues
    if (levels.length > 0) {
      const pivotRows: Prisma.LineOfApprovalUserPivotCreateManyInput[] = levels.flatMap((lv, idx) =>
        (lv.users ?? []).map((u) => ({
          lineOfApprovalId: newLine.id,
          userId: u.id ?? null,
          level: idx,
          isSigReq: !!u.isSigReq,
          slotType: (u.slotType || 'FIXED_USER') as ApprovalSlotType,
          roleDescription: u.roleDescription ?? null,
          approvalRequirement: (u.approvalRequirement || 'ALL') as ApprovalRequirement,
        })),
      );
      if (pivotRows.length > 0) {
        await this.prisma.lineOfApprovalUserPivot.createMany({ data: pivotRows });
      }
    }

    await this.adminLog.write(user.id, 'LOA_CREATE', 'APPROVAL_LINE', newLine.id, newLine.name, {
      levelsCount: levels.length,
    });

    const fullLine = await this.prisma.lineOfApproval.findUnique({
      where: { id: newLine.id },
      select: {
        id: true,
        name: true,
        approvalUsers: {
          orderBy: { level: 'asc' },
          select: {
            level: true,
            isSigReq: true,
            user: { select: { id: true, name: true } },
          },
        },
      },
    });

    return {
      id: fullLine!.id,
      name: fullLine!.name,
      levels: formatLevels(filterValidUsers(fullLine!.approvalUsers)),
    };
  }

  // ── PUT /api/approval-lines/:id ─────────────────────────────────────────────

  async updateApprovalLine(user: JwtPayload, lineId: number, name?: string, levels?: LevelPayload[]) {
    if (!Array.isArray(levels)) {
      throw new BadRequestException('levels must be an array');
    }

    type Wanted = {
      userId: number;
      level: number;
      isSigReq: boolean;
      slotType?: string;
      roleDescription?: string | null;
      approvalRequirement?: string;
    };

    const wantedRaw: Wanted[] = levels.flatMap((lv, idx) => {
      if (!Array.isArray(lv?.users)) throw new BadRequestException('Invalid levels structure');
      return (lv.users ?? []).map((u) => ({
        userId: typeof u === 'number' ? (u as unknown as number) : Number((u as any)?.id),
        level: idx,
        isSigReq: typeof u === 'number' ? false : !!(u as any)?.isSigReq,
        slotType: (u as any)?.slotType || 'FIXED_USER',
        roleDescription: (u as any)?.roleDescription ?? null,
        approvalRequirement: (u as any)?.approvalRequirement || 'ALL',
      }));
    });

    if (wantedRaw.some((w) => !Number.isFinite(w.userId))) {
      throw new BadRequestException('Invalid userId in levels');
    }

    const seen = new Set<string>();
    for (const w of wantedRaw) {
      const key = `${w.userId}-${w.level}`;
      if (seen.has(key)) {
        throw new BadRequestException('Duplicate user at the same level');
      }
      seen.add(key);
    }
    const wanted = wantedRaw;

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.lineOfApproval.findUnique({
        where: { id: lineId },
        select: { id: true },
      });
      if (!existing) throw new NotFoundException('Approval line not found');

      const dataUpdate: Record<string, unknown> = {};
      if (typeof name === 'string' && name.trim()) {
        dataUpdate['name'] = name.trim();
      }

      if (Object.keys(dataUpdate).length) {
        await tx.lineOfApproval.update({ where: { id: lineId }, data: dataUpdate });
      }

      await tx.lineOfApprovalUserPivot.deleteMany({ where: { lineOfApprovalId: lineId } });

      if (wanted.length) {
        await tx.lineOfApprovalUserPivot.createMany({
          data: wanted.map((w) => ({
            lineOfApprovalId: lineId,
            userId: w.userId,
            level: w.level,
            isSigReq: w.isSigReq,
            slotType: (w.slotType || 'FIXED_USER') as ApprovalSlotType,
            roleDescription: w.roleDescription ?? null,
            approvalRequirement: (w.approvalRequirement || 'ALL') as ApprovalRequirement,
          })),
        });
      }
    });

    const updated = await this.prisma.lineOfApproval.findUnique({
      where: { id: lineId },
      select: {
        id: true,
        name: true,
        approvalUsers: {
          orderBy: { level: 'asc' },
          select: {
            level: true,
            isSigReq: true,
            slotType: true,
            roleDescription: true,
            approvalRequirement: true,
            user: { select: { id: true, name: true, lastname: true, nickname: true } },
          },
        },
      },
    });

    if (!updated) throw new NotFoundException('Approval line not found');

    await this.adminLog.write(user.id, 'LOA_UPDATE', 'APPROVAL_LINE', updated.id, updated.name, {
      nameChanged: !!(name && name.trim()),
      levelsCount: updated.approvalUsers.filter((u) => u.user).length,
    });

    return {
      id: updated.id,
      name: updated.name,
      levels: formatLevels(filterValidUsers(updated.approvalUsers)),
    };
  }

  // ── DELETE /api/approval-lines/:id ──────────────────────────────────────────

  async deleteApprovalLine(user: JwtPayload, lineId: number) {
    await this.prisma.masterMemo.updateMany({
      where: { approvalLineId: lineId },
      data: { approvalLineId: null },
    });

    await this.prisma.lineOfApprovalUserPivot.deleteMany({
      where: { lineOfApprovalId: lineId },
    });

    const deletedLine = await this.prisma.lineOfApproval.delete({ where: { id: lineId } });

    await this.adminLog.write(user.id, 'LOA_DELETE', 'APPROVAL_LINE', lineId, deletedLine.name, {});
  }

  // ── GET /api/memos/:id/approvers ─────────────────────────────────────────────

  async getApprovers(memoId: number) {
    const memo = await this.prisma.masterMemo.findUnique({ where: { id: memoId } });
    if (!memo) throw new NotFoundException('Memo not found');

    const line = await this.prisma.lineOfApproval.findFirst({
      orderBy: { id: 'desc' },
      include: {
        approvalUsers: {
          select: {
            level: true,
            user: { select: { id: true, name: true, lastname: true, nickname: true } },
          },
          orderBy: { level: 'asc' },
        },
      },
    });

    if (!line) return [];

    return line.approvalUsers
      .filter((p) => p.user !== null)
      .map((p) => ({ id: p.user!.id, name: p.user!.name, level: p.level }));
  }

  // ── GET /api/memos/:id/approval-line ─────────────────────────────────────────

  async getApprovalLineByMemo(memoId: number) {
    const latestStatus = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: 'desc' },
      select: { statusId: true },
    });
    const recallType = await getRecallType(this.prisma, memoId);

    if (latestStatus?.statusId === 1 && recallType === 'clear') {
      return { memoId, name: 'Current', levels: [] };
    }

    const rows = await this.prisma.memoApproverAction.findMany({
      where: { memoId },
      orderBy: [{ loaUserId: 'asc' }, { version: 'desc' }],
      distinct: ['loaUserId'],
      select: {
        loaUserId: true,
        memoId: true,
        version: true,
        createdAt: true,
        updatedAt: true,
        actedAt: true,
        approveWithCondition: true,
        rejectReason: true,
        terminationReason: true,
        status: { select: { code: true } },
        loaUser: {
          select: {
            id: true,
            level: true,
            isSigReq: true,
            slotType: true,
            roleDescription: true,
            approvalRequirement: true,
            templatePivotId: true,
            user: { select: { id: true, name: true, lastname: true, nickname: true } },
          },
        },
      },
    });

    // First pass: check if ANY requirement is met at each level
    const levelApprovalStatus = new Map<
      number,
      { hasApproval: boolean; requirement: string; approvedBy?: string }
    >();

    rows.forEach((r) => {
      const lvl = r.loaUser.level;
      const requirement = r.loaUser.approvalRequirement || 'ALL';
      if (!levelApprovalStatus.has(lvl)) {
        levelApprovalStatus.set(lvl, { hasApproval: false, requirement });
      }
      if (r.status.code === 'approved') {
        const levelStatus = levelApprovalStatus.get(lvl)!;
        levelStatus.hasApproval = true;
        const u = r.loaUser.user;
        if (u) {
          const fullName = [u.name, u.lastname].filter(Boolean).join(' ');
          levelStatus.approvedBy = u.nickname ? `${fullName} (${u.nickname})` : fullName;
        }
      }
    });

    // Second pass: build grouped output
    const grouped: Record<number, unknown[]> = {};
    rows.forEach((r) => {
      const lvl = r.loaUser.level;
      const s = r.status.code;
      const u = r.loaUser.user;
      if (!u) return;

      const levelStatus = levelApprovalStatus.get(lvl);
      const isLevelSatisfied = levelStatus?.requirement === 'ANY' && !!levelStatus?.hasApproval;
      const finalStatus = s === 'waiting' && isLevelSatisfied ? 'not_required' : s;

      (grouped[lvl] ??= []).push({
        loaUserPivotId: r.loaUser.id ?? r.loaUserId,
        level: lvl,
        status: finalStatus,
        isSigReq: r.loaUser.isSigReq,
        slotType: r.loaUser.slotType ?? null,
        roleDescription: r.loaUser.roleDescription ?? null,
        approvalRequirement: r.loaUser.approvalRequirement ?? 'ALL',
        isLevelSatisfied: isLevelSatisfied || false,
        approvedBy: levelStatus?.approvedBy,
        approveWithCondition: r.approveWithCondition ?? null,
        rejectReason: r.rejectReason ?? null,
        terminateReason: r.terminationReason ?? null,
        since: s === 'waiting' ? r.createdAt.toISOString() : null,
        actedAt:
          s === 'approved' || s === 'rejected' || s === 'terminated'
            ? (r.actedAt ?? r.updatedAt).toISOString()
            : null,
        user: {
          id: u.id,
          name: u.name,
          lastname: u.lastname ?? null,
          nickname: u.nickname ?? null,
        },
        id: u.id,
        name: u.name,
        lastname: u.lastname ?? null,
        nickname: u.nickname ?? null,
      });
    });

    const levels = Object.entries(grouped)
      .map(([lvl, users]) => ({ level: Number(lvl), users }))
      .sort((a, b) => a.level - b.level);

    return { memoId, name: 'Current', levels };
  }

  // ── GET /api/approval-requests/my ────────────────────────────────────────────

  async listMyApprovalRequests(meId: number) {
    const HIDE = new Set(
      ['DRAFT', 'RECALL', 'RECALLED', 'CANCEL', 'CANCELLED', 'APPROVED', 'REJECTED', 'TERMINATED', 'TERMINATE'].map(
        (s) => s.toUpperCase(),
      ),
    );
    const up = (s?: string | null) => (s ?? '').toUpperCase();

    // 1) MAIN — งานที่ "ฉัน" ต้องกด
    const mainRows = await this.prisma.memoApproverAction.findMany({
      where: {
        status: { code: { in: ['waiting', 'WAITING'] } },
        OR: [{ loaUser: { userId: meId } }, { assignedUserId: meId }],
      },
      orderBy: [{ memoId: 'asc' }, { version: 'desc' }],
      distinct: ['memoId'],
      include: {
        memo: {
          select: {
            id: true,
            memonumber: true,
            subject: true,
            createdAt: true,
            expiresAt: true,
            user: { select: { id: true, name: true, lastname: true, nickname: true } },
            statuses: {
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: { status: { select: { name: true } } },
            },
          },
        },
        loaUser: { select: { level: true } },
      },
    });

    const mainVisibleStatus = mainRows.filter((r) => {
      const latestName = r.memo.statuses?.[0]?.status?.name ?? 'DRAFT';
      return !HIDE.has(up(latestName));
    });

    const memoIds = Array.from(new Set(mainVisibleStatus.map((r) => r.memo.id)));

    const mainMaxVerArr = await this.prisma.memoApproverAction.groupBy({
      by: ['memoId'],
      where: { memoId: { in: memoIds } },
      _max: { version: true },
    });
    const maxVerByMemo = new Map<number, number>(
      mainMaxVerArr.map((x) => [x.memoId, x._max.version ?? 0]),
    );

    const waitingAll = await this.prisma.memoApproverAction.findMany({
      where: { memoId: { in: memoIds }, status: { code: { in: ['waiting', 'WAITING'] } } },
      select: { memoId: true, version: true, loaUser: { select: { level: true } } },
    });

    const waitingLatest = waitingAll.filter(
      (w) => w.version === (maxVerByMemo.get(w.memoId) ?? w.version),
    );

    const minWaitingByMemo = new Map<number, number>();
    for (const w of waitingLatest) {
      const cur = minWaitingByMemo.get(w.memoId);
      const lvl = w.loaUser.level;
      if (cur == null || lvl < cur) minWaitingByMemo.set(w.memoId, lvl);
    }

    const mainFiltered = mainVisibleStatus.filter((r) => {
      const minLvl = minWaitingByMemo.get(r.memo.id);
      if (minLvl == null) return true;
      return r.loaUser.level === minLvl;
    });

    const mainItems = mainFiltered.map((r) => ({
      memoId: r.memo.id,
      memonumber: r.memo.memonumber ?? '',
      subject: r.memo.subject,
      owner: {
        id: r.memo.user.id,
        name: r.memo.user.name,
        lastname: r.memo.user.lastname ?? null,
        nickname: r.memo.user.nickname ?? null,
      },
      requestedAt: r.createdAt.toISOString(),
      requestType: 'main' as const,
      level: r.loaUser.level,
      expiresAt: r.memo.expiresAt ?? null,
    }));

    // 2) EXTRA
    const extraRows = await this.prisma.extraApprover.findMany({
      where: {
        userId: meId,
        actedAt: null,
        extra: { status: { in: ['PENDING', 'IN_PROGRESS'] } },
      },
      orderBy: [{ extraId: 'asc' }, { version: 'desc' }],
      distinct: ['extraId'],
      include: {
        extra: {
          select: {
            id: true,
            createdAt: true,
            memo: {
              select: {
                id: true,
                memonumber: true,
                subject: true,
                createdAt: true,
                expiresAt: true,
                user: { select: { id: true, name: true, lastname: true, nickname: true } },
                statuses: {
                  take: 1,
                  orderBy: { createdAt: 'desc' },
                  select: { status: { select: { name: true } } },
                },
              },
            },
          },
        },
      },
    });

    const extraFiltered = extraRows.filter((r) => {
      const latestName = r.extra.memo.statuses?.[0]?.status?.name ?? 'DRAFT';
      return !HIDE.has(up(latestName));
    });

    const extraItems = extraFiltered.map((r) => ({
      memoId: r.extra.memo.id,
      memonumber: r.extra.memo.memonumber ?? '',
      subject: r.extra.memo.subject,
      owner: {
        id: r.extra.memo.user.id,
        name: r.extra.memo.user.name,
        lastname: r.extra.memo.user.lastname ?? null,
        nickname: r.extra.memo.user.nickname ?? null,
      },
      requestedAt: r.extra.createdAt.toISOString(),
      requestType: 'extra' as const,
      extraId: r.extra.id,
      expiresAt: r.extra.memo.expiresAt ?? null,
    }));

    const items = [...mainItems, ...extraItems].sort(
      (a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime(),
    );

    return { items };
  }
}
