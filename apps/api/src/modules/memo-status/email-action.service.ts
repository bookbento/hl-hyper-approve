/**
 * EmailActionService (Nest) — one-click approve/terminate links in emails.
 * Ported from backend emailAction.controller.ts.
 *
 *   GET /api/memos/action/email?token=…&action=approve|reject|terminate   (no login)
 *
 * Returns an HTML page (or a redirect to the frontend for reject). The token
 * is the signed { memoId, loaActionId } from the "your turn" email and must
 * still match memoApproverAction.emailToken.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { MemoNotificationService } from '../memo-notification/memo-notification.service';
import { verifyEmailToken } from '../memo-notification/email-token';
import { MemoStatusService } from './memo-status.service';
import {
  EMAIL_ACTION_PAGES,
  UsedView,
  canceledPage,
  expiredPage,
  notProcessingPage,
  usedPage,
} from './email-action.pages';

type Code = 'approved' | 'rejected' | 'terminated';

export type EmailActionResult = { status: number; html: string } | { redirect: string };

const USED_VIEW: Record<Code, UsedView> = {
  approved: {
    title: 'This document has been already approved',
    verb: 'approved',
    bg: '#aef5b7',
    accent: '#16a34a',
  },
  rejected: {
    title: 'This document has been already Rejected',
    verb: 'rejected',
    bg: '#f0c0c0',
    accent: '#c42b2b',
  },
  terminated: {
    title: 'This document has been already Terminated',
    verb: 'terminated',
    bg: '#fae1c3',
    accent: '#b45309',
  },
};

const NOTE_STYLE =
  'margin: 1rem auto; padding: 1rem; max-width: 600px; background-color: rgba(255, 255, 255, 0.8); border-radius: 8px; text-align: left;';

function frontUrl(): string {
  const raw =
    process.env['FRONTEND_URL'] ?? process.env['FRONT_BASE_URL'] ?? 'http://172.16.8.215:5173';
  return raw.replace(/\/+$/, '');
}

function renderWithLink(
  html: string,
  memoId: number,
  condition?: string | null,
  reason?: string | null,
): string {
  let result = html
    .replace(/__MEMO_ID__/g, String(memoId))
    .replace(/__VIEW_LINK__/g, `${frontUrl()}/memos/${memoId}`);

  const conditionHtml = condition
    ? `
    <div style="${NOTE_STYLE}">
      <p style="margin: 0 0 0.5rem 0; font-weight: bold; color: #0c7f36;">Approval Condition:</p>
      <p style="margin: 0; color: #333; white-space: pre-wrap;">${condition}</p>
    </div>`
    : '';
  result = result.replace(/__CONDITION_SECTION__/g, conditionHtml);

  const reasonHtml = reason
    ? `
    <div style="${NOTE_STYLE}">
      <p style="margin: 0 0 0.5rem 0; font-weight: bold; color: #bf1e2e;">Reason:</p>
      <p style="margin: 0; color: #333; white-space: pre-wrap;">${reason}</p>
    </div>`
    : '';
  return result.replace(/__REASON_SECTION__/g, reasonHtml);
}

function noteSection(accent: string, label: string, text: string): string {
  return `
      <div style="${NOTE_STYLE}">
        <p style="margin: 0 0 0.5rem 0; font-weight: bold; color: ${accent};">${label}:</p>
        <p style="margin: 0; color: #333; white-space: pre-wrap;">${text}</p>
      </div>`;
}

@Injectable()
export class EmailActionService {
  private readonly logger = new Logger(EmailActionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: MemoNotificationService,
    private readonly status: MemoStatusService,
  ) {}

  async handle(token: unknown, rawAction: unknown): Promise<EmailActionResult> {
    const action = typeof rawAction === 'string' ? rawAction.toLowerCase() : '';
    if (
      typeof token !== 'string' ||
      !token ||
      !['approve', 'reject', 'terminate'].includes(action)
    ) {
      return { status: 400, html: 'ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว' };
    }

    const payload = verifyEmailToken(token);
    if (!payload) return { status: 400, html: '' };
    const { memoId, loaActionId: actionId } = payload;

    // Reject needs a reason, so it happens in the app.
    if (action === 'reject') {
      return { redirect: `${frontUrl()}/memo/${memoId}?action=reject&token=${token}` };
    }
    const statusCode: Code = action === 'approve' ? 'approved' : 'terminated';

    const waiting = await this.prisma.approvalActionStatus.findUnique({
      where: { code: 'waiting' },
      select: { id: true },
    });
    if (!waiting) return { status: 500, html: 'ระบบไม่พบสถานะ waiting' };

    const actionRow = await this.prisma.memoApproverAction.findUnique({
      where: { id: actionId },
      select: { emailToken: true, statusId: true, loaUserId: true },
    });
    if (!actionRow) return { status: 404, html: 'ไม่พบข้อมูลการอนุมัติ' };

    const pivot = await this.prisma.lineOfApprovalUserPivotForUse.findUnique({
      where: { id: actionRow.loaUserId },
      select: {
        userId: true,
        user: {
          select: { name: true, lastname: true, nickname: true, defaultSignatureText: true },
        },
      },
    });
    if (!pivot) return { status: 404, html: 'Approver pivot not found' };

    const actorId = pivot.userId;
    const actorName = pivot.user?.name || 'Unknown User';
    const u = pivot.user;
    const base = [u?.name, u?.lastname].filter(Boolean).join(' ').trim();
    const displayName = u?.nickname ? `${base} (${u.nickname})` : base || (u?.name ?? '');
    const signatureText = u?.defaultSignatureText?.trim() || displayName;

    if (actionRow.statusId !== waiting.id) {
      return {
        status: 400,
        html: await this.alreadyUsedPage(memoId, actionId, actionRow.statusId),
      };
    }
    if (actionRow.emailToken !== token) {
      return { status: 400, html: renderWithLink(canceledPage(), memoId) };
    }

    const memoForExpiry = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { expiresAt: true },
    });
    if (memoForExpiry?.expiresAt && new Date() > memoForExpiry.expiresAt) {
      return { status: 400, html: renderWithLink(expiredPage(action), memoId) };
    }

    const owner = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true },
    });
    if (!owner) return { status: 404, html: 'ไม่พบเอกสารนี้' };

    const stillProcessing = await this.prisma.memoStatusPivot.findUnique({
      where: { memoId_userId_statusId: { memoId, userId: owner.userId, statusId: 5 } },
    });
    if (!stillProcessing) {
      const actionText = statusCode === 'approved' ? 'approve' : 'terminate';
      return { status: 400, html: renderWithLink(notProcessingPage(actionText), memoId) };
    }

    const newStatus = await this.prisma.approvalActionStatus.findUnique({
      where: { code: statusCode },
      select: { id: true },
    });
    if (!newStatus) return { status: 500, html: 'ไม่พบสถานะปัจจุบัน' };

    await this.prisma.memoApproverAction.update({
      where: { id: actionId },
      data: { statusId: newStatus.id, actedAt: new Date(), emailToken: null, signatureText },
    });

    if (actorId) {
      await this.prisma.memoHistory.create({
        data: {
          memoId,
          userId: actorId,
          statusId: null,
          action:
            statusCode === 'approved'
              ? `${actorName} Approved the memo via email`
              : `${actorName} Terminated the memo via email`,
          timestamp: new Date(),
        },
      });
    }

    if (statusCode === 'terminated') {
      // Express then updated the action row to terminated a second time — same values.
      await this.prisma.memoStatusPivot.create({
        data: { memoId, userId: owner.userId, statusId: 7 },
      });
      if (actorId) {
        setImmediate(() => {
          this.notifications
            .notifyStatusUpdate(memoId, actorId, actorName, 7, null)
            .catch((e) => this.logger.error(`[emailAction] terminate notify failed: ${e}`));
        });
      }
      return { status: 200, html: renderWithLink(EMAIL_ACTION_PAGES.terminated, memoId) };
    }

    this.status
      .evaluateAndUpdateMemoStatus(memoId, actionRow.loaUserId)
      .catch((err) =>
        this.logger.error(
          `[emailAction] evaluateAndUpdateMemoStatus error for memo ${memoId}: ${err}`,
        ),
      );

    const actionData = await this.prisma.memoApproverAction.findUnique({
      where: { id: actionId },
      select: { approveWithCondition: true },
    });
    return {
      status: 200,
      html: renderWithLink(
        EMAIL_ACTION_PAGES.approved,
        memoId,
        actionData?.approveWithCondition ?? null,
        null,
      ),
    };
  }

  /** The row was already approved/rejected/terminated (in the app or by an earlier click). */
  private async alreadyUsedPage(memoId: number, actionId: number, statusId: number) {
    const used = await this.prisma.approvalActionStatus.findUnique({
      where: { id: statusId },
      select: { code: true },
    });
    const data = await this.prisma.memoApproverAction.findUnique({
      where: { id: actionId },
      select: { approveWithCondition: true, rejectReason: true, terminationReason: true },
    });

    const key = (used?.code as Code) ?? 'approved';
    const v = USED_VIEW[key];

    let extra = '';
    if (key === 'approved' && data?.approveWithCondition) {
      extra = noteSection(v.accent, 'Approval Condition', data.approveWithCondition);
    } else if (key === 'rejected' && data?.rejectReason) {
      extra = noteSection(v.accent, 'Reject Reason', data.rejectReason);
    } else if (key === 'terminated' && data?.terminationReason) {
      extra = noteSection(v.accent, 'Termination Reason', data.terminationReason);
    }
    return renderWithLink(usedPage(v, extra), memoId);
  }
}
