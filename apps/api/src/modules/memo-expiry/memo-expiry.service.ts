/**
 * MemoExpiryService (Nest) — the per-minute memo expiry sweep.
 * Ported from backend/src/lib/memo-expiry.ts (sweepMemoExpiryOnce).
 *
 * For every memo with an `expiresAt`:
 *   - 3, 2, 1 Thai days before (at the expiry's minute-of-day) → remind the owner
 *     and current approvers, once per day, while the memo is Processing
 *   - once expired → add an Expired status pivot (unless already final), then
 *     notify owner + current approvers + CC if it was still Processing
 *
 * "Current approvers" = waiting approvers on an active extra line if any,
 * otherwise the lowest waiting level of the main line (latest version).
 */
import { Injectable, Logger } from '@nestjs/common';
import { ActionType, ExtraStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { EmailPreferenceService } from '../../common/mail/email-preference.service';
import { MemoSearchNestService } from '../memo-query/memo-search.service';
import { daysLeftTH, getExpiryStateTH, ymdTH } from './memo-expiry.time';
import { buildExpiryHtml, buildExpiryPlain, inDaysPhrase } from './memo-expiry.templates';
import { LATEST_STATUS_ORDER } from '../../common/latest-status-order';

// Latest status ids/names that mean "finished" — never flipped to Expired.
const FINAL_STATUS_IDS = [3, 7, 9]; // Approved, Terminated, Deleted
const FINAL_STATUS_NAMES = ['approved', 'terminated', 'deleted'];
const EXPIRY_NOTIFICATION_TYPE_ID = 2;

/** Status ids looked up once per sweep (Express looked them up per memo). */
type SweepIds = { waiting: number | null; expired: number | null };

type SweepMemo = {
  id: number;
  userId: number;
  subject: string | null;
  memonumber: string | null;
  expiresAt: Date | null;
};

@Injectable()
export class MemoExpiryService {
  private readonly logger = new Logger(MemoExpiryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly emailPrefs: EmailPreferenceService,
    private readonly search: MemoSearchNestService,
  ) {}

  private get frontendUrl(): string {
    return (process.env['FRONTEND_URL'] || '').replace(/\/+$/, '') || 'http://localhost:5173';
  }

  async sweepOnce(now = new Date()): Promise<void> {
    const memos = await this.prisma.masterMemo.findMany({
      where: { expiresAt: { not: null } },
      select: { id: true, userId: true, subject: true, memonumber: true, expiresAt: true },
    });

    let ids: SweepIds | null = null;
    for (const m of memos) {
      try {
        if (!m.expiresAt) continue;
        const state = getExpiryStateTH(m.expiresAt, now);
        if (!state) continue;

        ids ??= await this.lookupIds();
        if (state === '3d') await this.handleReminder(m, m.expiresAt, now, ids);
        else await this.handleExpired(m, m.expiresAt, now, ids);
      } catch (err) {
        this.logger.error(`memo ${m.id} failed: ${(err as Error)?.stack ?? err}`);
      }
    }
  }

  // ── "3d" → reminder ───────────────────────────────────────────────────────

  private async handleReminder(m: SweepMemo, expiresAt: Date, now: Date, ids: SweepIds) {
    if (!(await this.isProcessing(m.id))) return;

    const dleft = daysLeftTH(expiresAt, now); // 1..3
    const key = `3d-${dleft}:${ymdTH(now)}`;
    if (await this.wasNotified(m.id, key, expiresAt)) return;

    const toIds = await this.recipients(m.id, ids, false);
    if (!toIds.length) return;

    const ref = m.memonumber ?? `#${m.id}`;
    const subject = m.subject || '(No subject)';
    const url = `${this.frontendUrl}/memo/${m.id}`;
    const sent = await this.emailUsers(
      toIds,
      `[Memo Expiry] ${ref} – will expire ${inDaysPhrase(dleft)}`,
      buildExpiryHtml(subject, ref, url, '3d', dleft),
      buildExpiryPlain(subject, ref, url, '3d', dleft),
    );
    const noti = await this.pushNoti(
      m.id,
      m.userId,
      toIds,
      `Memo "${m.subject || `#${m.id}`}" will expire ${inDaysPhrase(dleft)}.`,
      'near-expiry',
    );

    if (sent > 0 || noti > 0) {
      await this.markNotified(
        m.id,
        m.userId,
        key,
        `Notification: memo will expire ${inDaysPhrase(dleft)}`,
      );
    }
  }

  // ── "expired" ─────────────────────────────────────────────────────────────

  private async handleExpired(m: SweepMemo, expiresAt: Date, now: Date, ids: SweepIds) {
    // Read before marking: only a memo that was still Processing gets emails.
    const wasProcessing = await this.isProcessing(m.id);

    await this.markExpiredStatus(m.id, m.userId, ids.expired);
    if (!wasProcessing) return;

    // No "[expiry:expired]" row is ever written (the Expired history row above
    // is the record), so in practice the Expired pivot is what stops repeats.
    if (await this.wasNotified(m.id, 'expired', expiresAt)) return;

    const toIds = await this.recipients(m.id, ids, true);
    if (!toIds.length) return;

    const ref = m.memonumber ?? `#${m.id}`;
    const subject = m.subject || '(No subject)';
    const url = `${this.frontendUrl}/memo/${m.id}`;
    const sent = await this.emailUsers(
      toIds,
      `[Memo Expired] ${ref}`,
      buildExpiryHtml(subject, ref, url, 'expired'),
      buildExpiryPlain(subject, ref, url, 'expired'),
    );
    const noti = await this.pushNoti(
      m.id,
      m.userId,
      toIds,
      `Memo "${m.subject || `#${m.id}`}" has expired.`,
      'status-expired',
    );
    if (sent > 0 || noti > 0) this.logger.log(`Notified for memo ${m.id} (expired)`);
  }

  // ── DB helpers ────────────────────────────────────────────────────────────

  private async lookupIds(): Promise<SweepIds> {
    const [waiting, expired] = await Promise.all([
      this.prisma.approvalActionStatus.findFirst({
        where: { code: { in: ['waiting', 'WAITING', 'Waiting'] } },
        select: { id: true },
      }),
      this.prisma.status.findFirst({
        where: { OR: [{ name: 'Expired' }, { name: 'expired' }, { name: 'EXPIRED' }] },
        select: { id: true },
      }),
    ]);
    if (!waiting) this.logger.warn('approvalActionStatus "waiting" not found; skip waiting-logic');
    return { waiting: waiting?.id ?? null, expired: expired?.id ?? null };
  }

  private latestPivot(memoId: number) {
    return this.prisma.memoStatusPivot.findFirst({
      where: { memoId },
      include: { status: true },
      orderBy: LATEST_STATUS_ORDER,
    });
  }

  private async isProcessing(memoId: number): Promise<boolean> {
    const latest = await this.latestPivot(memoId);
    return (latest?.status?.name || '').toLowerCase() === 'processing';
  }

  private async markExpiredStatus(memoId: number, ownerId: number | null, expiredId: number | null) {
    if (!expiredId) return;

    const [latest, master] = await Promise.all([
      this.latestPivot(memoId),
      this.prisma.masterMemo.findUnique({ where: { id: memoId }, select: { userId: true } }),
    ]);
    const latestName = (latest?.status?.name || '').toLowerCase();

    if ((latest && FINAL_STATUS_IDS.includes(latest.statusId)) || FINAL_STATUS_NAMES.includes(latestName)) {
      return;
    }
    if (latest?.statusId === expiredId || latestName === 'expired') return;

    const userId = ownerId ?? latest?.userId ?? master?.userId ?? 0;
    if (!userId) return;

    const created = await this.prisma.$transaction(async (tx) => {
      // (memoId, userId, statusId) is unique — skip if this user already has an Expired row.
      const existing = await tx.memoStatusPivot.findFirst({
        where: { memoId, userId, statusId: expiredId },
      });
      if (existing) return false;

      await tx.memoStatusPivot.create({ data: { memoId, statusId: expiredId, userId } });
      await tx.memoHistory.create({
        data: {
          memoId,
          userId,
          statusId: expiredId,
          action: `The memo has expired`,
          actiontype: ActionType.UPDATE,
        },
      });
      return true;
    });
    if (created) this.search.invalidateAll();
  }

  private async wasNotified(memoId: number, key: string, expiresAt: Date): Promise<boolean> {
    const row = await this.prisma.memoHistory.findFirst({
      where: { memoId, action: { contains: `[expiry:${key}]` } },
      select: { id: true, timestamp: true },
      orderBy: { id: 'desc' },
    });
    if (!row) return false;
    if (key === 'expired') return row.timestamp.getTime() >= expiresAt.getTime();
    return true; // 3d-*: once per day (the date is part of the key)
  }

  private async markNotified(memoId: number, actorId: number | null, key: string, display: string) {
    const owner = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true },
    });
    const userId = actorId ?? owner?.userId ?? 0;
    if (!userId) return;

    await this.prisma.memoHistory.create({
      data: {
        memoId,
        userId,
        action: `[expiry:${key}] ${display}`,
        actiontype: ActionType.UPDATE,
        timestamp: new Date(),
      },
    });
  }

  /** Owner + current approvers (+ CC when `withCc`). */
  private async recipients(memoId: number, ids: SweepIds, withCc: boolean): Promise<number[]> {
    const out = new Set<number>();

    const memo = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true },
    });
    if (memo?.userId) out.add(memo.userId);

    // An active extra line with someone still waiting takes over from the main line.
    const activeExtra = await this.prisma.extraApprovalLine.findMany({
      where: { memoId, status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] } },
      select: { approvers: { select: { userId: true, statusId: true } } },
    });
    const extraWaiting = activeExtra.flatMap((l) => l.approvers.filter((a) => a.statusId == null));

    if (extraWaiting.length > 0) {
      extraWaiting.forEach((a) => out.add(a.userId));
    } else if (ids.waiting) {
      const { _max } = await this.prisma.memoApproverAction.aggregate({
        where: { memoId },
        _max: { version: true },
      });
      const waiting = await this.prisma.memoApproverAction.findMany({
        where: { memoId, version: _max.version ?? 1, statusId: ids.waiting },
        include: { loaUser: { select: { userId: true, level: true } } },
        orderBy: { loaUser: { level: 'asc' } },
      });
      if (waiting.length) {
        const minLv = Math.min(...waiting.map((w) => w.loaUser.level));
        for (const w of waiting) {
          if (w.loaUser.level === minLv && w.loaUser.userId !== null) out.add(w.loaUser.userId);
        }
      }
    }

    if (withCc) {
      const ccs = await this.prisma.memoCc.findMany({ where: { memoId }, select: { userId: true } });
      ccs.forEach((c) => out.add(c.userId));
    }

    return Array.from(out);
  }

  // ── Email + in-app notification ───────────────────────────────────────────

  /** Sends one email per user; returns how many SMTP accepted. */
  private async emailUsers(userIds: number[], subject: string, html: string, text: string) {
    // Expiry emails follow the "wait-for-your-turn" email preference (as in Express).
    const allowed = await this.emailPrefs.filterUsersForEmail(userIds, 'wait-for-your-turn');
    if (!allowed.length) return 0;

    const users = await this.prisma.user.findMany({
      where: { id: { in: allowed } },
      select: { id: true, email: true },
    });
    const recipients = users.filter((u) => !!u.email);
    if (!recipients.length) return 0;

    this.logger.log(
      `email -> ${recipients.length} user(s). subject="${subject}" recipients: ${recipients
        .map((u) => `${u.id}:${u.email}`)
        .join(', ')}`,
    );

    let ok = 0;
    const failed: string[] = [];
    for (const u of recipients) {
      try {
        const info: any = await this.mail.sendEmail([u.email!], subject, text, html, []);
        if (Array.isArray(info?.accepted) && info.accepted.length > 0) ok++;
        else failed.push(`${u.id}:${u.email} (smtp rejected)`);
      } catch (err) {
        failed.push(`${u.id}:${u.email} (${(err as Error)?.message || 'send error'})`);
      }
    }
    if (failed.length) this.logger.warn(`failed: ${failed.join(', ')}`);
    return ok;
  }

  private async pushNoti(
    memoId: number,
    actorId: number | null,
    userIds: number[],
    message: string,
    notificationSlug: string,
  ): Promise<number> {
    const owner = await this.prisma.masterMemo.findUnique({
      where: { id: memoId },
      select: { userId: true },
    });
    const actor = actorId ?? owner?.userId ?? 0;
    if (!actor) return 0;

    // In-app notifications also honour the per-type email opt-out (Express behaviour).
    const finalUserIds = await this.emailPrefs.filterUsersForEmail(userIds, notificationSlug);
    if (!finalUserIds.length) return 0;

    const result = await this.prisma.notification.createMany({
      data: finalUserIds.map((uid) => ({
        memoId,
        userId: uid,
        actorId: actor,
        notificationTypeId: EXPIRY_NOTIFICATION_TYPE_ID,
        message,
      })),
    });
    return result.count;
  }
}
