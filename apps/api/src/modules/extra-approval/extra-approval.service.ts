/**
 * ExtraApprovalService (Nest) — extra approval lines on a Processing memo.
 * Ported from backend/src/services/extraApproval.service.ts and
 * searchEligibleUsersForExtra in backend/src/controllers/memo.controller.ts.
 *
 * Error bodies keep the Express shape ({ error } / { code, statusCode, currentStatusId })
 * because the frontend reads them.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ActionType, ExtraStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { EmailPreferenceService } from '../../common/mail/email-preference.service';
import { MemoAccessService } from '../memo-query/memo-access.service';
import { MemoNotificationService } from '../memo-notification/memo-notification.service';
import {
  buildDeleteExtraHtml,
  buildDeleteExtraPlain,
  buildExtraHtml,
  buildExtraPlain,
} from './extra-approval.templates';

type NameBits = { name?: string | null; lastname?: string | null; nickname?: string | null };

/** Express's local fmtName — unlike toDisplayName it never drops a duplicate nickname. */
function fmtName(u: NameBits): string {
  const base = [u.name, u.lastname].filter(Boolean).join(' ').trim();
  return u.nickname ? `${base} (${u.nickname})` : base || (u.name ?? '');
}

const STATUS_CODE_BY_ID: Record<number, string> = {
  1: 'DRAFT_APPROVE',
  3: 'APPROVED',
  4: 'REJECTED',
  6: 'RECALLED',
  7: 'TERMINATED',
  8: 'EXPIRED',
};

const ACTIVE = new Set<ExtraStatus>([ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS]);

const APPROVER_USER_SELECT = {
  id: true,
  name: true,
  lastname: true,
  nickname: true,
  profileImagePath: true,
} as const;

const LINE_WITH_APPROVERS = {
  approvers: {
    include: {
      user: { select: APPROVER_USER_SELECT },
      status: { select: { id: true, name: true } },
    },
    orderBy: { id: 'asc' },
  },
} satisfies Prisma.ExtraApprovalLineInclude;

const COMMENT_SELECT = {
  id: true,
  comment: true,
  createdAt: true,
  user: { select: { id: true, name: true, lastname: true, nickname: true } },
} as const;

export type CreateLineBody = {
  userIds?: unknown;
  preApprovedUsers?: unknown;
  comment?: unknown;
};

@Injectable()
export class ExtraApprovalService {
  private readonly logger = new Logger(ExtraApprovalService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly prefs: EmailPreferenceService,
    private readonly memoAccess: MemoAccessService,
    private readonly notifications: MemoNotificationService,
  ) {}

  // ── POST /api/memos/:id/extra-approval-lines ───────────────────────────

  async createLine(memoId: number, actorId: number, body: CreateLineBody) {
    const userIds: number[] = Array.isArray(body.userIds)
      ? Array.from(new Set(body.userIds.map(Number).filter(Boolean)))
      : [];
    if (!memoId || !userIds.length) {
      throw new BadRequestException({ error: 'memoId / userIds ไม่ถูกต้อง' });
    }

    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true, subject: true, memonumber: true },
    });
    if (!memo) throw new NotFoundException({ error: 'Memo not found' });

    await this.assertProcessing(memoId, actorId, 'createExtraApprovalLine');

    const isOwner = memo.userId === actorId;
    const [isApprover, isCc, isMentioned, isExtraApprover] = await Promise.all([
      this.prisma.lineOfApprovalUserPivotForUse.findFirst({
        where: { memoId, userId: actorId },
        select: { id: true },
      }),
      this.prisma.memoCc.findFirst({ where: { memoId, userId: actorId }, select: { id: true } }),
      this.prisma.commentTag.findFirst({
        where: { memoId, userId: actorId },
        select: { id: true },
      }),
      this.prisma.extraApprover.findFirst({
        where: { userId: actorId, extra: { memoId } },
        select: { id: true },
      }),
    ]);
    if (!isOwner && !isApprover && !isCc && !isMentioned && !isExtraApprover) {
      throw new ForbiddenException({ error: 'ไม่มีสิทธิ์สร้างไลน์อนุมัติพิเศษในขั้นตอนนี้' });
    }

    // Several active lines per memo are allowed (one card per request).

    // Users carried over as already-approved, keeping their original approval time.
    const preApprovedUsers: { userId: number; actedAt: string | null }[] = Array.isArray(
      body.preApprovedUsers,
    )
      ? body.preApprovedUsers
      : [];
    const commentText = (typeof body.comment === 'string' ? body.comment.trim() : '') || undefined;

    const preApprovedMap = new Map<number, Date>();
    for (const u of preApprovedUsers) {
      preApprovedMap.set(Number(u.userId), u.actedAt ? new Date(u.actedAt) : new Date());
    }

    const approvedStatusId = await this.getStatusIdByName('Approved');
    const approversData = userIds.map((uid) => {
      const preApprovedAt = preApprovedMap.get(uid);
      return {
        userId: uid,
        statusId: preApprovedAt ? approvedStatusId : null,
        actedAt: preApprovedAt ?? null,
      };
    });

    const line = await this.prisma.extraApprovalLine.create({
      data: {
        memoId,
        createdById: actorId,
        status: ExtraStatus.PENDING,
        approvers: { create: approversData },
      },
      // Express had no orderBy here, so approver order varied between calls.
      include: { ...LINE_WITH_APPROVERS, comment: true },
    });

    // One comment row per selected user — the comment feed renders these as the line card.
    await this.prisma.comment.createMany({
      data: userIds.map((uid) => ({
        memoId,
        userId: actorId,
        comment: commentText || '',
        ExtraUserid: uid,
        ExtraStatus: preApprovedMap.has(uid) ? 'Approved' : 'Pending',
        extraApprovalLineId: line.id,
      })),
    });
    line.comment = await this.prisma.comment.findMany({ where: { extraApprovalLineId: line.id } });

    try {
      const actor = await this.prisma.user.findUnique({
        where: { id: actorId },
        select: { name: true, lastname: true, nickname: true },
      });
      const actorLabel = fmtName(actor ?? {});

      const recipients = await this.prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, lastname: true, nickname: true, email: true },
      });
      const addedNames = recipients.map(fmtName);
      const ownerId = memo.userId;
      const memoSubject = memo.subject || `#${memoId}`;

      await this.sendExtraApprovalEmails({
        receiverIds: ownerId ? Array.from(new Set([ownerId, ...userIds])) : userIds,
        memoSubject,
        memoNumber: memo.memonumber ?? memoId,
        memoId,
        actorName: actorLabel,
        mode: 'requested',
        addedNames,
        ownerId,
      });

      const notifySet = new Set(
        await this.prefs.filterUsersForEmail(
          [ownerId ? ownerId : -1, ...recipients.map((u) => u.id)].filter((id) => id > 0),
          'add-extra-approval',
        ),
      );
      if (ownerId && recipients.length > 0 && notifySet.has(ownerId)) {
        await this.prisma.notification.createMany({
          data: [
            {
              memoId,
              userId: ownerId,
              actorId,
              notificationTypeId: 2,
              message: `${actorLabel} requested an extra approval line from ${addedNames.join(', ')} for "${memoSubject}".`,
            },
          ],
        });
      }
      const notifyRecipients = recipients.filter((u) => u.id !== ownerId && notifySet.has(u.id));
      if (notifyRecipients.length) {
        await this.prisma.notification.createMany({
          data: notifyRecipients.map((u) => ({
            memoId,
            userId: u.id,
            actorId,
            notificationTypeId: 2,
            message: `You were assigned as an extra approver to "${memoSubject}".`,
          })),
        });
      }

      const preApprovedSet = new Set(preApprovedUsers.map((u) => Number(u.userId)));
      const namesList = recipients
        .filter((u) => !preApprovedSet.has(u.id))
        .map(fmtName)
        .join(', ');
      await this.history(memoId, actorId, `Extra Approver added: ${namesList} by ${actorLabel}`);
    } catch (err) {
      this.logger.warn(`createLine post-actions failed: ${(err as Error)?.message}`);
      await this.history(memoId, actorId, 'Extra approval line created; notification step failed.');
    }

    return line;
  }

  // ── POST /api/memos/:memoId/extra-approval-lines/:lineId/append ────────

  async appendApprovers(memoId: number, lineId: number, actorId: number, rawUserIds: unknown) {
    const raw = Array.isArray(rawUserIds) ? (rawUserIds as Array<string | number>) : [];
    const userIds = Array.from(
      new Set(raw.map((v) => Number(v)).filter((n) => Number.isFinite(n) && n > 0)),
    );
    if (!memoId || !lineId || userIds.length === 0) {
      throw new BadRequestException({ error: 'memoId/lineId หรือ userIds ไม่ถูกต้อง' });
    }

    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true, subject: true, memonumber: true },
    });
    if (!memo) throw new NotFoundException({ error: 'Memo not found' });

    await this.assertProcessing(memoId, actorId, 'appendExtraApprovers');

    // Anyone taking part in the memo may append.
    const latestVersion = await this.notifications.getLatestVersion(memoId);
    const [loaRows, ccRows, extraRows, extraCreators, mentionedRows] = await Promise.all([
      this.prisma.memoApproverAction.findMany({
        where: { memoId, version: latestVersion },
        select: { loaUser: { select: { userId: true } } },
      }),
      this.prisma.memoCc.findMany({ where: { memoId }, select: { userId: true } }),
      this.prisma.extraApprover.findMany({
        where: { extra: { memoId } },
        select: { userId: true },
      }),
      this.prisma.extraApprovalLine.findMany({ where: { memoId }, select: { createdById: true } }),
      this.prisma.commentTag.findMany({ where: { memoId }, select: { userId: true } }),
    ]);
    const approverUserIds = new Set(
      loaRows.map((r) => r.loaUser.userId).filter((id): id is number => id !== null),
    );
    const participants = new Set<number>([
      memo.userId,
      ...approverUserIds,
      ...ccRows.map((r) => r.userId),
      ...extraRows.map((r) => r.userId),
      ...extraCreators.map((x) => x.createdById),
      ...mentionedRows.map((r) => r.userId),
    ]);
    if (!participants.has(actorId)) {
      throw new ForbiddenException({
        error: 'ไม่มีสิทธิ์เพิ่มผู้อนุมัติพิเศษ (เฉพาะผู้มีส่วนร่วมของเมโมเท่านั้น)',
      });
    }

    const line = await this.prisma.extraApprovalLine.findUnique({
      where: { id: lineId },
      include: { approvers: true },
    });
    if (!line || line.memoId !== memoId) {
      throw new NotFoundException({ error: 'ไม่พบ Extra line ของเมโมนี้' });
    }
    if (line.status === ExtraStatus.REJECTED) {
      throw new ConflictException({ error: 'ไลน์นี้ถูก Reject แล้ว ไม่สามารถเพิ่มได้' });
    }
    if (line.approvers.some((a) => !a.statusId)) {
      throw new ConflictException({
        error:
          'ไม่สามารถเพิ่มผู้อนุมัติได้ในขณะนี้ กรุณารอให้ผู้อนุมัติปัจจุบันทำการอนุมัติหรือปฏิเสธก่อน',
      });
    }

    // Skip users already on this line or on the main approval line (CC users may be promoted).
    const existed = new Set(line.approvers.map((a) => a.userId));
    const toAdd = userIds.filter((uid) => !existed.has(uid) && !approverUserIds.has(uid));
    const skippedCount = userIds.length - toAdd.length;

    if (toAdd.length === 0) {
      return this.prisma.extraApprovalLine.findUnique({
        where: { id: lineId },
        include: LINE_WITH_APPROVERS,
      });
    }

    await this.prisma.extraApprover.createMany({
      data: toAdd.map((uid) => ({ extraId: lineId, userId: uid })),
    });
    const newStatus = await this.recomputeLineStatus(lineId);

    try {
      const actorName = await this.notifications.getUserDisplayName(actorId);
      const addedUsers = await this.prisma.user.findMany({
        where: { id: { in: toAdd } },
        select: { id: true, name: true, lastname: true, nickname: true },
      });
      const addedNames = addedUsers.map(fmtName);
      const ownerId = memo.userId;
      const memoSubject = memo.subject || `#${memoId}`;

      const { attempted, okCount, failCount } = await this.sendExtraApprovalEmails({
        receiverIds: ownerId ? Array.from(new Set([ownerId, ...toAdd])) : toAdd,
        memoSubject,
        memoNumber: memo.memonumber ?? memoId,
        memoId,
        actorName,
        mode: 'added',
        addedNames,
        ownerId,
      });

      const notifySet = new Set(
        await this.prefs.filterUsersForEmail(
          [ownerId ? ownerId : -1, ...toAdd].filter((id) => id > 0),
          'add-extra-approval',
        ),
      );
      if (ownerId && notifySet.has(ownerId)) {
        await this.prisma.notification.createMany({
          data: [
            {
              memoId,
              userId: ownerId,
              actorId,
              notificationTypeId: 2,
              message: `${actorName} added ${addedNames.join(', ')} as extra approver(s) to "${memoSubject}".`,
            },
          ],
        });
      }
      const notifyAdded = addedUsers.filter((u) => u.id !== ownerId && notifySet.has(u.id));
      if (notifyAdded.length) {
        await this.prisma.notification.createMany({
          data: notifyAdded.map((u) => ({
            memoId,
            userId: u.id,
            actorId,
            notificationTypeId: 2,
            message: `You were added as an extra approver to "${memoSubject}".`,
          })),
        });
      }

      const base =
        `${actorName} added ${toAdd.length} ${addedNames.join(', ')}` +
        (skippedCount ? `; skipped ${skippedCount} (duplicate in Extra/LoA)` : '') +
        `; line → ${newStatus}`;
      await this.history(
        memoId,
        actorId,
        attempted
          ? `${base}; emailed ${okCount}/${attempted}${failCount ? ` (failed ${failCount})` : ''}`
          : `${base}; no emails sent`,
      );
    } catch {
      await this.history(
        memoId,
        actorId,
        `Added ${toAdd.length} extra approver(s); post-actions failed; line → ${newStatus}`,
      );
    }

    return this.prisma.extraApprovalLine.findUnique({
      where: { id: lineId },
      include: LINE_WITH_APPROVERS,
    });
  }

  // ── POST /api/memos/:memoId/extra-approval-lines/:lineId/action ────────

  async act(
    memoId: number,
    lineId: number,
    actorId: number,
    rawStatusCode: unknown,
  ): Promise<{ ok: true; closed: 'rejected' | 'approved' | null }> {
    const statusCode = String(rawStatusCode || '').toLowerCase();
    if (!['approved', 'rejected'].includes(statusCode)) {
      throw new BadRequestException({ error: 'statusCode ต้องเป็น approved/rejected' });
    }

    await this.assertProcessing(memoId, actorId, 'actOnExtraApprovalLine');

    const target = await this.prisma.extraApprover.findFirst({
      where: { extraId: lineId, userId: actorId },
      include: { extra: true },
    });
    if (!target) throw new NotFoundException({ error: 'ไม่พบสิทธิ์ในการอนุมัติพิเศษ' });
    if (target.extra.memoId !== memoId) throw new BadRequestException({ error: 'memoId ไม่ตรง' });

    const line = await this.prisma.extraApprovalLine.findUnique({ where: { id: lineId } });
    if (!line || !ACTIVE.has(line.status)) {
      throw new ConflictException({ error: 'ไลน์นี้ไม่อยู่ในสถานะรอแล้ว' });
    }
    if (target.statusId) throw new ConflictException({ error: 'คุณดำเนินการไปแล้ว' });

    const newStatusId = await this.getStatusIdByName(
      statusCode === 'approved' ? 'Approved' : 'Rejected',
    );
    await this.prisma.extraApprover.update({
      where: { id: target.id },
      data: { statusId: newStatusId, actedAt: new Date() },
    });

    if (statusCode === 'rejected') {
      // One reject closes the line and rejects the whole memo.
      await this.prisma.extraApprovalLine.update({
        where: { id: lineId },
        data: { status: ExtraStatus.REJECTED, closedAt: new Date() },
      });
      await this.prisma.comment.updateMany({
        where: { extraApprovalLineId: lineId },
        data: { ExtraStatus: 'Rejected' },
      });

      const memo = await this.prisma.masterMemo.findUnique({
        where: { id: memoId },
        select: { userId: true },
      });
      const ownerId = memo!.userId;
      const memoRejectedId = await this.getStatusIdByName('Rejected');

      await this.prisma.memoStatusPivot.deleteMany({
        where: { memoId, userId: ownerId, statusId: memoRejectedId },
      });
      const ownerPivot = await this.prisma.memoStatusPivot.findFirst({
        where: { memoId, userId: ownerId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (ownerPivot) {
        await this.prisma.memoStatusPivot.update({
          where: { id: ownerPivot.id },
          data: { statusId: memoRejectedId, createdAt: new Date() },
        });
      } else {
        await this.prisma.memoStatusPivot.create({
          data: { memoId, userId: ownerId, statusId: memoRejectedId },
        });
      }

      const actorName = await this.fmtUser(actorId);
      await this.history(
        memoId,
        actorId,
        `Extra Approval: ${actorName} rejected extra-approval`,
        ActionType.REJECT,
        memoRejectedId,
      );

      this.notifyLater(memoId, actorId, actorName, 4, 'extra reject');
      return { ok: true, closed: 'rejected' };
    }

    if (line.status === ExtraStatus.PENDING) {
      await this.prisma.extraApprovalLine.update({
        where: { id: lineId },
        data: { status: ExtraStatus.IN_PROGRESS },
      });
      await this.prisma.comment.updateMany({
        where: { extraApprovalLineId: lineId },
        data: { ExtraStatus: 'In Progress' },
      });
    }

    const approvedId = await this.getStatusIdByName('Approved');
    const all = await this.prisma.extraApprover.findMany({
      where: { extraId: lineId },
      select: { statusId: true },
    });
    const allApproved = all.length > 0 && all.every((a) => a.statusId === approvedId);

    if (allApproved) {
      await this.prisma.extraApprovalLine.update({
        where: { id: lineId },
        data: { status: ExtraStatus.COMPLETED, closedAt: new Date() },
      });
      await this.prisma.comment.updateMany({
        where: { extraApprovalLineId: lineId },
        data: { ExtraStatus: 'Completed' },
      });

      const actorName = await this.fmtUser(actorId);
      await this.history(
        memoId,
        actorId,
        `Extra Approval: Approved by ${actorName}`,
        ActionType.APPROVE,
        approvedId,
      );
      // Main line resumes — tell whoever is waiting.
      this.notifyLater(memoId, actorId, actorName, 5, 'extra approve');
    }

    return { ok: true, closed: allApproved ? 'approved' : null };
  }

  // ── GET /api/memos/:id/extra-approval-lines/active ─────────────────────

  async getActiveLine(memoId: number, userId: number) {
    await this.assertCanView(userId, memoId);

    const line =
      (await this.prisma.extraApprovalLine.findFirst({
        where: { memoId, status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] } },
        orderBy: { id: 'desc' },
        include: { comment: { select: COMMENT_SELECT } },
      })) ??
      // no active line → the latest closed one
      (await this.prisma.extraApprovalLine.findFirst({
        where: { memoId },
        orderBy: { id: 'desc' },
        include: { comment: { select: COMMENT_SELECT } },
      }));
    if (!line) return null;

    const approvers = await this.prisma.extraApprover.findMany({
      where: { extraId: line.id },
      orderBy: [{ actedAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        actedAt: true,
        statusId: true,
        status: { select: { id: true, name: true } },
        user: { select: APPROVER_USER_SELECT },
      },
    });

    return {
      id: line.id,
      status: line.status,
      createdAt: line.createdAt,
      comments: line.comment,
      approvers,
    };
  }

  // ── POST /api/memos/extra-approval-lines/active/bulk ───────────────────

  async getActiveLinesBulk(userId: number, rawMemoIds: unknown) {
    const raw = rawMemoIds ?? [];
    if (!Array.isArray(raw)) throw new BadRequestException({ error: 'memoIds must be an array' });

    const memoIds = Array.from(
      new Set(raw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0)),
    );
    if (memoIds.length === 0) return {};
    if (memoIds.length > 5000)
      throw new BadRequestException({ error: 'Too many memoIds (max 5000)' });

    // Visibility — same rule as the dashboard list
    const visibleMemos = await this.prisma.masterMemo.findMany({
      where: {
        id: { in: memoIds },
        OR: [
          { userId },
          { approverActions: { some: { loaUser: { userId } } } },
          { ccRecipients: { some: { userId } } },
          { extraApprovalLines: { some: { approvers: { some: { userId } } } } },
          { commentTags: { some: { userId } } },
        ],
      },
      select: {
        id: true,
        userId: true,
        statuses: { include: { status: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const allowedIds = visibleMemos
      .filter((m) => {
        const latest = m.statuses?.[0]?.status?.name ?? '';
        if (latest === 'Deleted') return false;
        if (latest === 'Draft' && m.userId !== userId) return false;
        return true;
      })
      .map((m) => m.id);
    if (allowedIds.length === 0) return {};

    const lines = await this.prisma.extraApprovalLine.findMany({
      where: { memoId: { in: allowedIds } },
      orderBy: { id: 'desc' },
      select: { id: true, memoId: true, status: true, createdAt: true },
    });

    // Per memo: latest active line, else latest line
    type Line = (typeof lines)[number];
    const latestActive = new Map<number, Line>();
    const latestAny = new Map<number, Line>();
    for (const ln of lines) {
      if (!latestAny.has(ln.memoId)) latestAny.set(ln.memoId, ln);
      if (!latestActive.has(ln.memoId) && ACTIVE.has(ln.status)) latestActive.set(ln.memoId, ln);
    }
    const chosenByMemo = new Map<number, Line>();
    for (const id of allowedIds) {
      const picked = latestActive.get(id) ?? latestAny.get(id);
      if (picked) chosenByMemo.set(id, picked);
    }

    const chosenLineIds = Array.from(chosenByMemo.values()).map((ln) => ln.id);
    const approvers = chosenLineIds.length
      ? await this.prisma.extraApprover.findMany({
          where: { extraId: { in: chosenLineIds } },
          orderBy: [{ extraId: 'asc' }, { actedAt: 'desc' }, { id: 'asc' }],
          select: {
            id: true,
            extraId: true,
            actedAt: true,
            statusId: true,
            status: { select: { id: true, name: true } },
            user: { select: APPROVER_USER_SELECT },
          },
        })
      : [];
    const byLine = new Map<number, typeof approvers>();
    for (const a of approvers) {
      const arr = byLine.get(a.extraId);
      if (arr) arr.push(a);
      else byLine.set(a.extraId, [a]);
    }

    const result: Record<number, unknown> = {};
    for (const id of allowedIds) {
      const chosen = chosenByMemo.get(id);
      if (!chosen) {
        result[id] = null;
        continue;
      }
      result[id] = {
        id: chosen.id,
        status: chosen.status,
        createdAt: chosen.createdAt,
        approvers: (byLine.get(chosen.id) ?? []).map((a) => ({
          id: a.id,
          actedAt: a.actedAt,
          statusId: a.statusId,
          status: a.status,
          user: a.user,
        })),
      };
    }
    return result;
  }

  // ── GET /api/memos/:id/extra-approval-lines ────────────────────────────

  async listLines(memoId: number, userId: number) {
    await this.assertCanView(userId, memoId);

    return this.prisma.extraApprovalLine.findMany({
      where: { memoId },
      orderBy: { id: 'desc' },
      select: {
        id: true,
        memoId: true,
        createdById: true,
        createdAt: true,
        closedAt: true,
        status: true,
        commentId: true,
        approvers: {
          orderBy: { id: 'asc' },
          select: {
            id: true,
            actedAt: true,
            statusId: true,
            status: { select: { id: true, name: true } },
            user: { select: APPROVER_USER_SELECT },
          },
        },
        comment: { select: COMMENT_SELECT },
      },
    });
  }

  // ── DELETE /api/memos/:memoId/extra-approval-lines/:lineId ─────────────

  async removeLine(memoId: number, lineId: number, actorId: number): Promise<void> {
    const line = await this.prisma.extraApprovalLine.findFirst({
      where: { id: lineId, memoId },
      select: {
        id: true,
        status: true,
        createdById: true,
        commentId: true,
        memo: { select: { subject: true, memonumber: true, userId: true } },
        approvers: { select: { userId: true } },
      },
    });
    if (!line) throw new NotFoundException({ error: 'Extra approval line not found' });
    if (line.createdById !== actorId) {
      throw new ForbiddenException({ error: 'Only the creator can remove this approval line' });
    }
    if (line.status !== 'PENDING') {
      throw new ConflictException({ error: 'Only PENDING approval lines can be removed' });
    }

    const actor = await this.prisma.user.findUnique({
      where: { id: actorId },
      select: { name: true, lastname: true, nickname: true },
    });
    const fmtNameLocal = (u: NameBits | null) => {
      const base = [u?.name, u?.lastname].filter(Boolean).join(' ').trim();
      return u?.nickname ? `${base} (${u.nickname})` : base || `User #${actorId}`;
    };
    const actorLabel = fmtNameLocal(actor);

    const extraApproverSet = new Set(line.approvers.map((a) => a.userId));
    extraApproverSet.delete(actorId);
    const ownerId = line.memo.userId;
    const ownerSet = new Set<number>();
    if (ownerId && ownerId !== actorId && !extraApproverSet.has(ownerId)) ownerSet.add(ownerId);

    const extraApproverUsers = await this.prisma.user.findMany({
      where: { id: { in: Array.from(extraApproverSet) } },
      select: { name: true, lastname: true, nickname: true },
    });
    const extraNames = extraApproverUsers.map(fmtNameLocal);
    const subj = line.memo.subject ?? String(memoId);

    const notifyExtra = new Set(
      await this.prefs.filterUsersForEmail(Array.from(extraApproverSet), 'remove-extra-approval'),
    );
    const notifyOwner = new Set(
      await this.prefs.filterUsersForEmail(Array.from(ownerSet), 'remove-extra-approval'),
    );
    const notis: Prisma.NotificationCreateManyInput[] = [];
    for (const uid of extraApproverSet) {
      if (notifyExtra.has(uid)) {
        notis.push({
          memoId,
          userId: uid,
          actorId,
          notificationTypeId: 2,
          message: `${actorLabel} removed your extra approval line from "${subj}".`,
        });
      }
    }
    for (const uid of ownerSet) {
      if (notifyOwner.has(uid)) {
        notis.push({
          memoId,
          userId: uid,
          actorId,
          notificationTypeId: 2,
          message: `${actorLabel} removed an extra approval line (${extraNames.join(', ')}) from "${subj}".`,
        });
      }
    }
    if (notis.length) await this.prisma.notification.createMany({ data: notis });

    const memoNumber = line.memo.memonumber ?? memoId;
    if (extraApproverSet.size) {
      await this.sendDeleteEmails({
        receiverIds: Array.from(extraApproverSet),
        memoSubject: subj,
        memoNumber,
        memoId,
        actorName: actorLabel,
        deletedNames: extraNames,
        isOwner: false,
      });
    }
    if (ownerSet.size) {
      await this.sendDeleteEmails({
        receiverIds: Array.from(ownerSet),
        memoSubject: subj,
        memoNumber,
        memoId,
        actorName: actorLabel,
        deletedNames: extraNames,
        isOwner: true,
      });
    }

    if (line.commentId) {
      await this.prisma.comment.delete({ where: { id: line.commentId } }).catch(() => undefined);
    }
    await this.prisma.extraApprovalLine.delete({ where: { id: lineId } });

    await this.history(
      memoId,
      actorId,
      `Extra approval line #${lineId} removed by ${actorLabel}`,
    ).catch(() => undefined);
  }

  // ── GET /api/memos/:memoId/extra-approval-lines[/:lineId]/eligible-users ─

  async searchEligibleUsers(memoId: number, lineId: number | null, actorId: number, q: string) {
    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true },
    });
    if (!memo) throw new NotFoundException({ error: 'Memo not found' });

    const latestVersion = await this.notifications.getLatestVersion(memoId);

    // Express also checked "approver waiting at the current level"; that is a
    // subset of "any approver in the latest version", so it is not repeated here.
    const [isAnyApproverLatest, isCc, isMentioned] = await Promise.all([
      this.prisma.memoApproverAction.findFirst({
        where: { memoId, version: latestVersion, loaUser: { userId: actorId } },
        select: { id: true },
      }),
      this.prisma.memoCc.findFirst({ where: { memoId, userId: actorId }, select: { id: true } }),
      this.prisma.commentTag.findFirst({
        where: { memoId, userId: actorId },
        select: { id: true },
      }),
    ]);

    let isExtraCreator = false;
    let isExtraApprover = false;
    if (lineId) {
      const extraLine = await this.prisma.extraApprovalLine.findFirst({
        where: { id: lineId, memoId },
        select: { createdById: true, approvers: { select: { userId: true } } },
      });
      if (!extraLine) throw new NotFoundException({ error: 'Extra line not found' });
      isExtraCreator = extraLine.createdById === actorId;
      isExtraApprover = extraLine.approvers.some((a) => a.userId === actorId);
    } else {
      isExtraApprover = !!(await this.prisma.extraApprover.findFirst({
        where: { userId: actorId, extra: { memoId } },
        select: { id: true },
      }));
    }

    const allowed =
      memo.userId === actorId ||
      !!isAnyApproverLatest ||
      !!isCc ||
      isExtraCreator ||
      isExtraApprover ||
      !!isMentioned;
    if (!allowed) throw new ForbiddenException({ error: 'ไม่มีสิทธิ์ค้นหาผู้อนุมัติพิเศษ' });

    // Exclude self, the owner and main-line approvers (by id and by email).
    const approverUsers = await this.prisma.memoApproverAction.findMany({
      where: { memoId, version: latestVersion },
      select: { loaUser: { select: { userId: true, user: { select: { email: true } } } } },
    });
    const bannedIds = new Set<number>([
      ...approverUsers.map((r) => r.loaUser?.userId).filter((v): v is number => Number.isFinite(v)),
      actorId,
      memo.userId,
    ]);
    const bannedEmails = new Set(
      approverUsers
        .map((r) => r.loaUser?.user?.email?.toLowerCase())
        .filter((v): v is string => !!v),
    );

    return this.prisma.user.findMany({
      where: {
        id: { notIn: Array.from(bannedIds) },
        ...(bannedEmails.size ? { email: { notIn: Array.from(bannedEmails) } } : {}),
        OR: q
          ? [
              { name: { contains: q, mode: 'insensitive' } },
              { lastname: { contains: q, mode: 'insensitive' } },
              { nickname: { contains: q, mode: 'insensitive' } },
              { email: { contains: q, mode: 'insensitive' } },
            ]
          : undefined,
      },
      orderBy: [{ name: 'asc' }, { lastname: 'asc' }],
      take: 20,
      select: {
        id: true,
        name: true,
        lastname: true,
        nickname: true,
        email: true,
        profileImagePath: true,
      },
    });
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** Re-derive a line's status from its approvers and mirror it onto the line's comments. */
  async recomputeLineStatus(lineId: number): Promise<ExtraStatus> {
    const approvedId = await this.getStatusIdByName('Approved');
    const rejectedId = await this.getStatusIdByName('Rejected');
    const rows = await this.prisma.extraApprover.findMany({
      where: { extraId: lineId },
      select: { statusId: true },
    });

    const hasAny = rows.length > 0;
    let final: ExtraStatus;
    if (rows.some((r) => r.statusId === rejectedId)) final = ExtraStatus.REJECTED;
    else if (hasAny && rows.every((r) => r.statusId === approvedId)) final = ExtraStatus.COMPLETED;
    else if (hasAny && rows.some((r) => r.statusId === approvedId)) final = ExtraStatus.IN_PROGRESS;
    else final = ExtraStatus.PENDING;

    await this.prisma.extraApprovalLine.update({
      where: { id: lineId },
      data: {
        status: final,
        createdAt: new Date(),
        closedAt:
          final === ExtraStatus.COMPLETED || final === ExtraStatus.REJECTED ? new Date() : null,
      },
    });

    // IN_PROGRESS → "In Progress"
    const formatted = final
      .split('_')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
    await this.prisma.comment.updateMany({
      where: { extraApprovalLineId: lineId },
      data: { ExtraStatus: formatted },
    });
    return final;
  }

  async hasActiveExtraLine(memoId: number): Promise<boolean> {
    const row = await this.prisma.extraApprovalLine.findFirst({
      where: { memoId, status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] } },
      select: { id: true },
    });
    return !!row;
  }

  private async assertCanView(userId: number, memoId: number): Promise<void> {
    if (!(await this.memoAccess.canViewMemo(userId, memoId))) {
      throw new ForbiddenException({ error: 'Access denied' });
    }
  }

  /** Extra lines can only change while the memo is Processing (5). */
  private async assertProcessing(memoId: number, actorId: number, op: string): Promise<void> {
    const current = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: 'desc' },
      select: { statusId: true },
    });
    const currentStatusId = current?.statusId ?? 0;
    if (currentStatusId === 5) return;

    this.logger.warn(
      `[${op}] BLOCKED: memoId=${memoId} is not in Processing (status ${currentStatusId}), user ${actorId}`,
    );
    throw new ConflictException({
      code: 'MEMO_STATUS_CHANGED',
      statusCode: STATUS_CODE_BY_ID[currentStatusId] || 'UNKNOWN',
      currentStatusId,
    });
  }

  private async getStatusIdByName(name: string): Promise<number> {
    const rec = await this.prisma.status.findFirst({ where: { name }, select: { id: true } });
    if (!rec) throw new Error(`ต้องมี Status.name = "${name}" ในตาราง Status`);
    return rec.id;
  }

  private async fmtUser(userId: number): Promise<string> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, lastname: true, nickname: true },
    });
    return fmtName(u ?? {});
  }

  private async history(
    memoId: number,
    userId: number,
    action: string,
    actiontype: ActionType = ActionType.UPDATE,
    statusId?: number,
  ) {
    return this.prisma.memoHistory.create({
      data: { memoId, userId, statusId, action, actiontype, timestamp: new Date() },
    });
  }

  /** After the response, like Express's setImmediate — a mail failure must not fail the action. */
  private notifyLater(
    memoId: number,
    actorId: number,
    actorName: string,
    statusId: number,
    label: string,
  ) {
    setImmediate(() => {
      this.notifications
        .notifyStatusUpdate(memoId, actorId, actorName, statusId, null)
        .catch((err) => this.logger.error(`notifyStatusUpdate ${label} error: ${err}`));
    });
  }

  /** Draft / Recalled memos (and memos with no status) stay silent. */
  private async isSilent(memoId: number): Promise<boolean> {
    const latestPivot = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: 'desc' },
      include: { status: { select: { id: true, name: true } } },
    });
    const stId = latestPivot?.status?.id ?? null;
    const stName = (latestPivot?.status?.name ?? '').toLowerCase();
    return stId === null || stId === 1 || stId === 6 || stName === 'draft' || stName === 'recalled';
  }

  private async sendExtraApprovalEmails(a: {
    receiverIds: number[];
    memoSubject: string;
    memoNumber: string | number;
    memoId: number;
    actorName: string;
    mode: 'requested' | 'added';
    addedNames?: string[];
    ownerId?: number;
  }): Promise<{ attempted: number; okCount: number; failCount: number }> {
    const none = { attempted: 0, okCount: 0, failCount: 0 };
    try {
      if (await this.isSilent(a.memoId)) return none;
      if (!a.receiverIds?.length) return none;

      const filtered = await this.prefs.filterUsersForEmail(a.receiverIds, 'add-extra-approval');
      if (!filtered.length) return none;

      const sendTo = (
        await this.prisma.user.findMany({
          where: { id: { in: filtered } },
          select: { id: true, name: true, email: true },
        })
      ).filter((u) => !!u.email);
      if (!sendTo.length) return none;

      const viewLink = `${process.env['FRONTEND_URL'] ?? 'http://localhost:3000'}/memo/${a.memoId}`;
      const results = await Promise.allSettled(
        sendTo.map((u) => {
          const isOwner = u.id === a.ownerId;
          const subjectLine = isOwner
            ? a.mode === 'added'
              ? `Extra approver(s) added to your memo ${a.memoNumber}: ${a.memoSubject}`
              : `Extra approval line requested for your memo ${a.memoNumber}: ${a.memoSubject}`
            : a.mode === 'added'
              ? `You were added as an extra approver on memo ${a.memoNumber}: ${a.memoSubject}`
              : `Extra approval requested on memo ${a.memoNumber}: ${a.memoSubject}`;
          const args = [
            u.name,
            a.actorName,
            a.memoSubject,
            a.memoNumber,
            viewLink,
            a.mode,
            a.addedNames,
            isOwner,
          ] as const;
          return this.mail.sendEmail(
            [u.email],
            subjectLine,
            buildExtraPlain(...args),
            buildExtraHtml(...args),
            [],
          );
        }),
      );

      const okCount = results.filter((r) => r.status === 'fulfilled').length;
      return { attempted: sendTo.length, okCount, failCount: results.length - okCount };
    } catch (err) {
      this.logger.error(`extra-approval mail error: ${(err as Error)?.message}`);
      return none;
    }
  }

  private async sendDeleteEmails(a: {
    receiverIds: number[];
    memoSubject: string;
    memoNumber: string | number;
    memoId: number;
    actorName: string;
    deletedNames: string[];
    isOwner: boolean;
  }): Promise<void> {
    try {
      if (await this.isSilent(a.memoId)) return;
      if (!a.receiverIds?.length) return;

      const filtered = await this.prefs.filterUsersForEmail(a.receiverIds, 'remove-extra-approval');
      if (!filtered.length) return;

      const sendTo = (
        await this.prisma.user.findMany({
          where: { id: { in: filtered } },
          select: { id: true, name: true, email: true },
        })
      ).filter((u) => !!u.email);
      if (!sendTo.length) return;

      const subjectLine = a.isOwner
        ? `Extra approval line deleted on your memo ${a.memoNumber}: ${a.memoSubject}`
        : `Your extra approval line was deleted on memo ${a.memoNumber}: ${a.memoSubject}`;
      const viewLink = `${process.env['FRONTEND_URL'] ?? 'http://localhost:3000'}/memo/${a.memoId}`;

      await Promise.allSettled(
        sendTo.map((u) => {
          const args = [
            u.name,
            a.actorName,
            a.memoSubject,
            a.memoNumber,
            viewLink,
            a.deletedNames,
            a.isOwner,
          ] as const;
          return this.mail.sendEmail(
            [u.email],
            subjectLine,
            buildDeleteExtraPlain(...args),
            buildDeleteExtraHtml(...args),
            [],
          );
        }),
      );
    } catch (err) {
      this.logger.error(`delete-extra-approval mail error: ${(err as Error)?.message}`);
    }
  }
}
