/**
 * MemoRecallService (Nest) — recall workflows.
 * Ported from backend memoRecall.service.ts.
 *
 *   POST /api/memos/:id/recall           — legacy recall (no status gate; wipes Processing history)
 *   POST /api/memos/:id/recall-preserve  — status-gated, keeps approvals
 *   POST /api/memos/:id/recall-clear     — status-gated, resets approvals + deletes extra lines
 *   handleRecall                         — `recalled` branch of POST /api/memos/:id/action
 *
 * The actor is the logged-in user (Express took `userId` from the body on
 * /recall and /recall-preserve) and must be able to view the memo.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ActionType, ExtraStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoAccessService } from '../memo-query/memo-access.service';
import { MemoSearchNestService } from '../memo-query/memo-search.service';
import { MemoNotificationService } from '../memo-notification/memo-notification.service';
import { STATUS, STATUS_CHANGED_KEY, setCurrentStatusTx } from './memo-status.helpers';
import { LATEST_STATUS_ORDER } from '../../common/latest-status-order';

@Injectable()
export class MemoRecallService {
  private readonly logger = new Logger(MemoRecallService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly memoAccess: MemoAccessService,
    private readonly search: MemoSearchNestService,
    private readonly notifications: MemoNotificationService,
  ) {}

  // ── POST /api/memos/:id/recall ─────────────────────────────────────────

  async recallLegacy(memoId: number, userId: number) {
    if (Number.isNaN(memoId)) throw new BadRequestException({ error: 'Invalid memoId or userId' });
    await this.assertCanView(userId, memoId);

    try {
      await this.prisma.memoStatusPivot.create({
        data: { memoId, userId, statusId: STATUS.RECALL },
      });

      await this.resetActionsInCurrentVersion(memoId);
      await this.prisma.memoStatusPivot.deleteMany({
        where: { memoId, statusId: STATUS.PROCESSING },
      });
      await this.prisma.memoHistory.deleteMany({
        where: { memoId, statusId: STATUS.PROCESSING },
      });

      // Soft-reset active extra lines back to PENDING.
      const active = await this.prisma.extraApprovalLine.findMany({
        where: { memoId, status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] } },
        select: { id: true },
      });
      if (active.length > 0) {
        const lineIds = active.map((l) => l.id);
        await this.prisma.$transaction([
          this.prisma.extraApprovalLine.updateMany({
            where: { id: { in: lineIds } },
            data: { status: ExtraStatus.PENDING, closedAt: null },
          }),
          this.prisma.extraApprover.updateMany({
            where: { extraId: { in: lineIds } },
            data: { statusId: null, actedAt: null },
          }),
        ]);
      }
      this.search.invalidateAll();

      return {
        message: 'Memo recalled; previous approvals cleared (including Extra waiting reset).',
      };
    } catch (err) {
      this.logger.error(`recallMemo failed: ${err}`);
      throw new InternalServerErrorException({ error: 'Recall failed' });
    }
  }

  // ── POST /api/memos/:id/recall-preserve ────────────────────────────────

  async recallPreserve(memoId: number, userId: number, rawFileId: unknown) {
    const fileId = rawFileId ? Number(rawFileId) : undefined;
    await this.assertCanView(userId, memoId);
    await this.assertRecallable(memoId, userId, 'recallPreserve');

    const userRec = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    const userName = userRec?.name ?? `User#${userId}`;

    const prevStatus = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: { id: 'desc' },
      select: { statusId: true },
    });
    const prevStatusId = prevStatus?.statusId ?? 0;

    await this.prisma.memoStatusPivot.deleteMany({
      where: { memoId, statusId: { in: [STATUS.APPROVED, STATUS.REJECTED, STATUS.PROCESSING] } },
    });
    await this.setStatus(memoId, userId, STATUS.RECALL);
    await this.setStatus(memoId, userId, STATUS.DRAFT);

    await this.prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        fileId,
        statusId: prevStatusId,
        action: `${userName} recalled memo (preserve)`,
        actiontype: ActionType.RECALL,
        timestamp: new Date(),
      },
    });
    await this.prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        fileId,
        statusId: STATUS.RECALL,
        action: `${userName} set memo back to Draft (preserve)`,
        actiontype: ActionType.RECALL,
        timestamp: new Date(),
      },
    });

    this.notifyLater(memoId, userId, userName);
    return { message: 'Recall (preserve) done' };
  }

  // ── POST /api/memos/:id/recall-clear ───────────────────────────────────

  async recallClear(memoId: number, actorId: number, rawFileId: unknown) {
    const fileId = rawFileId ? Number(rawFileId) : undefined;
    if (!Number.isFinite(memoId)) throw new BadRequestException({ error: 'invalid memoId' });
    await this.assertCanView(actorId, memoId);
    await this.assertRecallable(memoId, actorId, 'recallClear');

    try {
      const [rejectedId, recallId, draftId, userName] = await Promise.all([
        this.getStatusIdByName('Rejected'),
        this.getStatusIdByName('Recalled'),
        this.getStatusIdByName('Draft'),
        this.notifications.getUserDisplayName(actorId),
      ]);
      const owner = await this.prisma.masterMemo.findUnique({
        where: { id: memoId },
        select: { userId: true },
      });
      if (!owner) throw new Error(`memo ${memoId} not found`);

      const result = await this.prisma.$transaction(async (tx) => {
        const prev = await tx.memoStatusPivot.findFirst({
          where: { memoId, userId: owner.userId },
          orderBy: LATEST_STATUS_ORDER,
          select: { statusId: true },
        });
        const prevStatusId = prev?.statusId ?? 0;

        const [extraLineRejected, extraApproverRejected] = await Promise.all([
          tx.extraApprovalLine
            .count({ where: { memoId, status: ExtraStatus.REJECTED } })
            .then((c) => c > 0),
          tx.extraApprover
            .count({ where: { extra: { memoId }, statusId: rejectedId } })
            .then((c) => c > 0),
        ]);
        const isRevise = prevStatusId === rejectedId || extraLineRejected || extraApproverRejected;

        // Runs outside tx, as in Express.
        const currentVersion = await this.resetActionsInCurrentVersion(memoId);

        await this.touchPivot(tx, memoId, owner.userId, recallId);
        await this.touchPivot(tx, memoId, owner.userId, draftId);

        const extraLineIds = (
          await tx.extraApprovalLine.findMany({ where: { memoId }, select: { id: true } })
        ).map((r) => r.id);
        if (extraLineIds.length > 0) {
          await tx.comment.updateMany({
            where: { extraApprovalLineId: { in: extraLineIds } },
            data: { isRecallExtra: true, extraApprovalLineId: null },
          });
          await tx.extraApprover.deleteMany({ where: { extraId: { in: extraLineIds } } });
          await tx.extraApprovalLine.deleteMany({ where: { id: { in: extraLineIds } } });
          await tx.memoHistory.create({
            data: {
              memoId,
              userId: actorId,
              actiontype: ActionType.UPDATE,
              action: `The Extra Approval line was removed due to the recall process`,
              fileId,
              timestamp: new Date(),
            },
          });
        }

        await tx.memoHistory.create({
          data: {
            memoId,
            userId: actorId,
            fileId,
            statusId: prevStatusId || undefined,
            action: isRevise ? `${userName} revised the memo` : `${userName} recalled the memo`,
            actiontype: isRevise ? ActionType.REVISE : ActionType.RECALL,
            timestamp: new Date(),
          },
        });

        return { currentVersion, removedExtraLines: extraLineIds.length };
      });
      this.search.invalidateAll();

      this.notifyLater(memoId, actorId, userName);
      return {
        message: `Recall done on version ${result.currentVersion}`,
        removedExtraLines: result.removedExtraLines,
        performedBy: { id: actorId, name: userName },
      };
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`recall error: ${err}`);
      throw new InternalServerErrorException({ error: 'internal error' });
    }
  }

  // ── `recalled` via POST /api/memos/:id/action ──────────────────────────

  /**
   * Reset waiting/rejected actions (approved stay) and move the approver's
   * pivot row Recall(6) → Draft(1).
   */
  async handleRecall({ memoId, loaUserId }: { memoId: number; loaUserId: number }) {
    await this.resetActionsInCurrentVersion(memoId, { only: 'waiting_or_rejected' });

    await this.prisma.$transaction(async (tx) => {
      const bump = async (newStatusId: number) => {
        await tx.memoStatusPivot.deleteMany({
          where: { memoId, userId: loaUserId, statusId: newStatusId },
        });
        const cur = await tx.memoStatusPivot.findFirst({
          where: { memoId, userId: loaUserId },
          orderBy: LATEST_STATUS_ORDER,
          select: { id: true },
        });
        if (cur) {
          await tx.memoStatusPivot.update({
            where: { id: cur.id },
            data: { statusId: newStatusId, createdAt: new Date() },
          });
        } else {
          await tx.memoStatusPivot.create({
            data: { memoId, userId: loaUserId, statusId: newStatusId },
          });
        }
      };
      await bump(STATUS.RECALL);
      await bump(STATUS.DRAFT);
    });
    this.search.invalidateAll();
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Only Processing (5) or Rejected (4) memos can be recalled. */
  private async assertRecallable(memoId: number, userId: number, op: string) {
    const current = await this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      orderBy: LATEST_STATUS_ORDER,
      select: { statusId: true },
    });
    const currentStatusId = current?.statusId ?? 0;
    if (currentStatusId === STATUS.PROCESSING || currentStatusId === STATUS.REJECTED) return;

    this.logger.warn(`[${op}] BLOCKED: memoId=${memoId} status=${currentStatusId} user=${userId}`);
    throw new ConflictException({
      code: 'MEMO_STATUS_CHANGED',
      statusCode: STATUS_CHANGED_KEY[currentStatusId] ?? 'UNKNOWN',
      currentStatusId,
    });
  }

  private async assertCanView(userId: number, memoId: number): Promise<void> {
    if (!(await this.memoAccess.canViewMemo(userId, memoId))) {
      throw new ForbiddenException({ error: 'Access denied' });
    }
  }

  private async setStatus(memoId: number, userId: number, statusId: number) {
    await this.prisma.$transaction((tx) => setCurrentStatusTx(tx, memoId, userId, statusId));
    this.search.invalidateAll();
  }

  /** Upsert the pivot row and bump createdAt so it sorts as latest. */
  private async touchPivot(
    tx: Prisma.TransactionClient,
    memoId: number,
    userId: number,
    statusId: number,
  ) {
    await tx.memoStatusPivot.upsert({
      where: { memoId_userId_statusId: { memoId, userId, statusId } },
      create: { memoId, userId, statusId },
      update: { createdAt: new Date() },
    });
  }

  /** "Recall" and "Recalled" are aliases in the Status table. */
  private async getStatusIdByName(name: string): Promise<number> {
    const aliases = new Set<string>([name]);
    if (/^recall(ed)?$/i.test(name)) {
      aliases.add('Recall');
      aliases.add('Recalled');
    }
    const row = await this.prisma.status.findFirst({
      where: { name: { in: Array.from(aliases) } },
      select: { id: true },
    });
    if (!row) throw new Error(`Status not found: ${name}`);
    return row.id;
  }

  /**
   * Reset the latest version's approver actions to waiting (all of them, or
   * only waiting/rejected ones). Returns that version.
   */
  private async resetActionsInCurrentVersion(
    memoId: number,
    opts?: { only?: 'waiting_or_rejected' },
  ): Promise<number> {
    const waiting = await this.prisma.approvalActionStatus.findUnique({
      where: { code: 'waiting' },
      select: { id: true },
    });
    if (!waiting) throw new Error("approvalActionStatus 'waiting' not found in DB");

    const currentVersion = await this.notifications.getLatestVersion(memoId);
    await this.prisma.memoApproverAction.updateMany({
      where: {
        memoId,
        version: currentVersion,
        ...(opts?.only === 'waiting_or_rejected'
          ? { status: { code: { in: ['waiting', 'rejected'] } } }
          : {}),
      },
      data: {
        statusId: waiting.id,
        actedAt: null,
        signatureImageId: null,
        signatureText: null,
        emailToken: null,
        approveWithCondition: null,
      },
    });
    return currentVersion;
  }

  private notifyLater(memoId: number, actorId: number, actorName: string) {
    setImmediate(() => {
      this.notifications
        .notifyRecallUpdate(memoId, actorId, actorName)
        .catch((e) => this.logger.error(`notifyRecallUpdate failed: ${e}`));
    });
  }
}
