/**
 * MemoStatusService (Nest) — approver actions and the memo state machine.
 * Ported from backend memoApproveAction.service (approveAction,
 * evaluateAndUpdateMemoStatus), memoStatus.controller (updateMemoStatus,
 * actOnMemo, getMemoActions), memoApproval.service (recordApproverAction) and
 * lib/memoHistory (logMemoHistory).
 *
 * Error bodies keep the Express shape ({ error } / { code, statusCode, ... })
 * because the frontend reads them. Work Express did after responding
 * (setImmediate) still runs after the response via `later`.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ActionType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { EmailPreferenceService } from '../../common/mail/email-preference.service';
import { MemoAccessService } from '../memo-query/memo-access.service';
import { MemoSearchNestService } from '../memo-query/memo-search.service';
import { MemoNotificationService } from '../memo-notification/memo-notification.service';
import { ExtraApprovalService } from '../extra-approval/extra-approval.service';
import { MemoRecallService } from './memo-recall.service';
import {
  ClonePivot,
  STATUS,
  STATUS_CHANGED_KEY,
  TERMINATE_CHANGED_KEY,
  setCurrentStatusTx,
} from './memo-status.helpers';

const ACTION_TYPE_BY_CODE: Record<string, ActionType> = {
  approved: ActionType.APPROVE,
  rejected: ActionType.REJECT,
  processing: ActionType.PROCESSING,
  recalled: ActionType.RECALL,
  terminated: ActionType.TERMINATE,
  draft: ActionType.DRAFT,
};

const ACTION_VERB_BY_CODE: Record<string, string> = {
  approved: 'approved',
  rejected: 'rejected',
  processing: 'marked as processing',
  recalled: 'recalled',
  terminated: 'terminated',
  draft: 'set to draft',
};

const ACT_CODES = new Set(['approved', 'rejected', 'recalled', 'processing', 'terminated']);

export type SignatureActionBody = {
  loaUserId?: number;
  statusCode?: string;
  signatureImageId?: unknown;
  signatureText?: string;
  approveWithCondition?: string;
};

export type ActBody = { loaUserId?: number; statusCode?: string };

export type StatusBody = {
  statusId?: unknown;
  fileId?: number;
  terminationReason?: string;
  rejectReason?: string;
};

type DelegationInfo = {
  originalUserId: number;
  originalUserName: string;
  delegatedUserName: string;
  startDate: Date;
  endDate: Date;
};

@Injectable()
export class MemoStatusService {
  private readonly logger = new Logger(MemoStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly prefs: EmailPreferenceService,
    private readonly memoAccess: MemoAccessService,
    private readonly search: MemoSearchNestService,
    private readonly notifications: MemoNotificationService,
    private readonly extra: ExtraApprovalService,
    private readonly recall: MemoRecallService,
  ) {}

  // ── POST /api/memos/:id/action-signature ───────────────────────────────

  async approveWithSignature(memoId: number, actorId: number, body: SignatureActionBody) {
    const { loaUserId, statusCode, signatureImageId, signatureText, approveWithCondition } = body;
    if (Number.isNaN(memoId)) throw new BadRequestException({ error: 'Invalid data' });
    if (await this.extra.hasActiveExtraLine(memoId)) {
      throw new ConflictException({ error: 'มีการอนุมัติพิเศษค้างอยู่ ต้องปิดให้เสร็จก่อน' });
    }
    if (!loaUserId || !statusCode) throw new BadRequestException({ error: 'Invalid data' });

    try {
      if (statusCode === 'approved' || statusCode === 'rejected') {
        await this.assertProcessing(memoId, actorId, statusCode, 'approveAction');
      }

      const approver = await this.resolveApprover(memoId, loaUserId, actorId);

      const statusRec = await this.prisma.approvalActionStatus.findUnique({
        where: { code: statusCode },
        select: { id: true },
      });
      if (!statusRec) throw new BadRequestException({ error: 'Invalid statusCode' });

      const latestVersion = await this.notifications.getLatestVersion(memoId);
      const action = await this.prisma.memoApproverAction.update({
        where: { memoId_loaUserId_version: { memoId, loaUserId, version: latestVersion } },
        data: {
          statusId: statusRec.id,
          signatureImageId: signatureImageId ? Number(signatureImageId) : null,
          signatureText: signatureText?.trim() ?? null,
          actedAt: new Date(),
          actualActorId: actorId,
          approveWithCondition: approveWithCondition?.trim() || null,
        },
      });

      const actorName = await this.notifications.getUserDisplayName(actorId);
      const historyStatus = await this.prisma.status.findFirst({
        where: { name: statusCode.charAt(0).toUpperCase() + statusCode.slice(1) },
        select: { id: true },
      });

      let historyAction = `${actorName} ${ACTION_VERB_BY_CODE[statusCode] ?? statusCode} the memo`;
      if (approveWithCondition?.trim()) {
        historyAction += ` (with condition: ${approveWithCondition.trim()})`;
      }
      if (approver.delegationInfo) {
        historyAction += ` (on behalf of ${approver.delegationInfo.originalUserName})`;
      }

      await this.prisma.memoHistory.create({
        data: {
          memoId,
          userId: actorId,
          statusId: historyStatus?.id,
          action: historyAction,
          actiontype: ACTION_TYPE_BY_CODE[statusCode] ?? ActionType.UPDATE,
          timestamp: new Date(),
        },
      });

      this.later('approveAction', async () => {
        try {
          await this.evaluateAndUpdateMemoStatus(memoId, loaUserId);
        } catch (e) {
          this.logger.error(`evaluateAndUpdateMemoStatus (async) failed: ${e}`);
        }
        if (approveWithCondition?.trim()) {
          await this.sendConditionNotices(memoId, actorId, approveWithCondition.trim());
        }
      });

      return {
        ...action,
        isDelegatedApproval: !!approver.delegationInfo,
        delegationInfo: approver.delegationInfo,
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`approveAction failed: ${err}`);
      throw new InternalServerErrorException({ error: 'Approve action failed' });
    }
  }

  // ── POST /api/memos/:id/action ─────────────────────────────────────────

  async act(memoId: number, actorId: number, body: ActBody): Promise<{ ok: true }> {
    const { loaUserId, statusCode } = body;
    if (Number.isNaN(memoId)) throw new BadRequestException({ error: 'Invalid memoId' });
    if (!loaUserId) throw new BadRequestException({ error: 'loaUserId required' });
    if (!statusCode) throw new BadRequestException({ error: 'statusCode required' });

    try {
      const actorName = await this.notifications.getUserDisplayName(actorId);

      if (statusCode === 'approved' || statusCode === 'rejected') {
        await this.assertProcessing(memoId, actorId, statusCode, 'actOnMemo');
      }
      if (!ACT_CODES.has(statusCode)) {
        throw new BadRequestException({ error: 'Invalid status transition' });
      }
      // Express let anyone act on any loaUserId; require the approver (or their delegate).
      await this.resolveApprover(memoId, loaUserId, actorId);

      if (statusCode === 'approved' || statusCode === 'rejected') {
        await this.recordApproverAction(memoId, loaUserId, statusCode);
      } else if (statusCode === 'recalled') {
        await this.recall.handleRecall({ memoId, loaUserId });
      }
      await this.logMemoHistory(memoId, actorId, statusCode, actorName);

      this.later(`evaluate&update (${statusCode})`, () =>
        this.evaluateAndUpdateMemoStatus(memoId, loaUserId),
      );
      return { ok: true };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`actOnMemo error: ${err}`);
      throw new InternalServerErrorException({ error: 'internal error' });
    }
  }

  // ── POST /api/memos/:id/status ─────────────────────────────────────────

  /**
   * Owner/approver status changes: terminate (7), recall (6), reject (4),
   * publish (5), back to draft (1), approved (3). Returns [httpStatus, body].
   * The actor is the logged-in user — Express trusted `userId` from the body.
   */
  async updateStatus(
    memoId: number,
    userId: number,
    body: StatusBody,
  ): Promise<[number, { message: string }]> {
    const { statusId, fileId, terminationReason } = body;

    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true },
    });
    if (!memo) throw new NotFoundException({ error: 'Memo not found' });
    await this.assertCanView(userId, memoId);
    const ownerId = memo.userId;
    const userName = await this.notifications.getUserDisplayName(userId);

    const terminated = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId, statusId: STATUS.TERMINATED },
      select: { id: true },
    });
    if (terminated && statusId !== STATUS.TERMINATED) {
      throw new BadRequestException({
        error: 'This memo is already terminated; no further actions allowed.',
      });
    }

    const latestStatusId = async () =>
      (
        await this.prisma.memoStatusPivot.findFirst({
          where: { memoId },
          orderBy: { createdAt: 'desc' },
          select: { statusId: true },
        })
      )?.statusId ?? 0;
    // Express read "previous status" by id in some branches and by createdAt in others.
    const latestStatusIdById = async () =>
      (
        await this.prisma.memoStatusPivot.findFirst({
          where: { memoId },
          orderBy: { id: 'desc' },
          select: { statusId: true },
        })
      )?.statusId ?? 0;

    switch (statusId) {
      case STATUS.TERMINATED:
        return this.terminate(memoId, userId, userName, ownerId, fileId, terminationReason);

      case STATUS.RECALL: {
        const prevStatusId = await latestStatusId();
        await this.setStatus(memoId, ownerId, STATUS.RECALL);
        await this.setStatus(memoId, ownerId, STATUS.DRAFT);
        await this.history(
          memoId,
          userId,
          `${userName} recalled memo`,
          ActionType.RECALL,
          prevStatusId,
          fileId,
        );
        this.later('recall notify', () =>
          this.notifications.notifyRecallUpdate(memoId, userId, userName),
        );
        return [200, { message: 'Recalled and set to Draft' }];
      }

      case STATUS.REJECTED: {
        const prevStatusId = await latestStatusIdById();
        await this.setStatus(memoId, ownerId, STATUS.REJECTED);
        const myLevel =
          (await this.getClonePivots(memoId)).find((p) => p.userId === userId)?.level ?? 0;

        const rejectedStat = await this.prisma.approvalActionStatus.findUnique({
          where: { code: 'rejected' },
          select: { id: true },
        });
        const myPivot = await this.prisma.lineOfApprovalUserPivotForUse.findFirst({
          where: { memoId, userId },
          select: { id: true },
        });
        if (myPivot) {
          const latest = await this.prisma.memoApproverAction.findFirst({
            where: { memoId, loaUserId: myPivot.id },
            orderBy: { version: 'desc' },
            select: { version: true },
          });
          await this.prisma.memoApproverAction.updateMany({
            where: { memoId, loaUserId: myPivot.id, version: latest?.version ?? 0 },
            data: {
              statusId: rejectedStat?.id,
              actedAt: new Date(),
              rejectReason: body.rejectReason || null,
            },
          });
        }

        await this.prisma.memoHistory.create({
          data: {
            memoId,
            userId,
            statusId: prevStatusId,
            action: body.rejectReason
              ? `${userName} rejected the memo: ${body.rejectReason}`
              : `${userName} rejected the memo`,
            actiontype: ActionType.REJECT,
            timestamp: new Date(),
          },
        });

        this.later('reject notify', () =>
          this.notifications.notifyStatusUpdate(memoId, userId, userName, 4, myLevel),
        );
        return [202, { message: 'Rejected (emails will be sent async)' }];
      }

      case STATUS.PROCESSING: {
        const clonePivots = await this.getClonePivots(memoId);
        if (!clonePivots.length) {
          throw new BadRequestException({ error: 'Memo has no approver pivots' });
        }
        const myLevel = clonePivots.find((p) => p.userId === userId)?.level ?? 0;

        await this.setStatus(memoId, ownerId, STATUS.PROCESSING);
        const prevStatusId = await latestStatusIdById();
        await this.prisma.memoHistory.create({
          data: {
            memoId,
            userId,
            fileId,
            statusId: prevStatusId,
            action:
              prevStatusId === STATUS.RECALL
                ? `${userName} edited memo`
                : `${userName} published the memo`,
            actiontype: prevStatusId === STATUS.RECALL ? ActionType.EDIT : ActionType.PUBLISH,
            timestamp: new Date(),
          },
        });

        this.later('publish-notify', async () => {
          await this.notifications.notifyStatusUpdate(memoId, userId, userName, 5, myLevel);
          const ccUsers = await this.prisma.memoCc.findMany({
            where: { memoId },
            select: { userId: true },
          });
          const ccIds = Array.from(new Set(ccUsers.map((u) => u.userId)));
          if (ccIds.length) await this.notifications.notifyCcAssigned(memoId, userId, ccIds);
        });
        return [200, { message: 'Processing started (no version bump)' }];
      }

      case STATUS.DRAFT: {
        const prevStatus = await this.prisma.memoStatusPivot.findFirst({
          where: { memoId, userId },
          orderBy: { createdAt: 'desc' },
          select: { statusId: true },
        });
        await this.setStatus(memoId, ownerId, STATUS.DRAFT);
        const afterRecall = prevStatus?.statusId === STATUS.RECALL;

        await this.prisma.memoHistory.create({
          data: {
            memoId,
            userId,
            statusId: prevStatus?.statusId ?? 1,
            action: afterRecall
              ? `${userName} edited memo after recalled`
              : `${userName} set status Draft`,
            actiontype: afterRecall ? ActionType.EDIT : ActionType.DRAFT,
            timestamp: new Date(),
            fileId: fileId || undefined,
          },
        });
        return [200, { message: 'Reverted to Draft' }];
      }

      case STATUS.APPROVED: {
        await this.setStatus(memoId, ownerId, STATUS.APPROVED);
        const prevStatusId = await latestStatusId();
        await this.history(
          memoId,
          userId,
          `${userName} set status Approved`,
          ActionType.APPROVE,
          prevStatusId,
          fileId,
        );

        const m = await this.prisma.masterMemo.findUnique({
          where: { id: memoId },
          select: { approvalLineId: true },
        });
        let myLevel: number | null = null;
        if (m?.approvalLineId) {
          const myPivot = await this.prisma.lineOfApprovalUserPivot.findFirst({
            where: { lineOfApprovalId: m.approvalLineId, userId },
          });
          myLevel = myPivot?.level ?? 0;
        }
        await this.notifications.notifyStatusUpdate(memoId, userId, userName, 3, myLevel);
        return [200, { message: 'Fully Approved' }];
      }

      default:
        throw new BadRequestException({ error: 'Invalid status transition' });
    }
  }

  private async terminate(
    memoId: number,
    userId: number,
    userName: string,
    ownerId: number,
    fileId: number | undefined,
    terminationReason: string | undefined,
  ): Promise<[number, { message: string }]> {
    const latest = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: 'desc' },
      select: { statusId: true },
    });
    if (latest?.statusId !== STATUS.PROCESSING) {
      const statusName =
        (
          await this.prisma.status.findUnique({
            where: { id: latest?.statusId ?? 0 },
            select: { name: true },
          })
        )?.name ?? 'Unknown';
      this.logger.warn(
        `[updateMemoStatus] BLOCKED: memoId=${memoId} cannot terminate. Current status: ${statusName}(${latest?.statusId}). User: ${userId}`,
      );
      throw new ConflictException({
        code: 'MEMO_STATUS_CHANGED',
        statusCode: TERMINATE_CHANGED_KEY[latest?.statusId ?? 0] || 'UNKNOWN',
        currentStatus: statusName,
        currentStatusId: latest?.statusId,
      });
    }

    if (!(await this.isCurrentMinWaitingApprover(memoId, userId))) {
      throw new ForbiddenException({
        error: 'Only the current waiting approver at the minimal level can terminate.',
      });
    }

    // Same row as `latest` above (Express read it twice).
    const prevStatusId = latest.statusId;
    const latestVer =
      (
        await this.prisma.memoApproverAction.aggregate({
          where: { memoId },
          _max: { version: true },
        })
      )._max.version ?? 0;
    const myLoaUserId = (await this.getClonePivots(memoId)).find((p) => p.userId === userId)?.id;

    const [waitingStat, rejectedStat, terminatedStat] = await Promise.all(
      ['waiting', 'rejected', 'terminated'].map((code) =>
        this.prisma.approvalActionStatus.findUnique({ where: { code }, select: { id: true } }),
      ),
    );

    await this.prisma.$transaction(async (tx) => {
      if (myLoaUserId && terminatedStat?.id) {
        await tx.memoApproverAction.updateMany({
          where: {
            memoId,
            loaUserId: myLoaUserId,
            version: latestVer,
            statusId: { in: [waitingStat?.id ?? -1, rejectedStat?.id ?? -1] },
          },
          data: {
            statusId: terminatedStat.id,
            actedAt: new Date(),
            terminationReason: terminationReason || null,
          },
        });
      }
      await setCurrentStatusTx(tx, memoId, ownerId, STATUS.TERMINATED);
      await tx.memoHistory.create({
        data: {
          memoId,
          userId,
          statusId: prevStatusId,
          action: terminationReason
            ? `${userName} terminated the memo: ${terminationReason}`
            : `${userName} terminated the memo`,
          actiontype: ActionType.TERMINATE,
          timestamp: new Date(),
          ...(fileId ? { fileId } : {}),
        },
      });
    });
    this.search.invalidateAll();

    this.later('terminate-flow', async () => {
      const myLevel =
        (await this.getClonePivots(memoId)).find((p) => p.userId === userId)?.level ?? 0;
      await this.notifications.notifyStatusUpdate(memoId, userId, userName, 7, myLevel);
    });
    return [202, { message: 'Memo terminated (emails queued)' }];
  }

  // ── GET /api/memos/:id/actions ─────────────────────────────────────────

  async getMemoActions(memoId: number, userId: number) {
    await this.assertCanView(userId, memoId);
    const actions = await this.prisma.memoApproverAction.findMany({
      where: { memoId },
      orderBy: [{ loaUserId: 'asc' }, { version: 'desc' }],
      distinct: ['loaUserId'],
      select: { loaUserId: true, status: { select: { code: true } } },
    });
    return actions.map((a) => ({ loaUserId: a.loaUserId, statusCode: a.status.code }));
  }

  // ── State machine ──────────────────────────────────────────────────────

  /**
   * Re-evaluate every approver action of the latest version and set the memo to
   * Approved (3), Rejected (4) or Processing (5), then notify.
   */
  async evaluateAndUpdateMemoStatus(memoId: number, actorPivotId: number): Promise<void> {
    const loaPivot = await this.prisma.lineOfApprovalUserPivotForUse.findUnique({
      where: { id: actorPivotId },
      include: { user: { select: { id: true, name: true, lastname: true, nickname: true } } },
    });
    if (!loaPivot) throw new Error('loaUserPivotId ไม่ถูกต้อง');

    const actorId = loaPivot.userId;
    const actorName = loaPivot.user?.name || 'Unknown User';
    const myLevel = loaPivot.level;

    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true },
    });
    if (!memo) throw new Error('memo not found');

    const approverPivots = await this.getClonePivots(memoId);
    const version = await this.notifications.getLatestVersion(memoId);
    const actions = await this.prisma.memoApproverAction.findMany({
      where: { memoId, version, loaUserId: { in: approverPivots.map((a) => a.id) } },
      select: {
        loaUserId: true,
        status: { select: { code: true } },
        loaUser: { select: { level: true } },
      },
    });

    const actionsByLevel = new Map<number, typeof actions>();
    for (const a of actions) {
      const list = actionsByLevel.get(a.loaUser.level) ?? [];
      list.push(a);
      actionsByLevel.set(a.loaUser.level, list);
    }
    const pivotsByLevel = new Map<number, ClonePivot[]>();
    for (const p of approverPivots) {
      const list = pivotsByLevel.get(p.level) ?? [];
      list.push(p);
      pivotsByLevel.set(p.level, list);
    }

    const anyRejected = actions.some((a) => a.status.code === 'rejected');

    let allLevelsApproved = true;
    for (const [level, levelPivots] of pivotsByLevel) {
      const levelActions = actionsByLevel.get(level) ?? [];
      const approved = levelActions.filter((a) => a.status.code === 'approved').length;
      const rejected = levelActions.filter((a) => a.status.code === 'rejected').length;
      const ok =
        (levelPivots[0].approvalRequirement || 'ALL') === 'ANY'
          ? approved > 0 && rejected !== levelPivots.length
          : approved === levelPivots.length;
      if (!ok) {
        allLevelsApproved = false;
        break;
      }
    }

    const newStatusId = anyRejected
      ? STATUS.REJECTED
      : allLevelsApproved
        ? STATUS.APPROVED
        : STATUS.PROCESSING;
    await this.setStatus(memoId, memo.userId, newStatusId);
    if (actorId) {
      await this.notifications.notifyStatusUpdate(memoId, actorId, actorName, newStatusId, myLevel);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Express updateCurrentMemoStatus + drop cached search stats (MIGRATION-STATUS C2). */
  private async setStatus(memoId: number, actorUserId: number, newStatusId: number) {
    await this.prisma.$transaction((tx) =>
      setCurrentStatusTx(tx, memoId, actorUserId, newStatusId),
    );
    this.search.invalidateAll();
  }

  /** Approve/reject only while the memo is Processing (5). */
  private async assertProcessing(memoId: number, actorId: number, code: string, op: string) {
    const current = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { createdAt: 'desc' },
      include: { status: { select: { id: true, name: true } } },
    });
    const currentStatusId = current?.status?.id ?? null;
    if (currentStatusId === STATUS.PROCESSING) return;

    const currentStatus = current?.status?.name ?? 'Unknown';
    this.logger.warn(
      `[${op}] BLOCKED: memoId=${memoId} is not in Processing. Current status: ${currentStatus}(${currentStatusId}). Action: ${code} by user ${actorId}`,
    );
    throw new ConflictException({
      code: 'MEMO_STATUS_CHANGED',
      statusCode: STATUS_CHANGED_KEY[currentStatusId ?? 0] || 'UNKNOWN',
      currentStatus,
      currentStatusId,
    });
  }

  /**
   * The actor must be the assigned approver of `loaUserId` in the latest
   * version, or that approver's active delegate.
   */
  private async resolveApprover(
    memoId: number,
    loaUserId: number,
    actorId: number,
  ): Promise<{ delegationInfo: DelegationInfo | null }> {
    const latestVersion = await this.notifications.getLatestVersion(memoId);
    const approverAction = await this.prisma.memoApproverAction.findFirst({
      where: { memoId, loaUserId, version: latestVersion },
      include: { loaUser: { include: { user: { include: { delegatedToUser: true } } } } },
    });
    if (!approverAction) throw new NotFoundException({ error: 'Approver action not found' });

    const originalUserId = approverAction.assignedUserId ?? approverAction.loaUser?.userId ?? null;
    if (originalUserId === actorId) return { delegationInfo: null };

    const original = approverAction.loaUser?.user;
    if (
      originalUserId &&
      original &&
      original.delegatedToUserId === actorId &&
      original.delegationStartDate &&
      original.delegationEndDate
    ) {
      const now = new Date();
      if (now >= original.delegationStartDate && now <= original.delegationEndDate) {
        return {
          delegationInfo: {
            originalUserId,
            originalUserName: `${original.name} ${original.lastname || ''}`.trim(),
            delegatedUserName:
              `${original.delegatedToUser?.name} ${original.delegatedToUser?.lastname || ''}`.trim(),
            startDate: original.delegationStartDate,
            endDate: original.delegationEndDate,
          },
        };
      }
    }
    throw new ForbiddenException({ error: 'You are not authorized to approve this memo' });
  }

  private async assertCanView(userId: number, memoId: number): Promise<void> {
    if (!(await this.memoAccess.canViewMemo(userId, memoId))) {
      throw new ForbiddenException({ error: 'Access denied' });
    }
  }

  /** Approvers of the latest version, one row per pivot, ordered by level. */
  async getClonePivots(memoId: number): Promise<ClonePivot[]> {
    const latestVer = await this.notifications.getLatestVersion(memoId);
    const rows = await this.prisma.memoApproverAction.findMany({
      where: { memoId, version: latestVer },
      orderBy: [{ loaUser: { level: 'asc' } }],
      distinct: ['loaUserId'],
      select: {
        loaUser: { select: { id: true, userId: true, level: true, approvalRequirement: true } },
      },
    });
    return rows.map((r) => ({
      id: r.loaUser.id,
      userId: r.loaUser.userId,
      level: r.loaUser.level,
      approvalRequirement: r.loaUser.approvalRequirement ?? 'ALL',
    }));
  }

  /** Waiting approver at the lowest waiting level of the latest version. */
  private async isCurrentMinWaitingApprover(memoId: number, userId: number): Promise<boolean> {
    const version = await this.notifications.getLatestVersion(memoId);
    const waiting = await this.prisma.approvalActionStatus.findUnique({
      where: { code: 'waiting' },
      select: { id: true },
    });
    if (!waiting) return false;

    const rows = await this.prisma.memoApproverAction.findMany({
      where: { memoId, version, statusId: waiting.id },
      select: { loaUser: { select: { userId: true, level: true } } },
    });
    if (rows.length === 0) return false;

    const minLevel = Math.min(...rows.map((r) => r.loaUser.level));
    return rows.some((r) => r.loaUser.userId === userId && r.loaUser.level === minLevel);
  }

  /** Express recordApproverAction: the actor's latest waiting row → approved/rejected. */
  private async recordApproverAction(
    memoId: number,
    loaUserId: number,
    statusCode: 'approved' | 'rejected',
  ) {
    const newStatus = await this.prisma.approvalActionStatus.findUnique({
      where: { code: statusCode },
      select: { id: true },
    });
    if (!newStatus) throw new Error('Unknown statusCode');
    const waitingStatus = await this.prisma.approvalActionStatus.findUnique({
      where: { code: 'waiting' },
      select: { id: true },
    });
    if (!waitingStatus) throw new Error('ไม่มีสถานะ waiting');

    const action = await this.prisma.memoApproverAction.findFirst({
      where: { memoId, loaUserId, statusId: waitingStatus.id },
      orderBy: { version: 'desc' },
    });
    if (!action) throw new Error('ไม่มีแถว waiting ของ user นี้');

    await this.prisma.memoApproverAction.update({
      where: { id: action.id },
      data: { statusId: newStatus.id, actedAt: new Date() },
    });
  }

  /** Express lib/memoHistory logMemoHistory. */
  private async logMemoHistory(
    memoId: number,
    userId: number,
    statusCode: string,
    actorName: string,
  ) {
    const prev = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: 'desc' },
      select: { statusId: true },
    });
    const code = statusCode.toLowerCase();
    const actiontype: Record<string, ActionType> = {
      approved: ActionType.APPROVE,
      rejected: ActionType.REJECT,
      recalled: ActionType.RECALL,
      terminated: ActionType.TERMINATE,
      publish: ActionType.PUBLISH,
    };
    const text: Record<string, string> = {
      approved: `${actorName} has approved the memo`,
      rejected: `${actorName} has rejected the memo`,
      recalled: `${actorName} has recalled the memo`,
      terminated: `${actorName} has terminated the memo`,
      publish: `${actorName} has published the memo`,
    };
    await this.prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        statusId: prev?.statusId ?? 0,
        action: text[code] ?? `${actorName} updated the memo`,
        actiontype: actiontype[code],
        timestamp: new Date(),
      },
    });
  }

  private async history(
    memoId: number,
    userId: number,
    action: string,
    actiontype: ActionType,
    statusId: number,
    fileId?: number,
  ) {
    await this.prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        statusId,
        action,
        actiontype,
        timestamp: new Date(),
        ...(fileId != null ? { fileId } : {}),
      },
    });
  }

  /** In-app + email notice to the owner and CCs when someone approves with a condition. */
  private async sendConditionNotices(memoId: number, actorId: number, conditionText: string) {
    try {
      const actorName = await this.notifications.getUserDisplayName(actorId);
      const memo = await this.prisma.masterMemo.findUnique({
        where: { id: memoId },
        select: {
          userId: true,
          subject: true,
          memonumber: true,
          memoNumberRecord: { select: { memonumber: true } },
          memoType: { select: { name: true } },
          businessUnit: { select: { name: true } },
          department: { select: { name: true } },
        },
      });
      if (!memo) return;

      const memoSubject = memo.subject ?? `Memo #${memoId}`;
      const memoRef = memo.memonumber ?? memo.memoNumberRecord?.memonumber ?? `memo-${memoId}`;

      const recipientIds = new Set<number>();
      if (memo.userId && memo.userId !== actorId) recipientIds.add(memo.userId);
      const ccUsers = await this.prisma.memoCc.findMany({
        where: { memoId },
        select: { userId: true },
      });
      for (const cc of ccUsers) if (cc.userId !== actorId) recipientIds.add(cc.userId);
      if (!recipientIds.size) return;

      const filteredIds = await this.prefs.filterUsersForEmail(
        Array.from(recipientIds),
        'approve-with-condition',
      );
      if (!filteredIds.length) return;

      await this.notifications.pushNoti(
        filteredIds,
        actorId,
        {
          notificationTypeId: 3,
          memoId,
          statusId: 5,
          message: `${actorName} approved memo "${memoSubject}" with condition: ${conditionText}`,
        },
        'status-approved',
      );

      const users = await this.prisma.user.findMany({
        where: { id: { in: filteredIds } },
        select: { id: true, name: true, lastname: true, nickname: true, email: true },
      });

      const viewLink = `${process.env['FRONTEND_URL']}/memo/${memoId}`;
      const typeName = memo.memoType?.name ?? 'Unknown';
      const buName = memo.businessUnit?.name ?? '-';
      const deptName = memo.department?.name ?? '-';

      for (const u of users) {
        if (!u.email) continue;
        const display = [u.name, u.lastname].filter(Boolean).join(' ');
        const displayName = u.nickname ? `${display} (${u.nickname})` : display || `User#${u.id}`;
        await this.mail.sendEmail(
          [u.email],
          `Memo ${memoRef}: Approved with Conditions by ${actorName}`,
          `Dear ${displayName},\n\n${actorName} has approved memo "${memoSubject}" (${memoRef}) with the following condition:\n\n"${conditionText}"\n\nMemo Type: ${typeName}\nBusiness Unit: ${buName}\nDepartment: ${deptName}\n\nView memo: ${viewLink}\n`,
          conditionEmailHtml({
            memoRef,
            memoSubject,
            displayName,
            actorName,
            conditionText,
            typeName,
            buName,
            deptName,
            viewLink,
          }),
        );
      }
    } catch (err) {
      this.logger.error(`approve-with-condition email failed: ${err}`);
    }
  }

  /** Run after the response is sent, like Express's setImmediate; never throws. */
  private later(label: string, fn: () => Promise<unknown>) {
    setImmediate(() => {
      fn().catch((e) => this.logger.error(`async ${label} failed: ${e}`));
    });
  }
}

function conditionEmailHtml(v: {
  memoRef: string;
  memoSubject: string;
  displayName: string;
  actorName: string;
  conditionText: string;
  typeName: string;
  buName: string;
  deptName: string;
  viewLink: string;
}): string {
  return `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;background:#f4f5f7;">
  <div style="max-width:600px;margin:24px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
    <div style="background:linear-gradient(135deg,#d97706,#f59e0b);padding:24px 28px;">
      <h2 style="margin:0;color:#374151;font-size:18px;">Approved with Conditions</h2>
      <p style="margin:6px 0 0;color:rgba(255,255,255,.9);font-size:13px;">${v.memoRef} — ${v.memoSubject}</p>
    </div>
    <div style="padding:24px 28px;">
      <p style="margin:0 0 16px;color:#374151;">Dear <strong>${v.displayName}</strong>,</p>
      <p style="margin:0 0 16px;color:#374151;"><strong>${v.actorName}</strong> has approved memo <strong>"${v.memoSubject}"</strong> with the following condition:</p>
      <div style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 16px;border-radius:0 8px 8px 0;margin:0 0 16px;">
        <p style="margin:0;color:#92400e;font-weight:600;font-size:13px;">Condition:</p>
        <p style="margin:6px 0 0;color:#78350f;white-space:pre-wrap;">${v.conditionText}</p>
      </div>
      <table style="width:100%;margin:0 0 16px;font-size:13px;color:#6b7280;">
        <tr><td style="padding:4px 0;"><strong>Memo Type:</strong></td><td>${v.typeName}</td></tr>
        <tr><td style="padding:4px 0;"><strong>Business Unit:</strong></td><td>${v.buName}</td></tr>
        <tr><td style="padding:4px 0;"><strong>Department:</strong></td><td>${v.deptName}</td></tr>
      </table>
      <a href="${v.viewLink}" style="display:inline-block;background:#2563eb;color:#fff;padding:10px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">View Memo</a>
    </div>
  </div>
</body>
</html>`;
}
