/**
 * MemoNotificationService (Nest) — in-app notifications + emails sent after a
 * memo changes status. Ported from backend/src/services/memoNotification.service.ts
 * (plus its helpers pushNoti, getApproverLineStatus, getPendingActions).
 *
 *   notifyStatusUpdate  → Processing / Approved / Rejected / Terminated
 *   notifyCcAssigned    → CC users when the memo enters Processing
 *   notifyRecallUpdate  → CC users when the owner recalls the memo
 *   sendEmailsAsync     → "your turn" emails with one-click approve link + signed PDF
 *
 * Email bodies are byte-identical to Express (see scripts/compare-memo-notification.js).
 * Nothing calls this yet — the approve/status/recall routes move over in Batch 8b.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ExtraStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailAttachment, MailService } from '../../common/mail/mail.service';
import { EmailPreferenceService } from '../../common/mail/email-preference.service';
import { toDisplayName } from '../memo-query/search/display-name';
import { createSignedPdfBuffer } from '../memo-pdf/pdf.core';
import { makeEmailToken } from './email-token';
import {
  StatusCode,
  appBaseUrl,
  buildCcHtml,
  buildCcPlain,
  buildHtml,
  buildPlain,
  formatExpiresAt,
  normalizeStatusCode,
  renderApproverTable,
  safeFilename,
  statusLabelFromId,
} from './memo-notification.templates';

type NotiData = Omit<
  Prisma.NotificationUncheckedCreateInput,
  'id' | 'userId' | 'actorId' | 'createdAt' | 'updatedAt'
>;

export type ApproverStatus = {
  name: string;
  level: number;
  statusCode: 'waiting' | 'approved' | 'rejected';
  /** waiting approver shown as approved because an ANY level is already satisfied */
  isLevelSatisfied?: boolean;
};

export type PendingAction = {
  actionId: number;
  userId: number;
  email: string;
  name: string;
  level?: number;
};

type ClonePivot = {
  id: number;
  userId: number | null;
  level: number;
  approvalRequirement?: string;
  user: { id: number; name: string } | null;
};

export type SendEmailsAsyncArgs = {
  receivers: number[];
  subject: string;
  message: string;
  ref: string | number;
  typeName: string;
  buName: string;
  deptName: string;
  memoId: number;
  statusId: number;
  ownerId: number;
  versionOverride?: number;
  notificationTypeSlug?: string;
};

function frontendUrl(): string {
  return process.env['FRONTEND_URL'] as string;
}

@Injectable()
export class MemoNotificationService {
  private readonly logger = new Logger(MemoNotificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly prefs: EmailPreferenceService,
  ) {}

  // ── notifyStatusUpdate ──────────────────────────────────────────────────

  async notifyStatusUpdate(
    memoId: number,
    actorId: number,
    actorName: string,
    statusId: number,
    currentLevel: number | null,
    versionOverride?: number,
    reasonOverride?: string | null,
  ): Promise<void> {
    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: {
        id: true,
        memonumber: true,
        memoNumberRecord: { select: { memonumber: true } },
        subject: true,
        memoType: { select: { name: true } },
        businessUnit: { select: { name: true } },
        department: { select: { name: true } },
        userId: true,
        approvalLineId: true,
        expiresAt: true,
      },
    });
    if (!memo) return;

    const { id, memonumber: memoNumber, subject, memoType, businessUnit, department } = memo;
    const ownerId = memo.userId;
    const typeName = memoType?.name ?? 'Unknown';
    const ref: string = memoNumber ?? memo.memoNumberRecord?.memonumber ?? `memo-${id}`;
    const buName = businessUnit?.name ?? '-';
    const deptName = department?.name ?? '-';
    const expiresAtText = formatExpiresAt(memo.expiresAt);

    this.logger.debug(`notify memo=${memoId} status=${statusId} actor=${actorId}`);

    let receivers: number[] = [];
    let message = '';

    if (statusId === 5) {
      const version = versionOverride ?? (await this.getLatestVersion(memoId));
      const waitingStat = await this.prisma.approvalActionStatus.findUnique({
        where: { code: 'waiting' },
        select: { id: true },
      });
      if (!waitingStat) return;

      const waitingRows = await this.prisma.memoApproverAction.findMany({
        where: { memoId, version, statusId: waitingStat.id },
        select: {
          loaUser: {
            select: {
              userId: true,
              level: true,
              approvalRequirement: true,
              user: { select: { name: true } },
            },
          },
        },
        orderBy: { loaUser: { level: 'asc' } },
      });
      if (!waitingRows.length) return;

      const approvedStat = await this.prisma.approvalActionStatus.findUnique({
        where: { code: 'approved' },
        select: { id: true },
      });

      // An ANY level with one approval is done — its other waiters are not "next".
      const satisfiedAnyLevels = new Set<number>();
      if (approvedStat) {
        const approvedRows = await this.prisma.memoApproverAction.findMany({
          where: { memoId, version, statusId: approvedStat.id },
          select: { loaUser: { select: { level: true, approvalRequirement: true } } },
        });
        for (const row of approvedRows) {
          if (row.loaUser.approvalRequirement === 'ANY') {
            satisfiedAnyLevels.add(row.loaUser.level);
          }
        }
      }

      const effectiveWaitingRows = waitingRows.filter(
        (w) => !satisfiedAnyLevels.has(w.loaUser.level),
      );
      if (!effectiveWaitingRows.length) return;

      const minLevel = Math.min(...effectiveWaitingRows.map((w) => w.loaUser.level));
      receivers = effectiveWaitingRows
        .filter((w) => w.loaUser.level === minLevel)
        .map((w) => w.loaUser.userId)
        .filter((uid): uid is number => uid !== null);
      message = `It's your turn to approve request "${subject}".`;
    } else if (statusId === 3) {
      const pivots = await this.getClonePivots(memoId);
      const maxLevel = Math.max(...pivots.map((p) => p.level));
      if (currentLevel === maxLevel) {
        receivers = [ownerId];
        message = `Memo "${subject}" has been approved by all approvers.`;
      } else {
        // every user at the next level, not just the first
        const nextLevel = (currentLevel ?? -1) + 1;
        const nextUserIds = pivots
          .filter((p) => p.level === nextLevel)
          .map((p) => p.userId)
          .filter((uid): uid is number => uid !== null);
        if (!nextUserIds.length) return;
        receivers = nextUserIds;
        message = `It's your turn to approve request "${subject}".`;
      }
    } else if (statusId === 4) {
      receivers = [ownerId];
      message = `${actorName} has rejected memo "${subject}".`;
    } else if (statusId === 7) {
      receivers = [ownerId];
      message = `${actorName} has terminated the approval process for memo "${subject}".`;
    } else {
      return;
    }

    receivers = Array.from(new Set(receivers));
    const isYourTurn = message.includes('turn to approve');

    let slug = 'status-approved';
    if (statusId === 5) slug = 'wait-for-your-turn';
    else if (statusId === 3) slug = isYourTurn ? 'wait-for-your-turn' : 'status-approved';
    else if (statusId === 4) slug = 'status-rejected';
    else if (statusId === 7) slug = 'status-terminated';

    await this.pushNoti(
      receivers,
      actorId,
      { notificationTypeId: 3, memoId, statusId, message },
      slug,
    );

    if ([3, 4, 7].includes(statusId)) {
      // Express wrapped this whole block so an email failure never failed the action.
      try {
        await this.sendImmediateEmails({
          memoId,
          actorId,
          actorName,
          statusId,
          receivers,
          message,
          slug,
          reasonOverride: reasonOverride ?? null,
          ownerId,
          ref,
          subject,
          typeName,
          buName,
          deptName,
          expiresAtText,
        });
      } catch (err) {
        this.logger.error(`immediate-email block failed: ${(err as Error)?.stack ?? err}`);
      }
      return;
    }

    // Processing: fire-and-forget so the approve request returns before SMTP.
    void this.sendEmailsAsync({
      receivers,
      subject,
      message,
      ref,
      typeName,
      buName,
      deptName,
      memoId,
      statusId,
      ownerId,
      versionOverride,
      notificationTypeSlug: statusId === 5 ? 'wait-for-your-turn' : 'status-approved',
    }).catch((err) => this.logger.error(`sendEmailsAsync failed: ${(err as Error)?.stack ?? err}`));
  }

  /** Approved / Rejected / Terminated emails to receivers, then CC-only users. */
  private async sendImmediateEmails(a: {
    memoId: number;
    actorId: number;
    actorName: string;
    statusId: number;
    receivers: number[];
    message: string;
    slug: string;
    reasonOverride: string | null;
    ownerId: number;
    ref: string;
    subject: string;
    typeName: string;
    buName: string;
    deptName: string;
    expiresAtText: string | null;
  }): Promise<void> {
    const { memoId, statusId, receivers, message, ref, subject } = a;

    let conditionOrReason: string | null = a.reasonOverride;
    if (!conditionOrReason) {
      const targetStatusCode =
        statusId === 3 ? 'approved' : statusId === 4 ? 'rejected' : 'terminated';
      const targetStatus = await this.prisma.approvalActionStatus.findUnique({
        where: { code: targetStatusCode },
        select: { id: true },
      });
      if (targetStatus) {
        const latestAction = await this.prisma.memoApproverAction.findFirst({
          where: { memoId, statusId: targetStatus.id, actedAt: { not: null } },
          orderBy: { actedAt: 'desc' },
          select: { approveWithCondition: true, rejectReason: true, terminationReason: true },
        });
        if (latestAction) {
          conditionOrReason =
            statusId === 3
              ? latestAction.approveWithCondition
              : statusId === 4
                ? latestAction.rejectReason
                : latestAction.terminationReason;
        }
      }
    }

    const filteredReceivers = await this.prefs.filterUsersForEmail(receivers, a.slug);
    // Express returned here, so CC users also got nothing when every receiver opted out.
    if (!filteredReceivers.length) return;

    const users = await this.prisma.user.findMany({
      where: { id: { in: filteredReceivers } },
      select: { id: true, name: true, lastname: true, nickname: true, email: true },
    });

    const commentCount = await this.prisma.comment.count({ where: { memoId } });
    const attachedCount = await this.prisma.attachedFile.count({ where: { memoId } });
    const signedPdf = await this.signedPdfOrEmpty(memoId);
    const approverTableHtml = await this.buildApproverTablesHtml(memoId);

    for (const u of users) {
      try {
        const display = toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;
        await this.mail.sendEmail(
          [u.email],
          `Notification for memo ${ref}: ${subject}`,
          buildPlain(
            display,
            message,
            ref,
            memoId,
            '#',
            '#',
            '#',
            '#',
            '#',
            a.buName,
            a.deptName,
            a.typeName,
            commentCount,
            attachedCount,
            a.expiresAtText,
            conditionOrReason,
          ),
          buildHtml(
            display,
            message,
            subject,
            ref,
            a.typeName,
            a.buName,
            a.deptName,
            approverTableHtml,
            memoId,
            statusId,
            '#',
            '#',
            '#',
            '#',
            '#',
            u.id === a.ownerId,
            commentCount,
            attachedCount,
            a.expiresAtText,
            conditionOrReason,
          ),
          message.includes('turn to approve')
            ? [
                {
                  filename: safeFilename(ref, '.pdf'),
                  content: signedPdf,
                  contentType: 'application/pdf',
                },
              ]
            : undefined,
        );
      } catch (err) {
        this.logger.error(`sendEmail failed for ${u.email}: ${(err as Error)?.message}`);
      }
    }

    // CC users who were not already notified above
    const ccUsers = await this.prisma.memoCc.findMany({
      where: { memoId },
      select: { userId: true },
    });
    const ccIdsOnly = Array.from(new Set(ccUsers.map((u) => u.userId))).filter(
      (uid) => !receivers.includes(uid),
    );
    if (!ccIdsOnly.length) return;

    const ccMsg =
      statusId === 3
        ? `Memo "${subject}" has been approved by all approvers.`
        : statusId === 7
          ? `${a.actorName} has terminated the approval process for memo "${subject}".`
          : `${a.actorName} has rejected memo "${subject}".`;
    await this.pushNoti(ccIdsOnly, a.actorId, {
      notificationTypeId: 3,
      memoId,
      statusId,
      message: ccMsg,
    });

    const statusLabel = statusId === 3 ? 'Approved' : statusId === 7 ? 'Terminated' : 'Rejected';
    const detailLines =
      statusId === 3
        ? ['All approvers have approved.']
        : statusId === 7
          ? [`Terminated by: ${a.actorName}`]
          : [`Rejected by: ${a.actorName}`];

    await this.sendCcEmails(ccIdsOnly, {
      subject: `Memo ${ref} — ${statusLabel} (CC)`,
      actorName: a.actorName,
      memoSubject: subject ?? '',
      ref,
      memoId,
      typeName: a.typeName,
      buName: a.buName,
      deptName: a.deptName,
      expiresAtText: a.expiresAtText,
      opts: { statusId, statusLabel, detailLines },
    });
  }

  // ── sendEmailsAsync ─────────────────────────────────────────────────────

  async sendEmailsAsync(args: SendEmailsAsyncArgs): Promise<void> {
    const {
      receivers,
      subject,
      message,
      ref,
      typeName,
      buName,
      deptName,
      memoId,
      statusId,
      ownerId,
      versionOverride,
      notificationTypeSlug = 'status-approved',
    } = args;

    const filteredReceivers = await this.prefs.filterUsersForEmail(receivers, notificationTypeSlug);
    if (!filteredReceivers.length) return;

    const commentCount = await this.prisma.comment.count({ where: { memoId } });
    const attachedCount = await this.prisma.attachedFile.count({ where: { memoId } });
    const memoExpireRow = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { expiresAt: true },
    });
    const expiresAtText = formatExpiresAt(memoExpireRow?.expiresAt);
    const signedPdf = await this.signedPdfOrEmpty(memoId);

    const nameRows = await this.prisma.user.findMany({
      where: { id: { in: filteredReceivers } },
      select: { id: true, name: true, lastname: true, nickname: true },
    });
    const userNameMap = new Map<number, string>(
      nameRows.map((u) => [u.id, toDisplayName(u, { includeNickname: true }) || `User#${u.id}`]),
    );

    const approverTable = await this.buildApproverTablesHtml(memoId);

    // Invalidate every outstanding one-click link for this round before issuing new ones.
    const pendings = await this.getPendingActions(memoId, versionOverride);
    if (pendings.length) {
      await this.prisma.memoApproverAction.updateMany({
        where: { id: { in: pendings.map((p) => p.actionId) } },
        data: { emailToken: null },
      });
    }

    // One email per user — at their lowest pending level.
    const uniqueActions = new Map<number, PendingAction>();
    for (const p of pendings) {
      if (!filteredReceivers.includes(p.userId)) continue;
      const existing = uniqueActions.get(p.userId);
      if (
        !existing ||
        (p.level !== undefined && existing.level !== undefined && p.level < existing.level)
      ) {
        uniqueActions.set(p.userId, p);
      }
    }

    const frontend = frontendUrl();
    await Promise.all(
      Array.from(uniqueActions.values()).map(async (p) => {
        const token = makeEmailToken(memoId, p.actionId);
        await this.prisma.memoApproverAction.update({
          where: { id: p.actionId },
          data: { emailToken: token },
        });

        const approveLink = `${appBaseUrl()}/api/memos/action/email?token=${token}&action=approve`;
        const rejectLink = `${frontend}/memo/${memoId}?action=reject`;
        const viewLink = `${frontend}/memo/${memoId}`;
        const terminateLink = `${frontend}/memo/${memoId}?action=terminate`;
        const approveWithConditionLink = `${frontend}/memo/${memoId}?action=approve-with-condition`;
        const recipientName = userNameMap.get(p.userId) ?? p.name ?? `User#${p.userId}`;

        await this.mail.sendEmail(
          [p.email],
          `Notification for memo ${ref}: ${subject}`,
          buildPlain(
            recipientName,
            message,
            ref,
            memoId,
            approveLink,
            rejectLink,
            viewLink,
            terminateLink,
            approveWithConditionLink,
            buName,
            deptName,
            typeName,
            commentCount,
            attachedCount,
            expiresAtText,
          ),
          buildHtml(
            recipientName,
            message,
            subject,
            ref,
            typeName,
            buName,
            deptName,
            approverTable,
            memoId,
            statusId,
            approveLink,
            rejectLink,
            terminateLink,
            viewLink,
            approveWithConditionLink,
            p.userId === ownerId,
            commentCount,
            attachedCount,
            expiresAtText,
          ),
          [
            {
              filename: safeFilename(typeof ref === 'number' ? String(ref) : ref, '.pdf'),
              content: signedPdf,
              contentType: 'application/pdf',
            },
          ],
        );
      }),
    );
  }

  // ── notifyCcAssigned ────────────────────────────────────────────────────

  async notifyCcAssigned(
    memoId: number,
    actorId: number,
    ccUserIds: number[],
    statusIdForNoti = 5,
  ): Promise<void> {
    if (!ccUserIds.length) return;

    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: {
        id: true,
        subject: true,
        memonumber: true,
        memoNumberRecord: { select: { memonumber: true } },
        businessUnit: { select: { name: true } },
        department: { select: { name: true } },
        memoType: { select: { name: true } },
        userId: true,
        expiresAt: true,
      },
    });
    if (!memo) return;

    const ref = memo.memonumber ?? memo.memoNumberRecord?.memonumber ?? `memo-${memo.id}`;
    const actorName = await this.getUserDisplayName(actorId);

    const detailLines: string[] = [];
    if (statusIdForNoti === 5) {
      const waiting = await this.getCurrentWaitingSummary(memoId);
      if (waiting?.names.length) {
        detailLines.push(`Waiting approver(s): ${waiting.names.join(', ')}`);
      }
    }

    await this.pushNoti(Array.from(new Set(ccUserIds)), actorId, {
      notificationTypeId: 3,
      memoId,
      statusId: statusIdForNoti,
      message:
        statusIdForNoti === 5
          ? `${actorName} CC'd you on memo "${memo.subject}" (Processing).`
          : `${actorName} CC'd you on memo "${memo.subject}".`,
    });

    const statusLabel = statusLabelFromId(statusIdForNoti);
    await this.sendCcEmails(ccUserIds, {
      subject: `Memo ${ref} — ${statusLabel} (CC)`,
      actorName,
      memoSubject: memo.subject ?? '',
      ref,
      memoId,
      typeName: memo.memoType?.name ?? 'Unknown',
      buName: memo.businessUnit?.name ?? '-',
      deptName: memo.department?.name ?? '-',
      expiresAtText: formatExpiresAt(memo.expiresAt),
      opts: { statusId: statusIdForNoti, statusLabel, detailLines },
      attachments: [],
    });
  }

  // ── notifyRecallUpdate ──────────────────────────────────────────────────

  async notifyRecallUpdate(memoId: number, actorId: number, actorName: string): Promise<void> {
    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: {
        id: true,
        subject: true,
        memonumber: true,
        userId: true,
        memoType: { select: { name: true } },
      },
    });
    if (!memo) return;

    const ref = memo.memonumber ?? memo.id;

    try {
      const ccUsers = await this.prisma.memoCc.findMany({
        where: { memoId },
        select: { userId: true },
      });
      const ccIds = Array.from(new Set(ccUsers.map((u) => u.userId)));
      if (!ccIds.length) return;

      await this.pushNoti(ccIds, actorId, {
        notificationTypeId: 3,
        memoId,
        statusId: 6,
        message: `${actorName} has recalled memo "${memo.subject}".`,
      });

      const memoDetails = await this.prisma.masterMemo.findUnique({
        where: { id: memoId },
        select: {
          businessUnit: { select: { name: true } },
          department: { select: { name: true } },
          expiresAt: true,
        },
      });

      await this.sendCcEmails(ccIds, {
        subject: `Memo ${ref} — Recalled (CC)`,
        actorName,
        memoSubject: memo.subject ?? '',
        ref,
        memoId,
        typeName: memo.memoType?.name ?? 'Unknown',
        buName: memoDetails?.businessUnit?.name ?? '-',
        deptName: memoDetails?.department?.name ?? '-',
        expiresAtText: formatExpiresAt(memoDetails?.expiresAt),
        opts: { statusId: 6, statusLabel: 'Recalled', detailLines: [`Recalled by: ${actorName}`] },
        attachments: [],
      });
    } catch (err) {
      this.logger.error(`notifyRecallUpdate failed: ${(err as Error)?.stack ?? err}`);
    }
  }

  // ── shared pieces ───────────────────────────────────────────────────────

  /**
   * Create one in-app notification per receiver. With a slug, users who turned
   * that type off are skipped (Express reused the email preference for this).
   */
  async pushNoti(
    receiverIds: number[],
    actorId: number,
    data: NotiData,
    notificationSlug?: string,
  ): Promise<void> {
    let finalReceiverIds = receiverIds;
    if (notificationSlug && receiverIds.length > 0) {
      finalReceiverIds = await this.prefs.filterUsersForEmail(receiverIds, notificationSlug);
    }
    if (finalReceiverIds.length === 0) return;

    await this.prisma.$transaction(
      finalReceiverIds.map((uid) =>
        this.prisma.notification.create({
          data: { ...data, userId: uid, actorId } as Prisma.NotificationUncheckedCreateInput,
        }),
      ),
    );
  }

  private async sendCcEmails(
    userIds: number[],
    c: {
      subject: string;
      actorName: string;
      memoSubject: string;
      ref: string | number;
      memoId: number;
      typeName: string;
      buName: string;
      deptName: string;
      expiresAtText: string | null;
      opts: { statusId: number; statusLabel: string; detailLines: string[] };
      attachments?: MailAttachment[];
    },
  ): Promise<void> {
    const filteredCcIds = await this.prefs.filterUsersForEmail(userIds, 'cc-notification');
    if (!filteredCcIds.length) return;

    const rows = await this.prisma.user.findMany({
      where: { id: { in: filteredCcIds } },
      select: { id: true, name: true, lastname: true, nickname: true, email: true },
    });
    const viewLink = `${frontendUrl()}/memo/${c.memoId}`;

    for (const u of rows) {
      if (!u.email) continue;
      const display = toDisplayName(u, { includeNickname: true }) || `User#${u.id}`;
      const args = [
        display,
        c.actorName,
        c.memoSubject,
        c.ref,
        viewLink,
        c.typeName,
        c.buName,
        c.deptName,
        c.expiresAtText,
        c.opts,
      ] as const;
      await this.mail.sendEmail(
        [u.email],
        c.subject,
        buildCcPlain(...args),
        buildCcHtml(...args),
        c.attachments,
      );
    }
  }

  private async signedPdfOrEmpty(memoId: number): Promise<Buffer> {
    try {
      return await createSignedPdfBuffer(memoId);
    } catch (err) {
      this.logger.error(`createSignedPdfBuffer failed: ${(err as Error)?.stack ?? err}`);
      return Buffer.alloc(0);
    }
  }

  async getLatestVersion(memoId: number): Promise<number> {
    const v = await this.prisma.memoApproverAction.aggregate({
      where: { memoId },
      _max: { version: true },
    });
    return v._max.version ?? 1;
  }

  async getUserDisplayName(userId: number): Promise<string> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, lastname: true, nickname: true },
    });
    return toDisplayName(u, { includeNickname: true }) || `User#${userId}`;
  }

  private async getClonePivots(memoId: number): Promise<ClonePivot[]> {
    const latestVer = await this.getLatestVersion(memoId);
    const rows = await this.prisma.memoApproverAction.findMany({
      where: { memoId, version: latestVer },
      orderBy: [{ loaUser: { level: 'asc' } }],
      distinct: ['loaUserId'],
      select: {
        loaUser: {
          select: {
            id: true,
            userId: true,
            level: true,
            approvalRequirement: true,
            user: { select: { id: true, name: true, lastname: true, nickname: true } },
          },
        },
      },
    });

    return rows.map((r) => ({
      id: r.loaUser.id,
      userId: r.loaUser.userId,
      level: r.loaUser.level,
      approvalRequirement: r.loaUser.approvalRequirement ?? 'ALL',
      user: r.loaUser.user
        ? {
            id: r.loaUser.user.id,
            name:
              toDisplayName(r.loaUser.user, { includeNickname: true }) ||
              `User#${r.loaUser.user.id}`,
          }
        : null,
    }));
  }

  private async getCurrentWaitingSummary(
    memoId: number,
  ): Promise<{ level: number; names: string[] } | null> {
    const version = await this.getLatestVersion(memoId);
    const waiting = await this.prisma.approvalActionStatus.findUnique({
      where: { code: 'waiting' },
      select: { id: true },
    });
    if (!waiting) return null;

    const rows = await this.prisma.memoApproverAction.findMany({
      where: { memoId, version, statusId: waiting.id },
      select: {
        loaUser: {
          select: {
            level: true,
            user: { select: { name: true, lastname: true, nickname: true } },
          },
        },
      },
      orderBy: { loaUser: { level: 'asc' } },
    });
    if (!rows.length) return null;

    const minLevel = Math.min(...rows.map((r) => r.loaUser.level));
    const names = rows
      .filter((r) => r.loaUser.level === minLevel)
      .map((r) => toDisplayName(r.loaUser.user, { includeNickname: true }) || 'Unknown');
    return { level: minLevel, names };
  }

  /** Waiting approver actions in a version (latest when omitted), with email. */
  async getPendingActions(memoId: number, ver?: number): Promise<PendingAction[]> {
    const targetVer = ver ?? (await this.getLatestVersion(memoId));
    const waiting = await this.prisma.approvalActionStatus.findUnique({
      where: { code: 'waiting' },
      select: { id: true },
    });
    if (!waiting) throw new Error('ไม่มี waiting status');

    const rows = await this.prisma.memoApproverAction.findMany({
      where: { memoId, version: targetVer, statusId: waiting.id },
      include: {
        loaUser: {
          select: {
            userId: true,
            level: true,
            user: { select: { email: true, name: true } },
          },
        },
      },
    });

    return rows
      .filter((r) => r.loaUser.userId !== null && r.loaUser.user !== null)
      .map((r) => ({
        actionId: r.id,
        userId: r.loaUser.userId!,
        email: r.loaUser.user!.email!,
        name: r.loaUser.user!.name,
        level: r.loaUser.level,
      }));
  }

  // ── approver tables in the email body ───────────────────────────────────

  async buildApproverTablesHtml(memoId: number): Promise<string> {
    const latestVer = await this.getLatestVersion(memoId);
    const main = await this.getApproverLineStatus(memoId, latestVer);
    const extra = await this.getActiveExtraApproversForEmail(memoId);

    const mainHtml = renderApproverTable(
      'Main approval line',
      main.map((a) => ({
        name: a.name,
        level: a.level,
        statusCode: normalizeStatusCode(a.statusCode),
        isLevelSatisfied: a.isLevelSatisfied,
      })),
    );
    const extraHtml = extra.length
      ? renderApproverTable(
          'Extra approval line',
          extra.map((e, idx) => ({
            name: e.name,
            level: idx,
            statusCode: normalizeStatusCode(e.statusCode),
            isLevelSatisfied: false,
          })),
        )
      : '';

    return mainHtml + extraHtml;
  }

  /** Ported from backend/src/approverLine.ts. */
  async getApproverLineStatus(memoId: number, ver?: number): Promise<ApproverStatus[]> {
    const actions = await this.prisma.memoApproverAction.findMany({
      where: ver !== undefined ? { memoId, version: ver } : { memoId },
      orderBy: [{ loaUser: { level: 'asc' } }, { version: 'desc' }],
      distinct: ['loaUserId'],
      select: {
        status: { select: { code: true } },
        assignedUserId: true,
        actualActorId: true,
        loaUser: {
          select: {
            level: true,
            approvalRequirement: true,
            user: {
              select: {
                id: true,
                name: true,
                lastname: true,
                nickname: true,
                delegatedToUserId: true,
                delegationStartDate: true,
                delegationEndDate: true,
                delegatedToUser: {
                  select: { id: true, name: true, lastname: true, nickname: true },
                },
              },
            },
          },
        },
        actualActor: { select: { id: true, name: true, lastname: true, nickname: true } },
      },
    });

    // Levels that already have an approval (an ANY level is then satisfied)
    const levelApproval = new Map<number, { hasApproval: boolean; requirement: string }>();
    for (const a of actions) {
      const lvl = a.loaUser.level;
      if (!levelApproval.has(lvl)) {
        levelApproval.set(lvl, {
          hasApproval: false,
          requirement: a.loaUser.approvalRequirement || 'ALL',
        });
      }
      if (a.status.code === 'approved') levelApproval.get(lvl)!.hasApproval = true;
    }

    const now = new Date();
    return actions
      .filter((a) => a.loaUser.user !== null) // unresolved flexible slots
      .map((a) => {
        const original = a.loaUser.user!;
        let displayUser: { name: string; lastname: string | null; nickname: string | null } =
          original;

        // Active delegation → show the delegate
        if (
          original.delegatedToUserId &&
          original.delegationStartDate &&
          original.delegationEndDate &&
          now >= original.delegationStartDate &&
          now <= original.delegationEndDate &&
          original.delegatedToUser
        ) {
          displayUser = original.delegatedToUser;
        }
        // Someone else actually acted → show them
        if (a.actualActorId && a.actualActor) {
          displayUser = a.actualActor;
        }

        const lvl = a.loaUser.level;
        const originalStatus = a.status.code as ApproverStatus['statusCode'];
        const levelStatus = levelApproval.get(lvl);
        const isLevelSatisfied =
          levelStatus?.requirement === 'ANY' && levelStatus.hasApproval === true;

        return {
          name: toDisplayName(displayUser, { includeNickname: true }),
          level: lvl,
          statusCode:
            originalStatus === 'waiting' && isLevelSatisfied ? 'approved' : originalStatus,
          isLevelSatisfied: originalStatus === 'waiting' && isLevelSatisfied,
        };
      });
  }

  async getActiveExtraApproversForEmail(
    memoId: number,
  ): Promise<Array<{ userId: number; name: string; statusCode: StatusCode }>> {
    const lines = await this.prisma.extraApprovalLine.findMany({
      where: { memoId },
      orderBy: { id: 'desc' },
      select: { id: true, status: true },
    });
    if (!lines.length) return [];

    const ACTIVE = new Set<ExtraStatus>(['PENDING', 'IN_PROGRESS']);
    const activeIds = lines.filter((l) => ACTIVE.has(l.status)).map((l) => l.id);
    const targetIds = activeIds.length ? activeIds : [lines[0].id];

    const rows = await this.prisma.extraApprover.findMany({
      where: { extraId: { in: targetIds } },
      select: { userId: true, actedAt: true, status: { select: { name: true } } },
      orderBy: { userId: 'asc' },
    });
    if (!rows.length) return [];

    const toCode = (r: (typeof rows)[number]): StatusCode => {
      const n = (r.status?.name ?? '').toLowerCase();
      if (n.includes('reject')) return 'rejected';
      if (n.includes('terminat')) return 'terminated';
      if (n.includes('approve') || r.actedAt) return 'approved';
      return 'waiting';
    };

    // A user on several active lines shows their most severe status.
    const severity: Record<StatusCode, number> = {
      approved: 0,
      waiting: 1,
      rejected: 2,
      terminated: 5,
    };
    const byUser = new Map<number, StatusCode>();
    for (const r of rows) {
      const code = toCode(r);
      const prev = byUser.get(r.userId);
      if (prev == null || severity[code] > severity[prev]) byUser.set(r.userId, code);
    }

    const userIds = Array.from(byUser.keys());
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, lastname: true, nickname: true },
    });
    const nameMap = new Map(
      users.map((u) => [u.id, toDisplayName(u, { includeNickname: true }) || `User#${u.id}`]),
    );
    userIds.sort((a, b) => (nameMap.get(a) ?? '').localeCompare(nameMap.get(b) ?? ''));

    return userIds.map((userId) => ({
      userId,
      name: nameMap.get(userId) ?? `User#${userId}`,
      statusCode: byUser.get(userId)!,
    }));
  }
}
