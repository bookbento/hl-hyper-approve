import { ExtraStatus } from '@prisma/client';
import { MemoExpiryService } from './memo-expiry.service';

const th = (s: string) => new Date(`${s}+07:00`);
const EXPIRED = 10;
const WAITING = 1;

function makePrisma() {
  const p: any = {
    masterMemo: { findUnique: jest.fn().mockResolvedValue({ userId: 1 }) },
    $queryRaw: jest.fn(),
    memoStatusPivot: {
      // latest-status lookups; the (memo, user, Expired) existence check inside the tx finds nothing
      findFirst: jest.fn(({ where }: any) =>
        Promise.resolve(
          where.statusId ? null : { statusId: 5, userId: 1, status: { name: 'Processing' } },
        ),
      ),
      create: jest.fn(),
    },
    memoHistory: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
    approvalActionStatus: { findFirst: jest.fn().mockResolvedValue({ id: WAITING }) },
    status: { findFirst: jest.fn().mockResolvedValue({ id: EXPIRED }) },
    extraApprovalLine: { findMany: jest.fn().mockResolvedValue([]) },
    memoApproverAction: {
      aggregate: jest.fn().mockResolvedValue({ _max: { version: 2 } }),
      findMany: jest.fn().mockResolvedValue([
        { loaUser: { userId: 20, level: 1 } },
        { loaUser: { userId: 21, level: 1 } },
        { loaUser: { userId: 30, level: 2 } },
      ]),
    },
    memoCc: { findMany: jest.fn().mockResolvedValue([{ userId: 40 }]) },
    user: {
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(where.id.in.map((id: number) => ({ id, email: `u${id}@x.test` }))),
      ),
    },
    notification: { createMany: jest.fn(({ data }: any) => Promise.resolve({ count: data.length })) },
  };
  p.$transaction = jest.fn((fn: any) => fn(p));
  return p;
}

describe('MemoExpiryService', () => {
  let prisma: any;
  let mail: any;
  let prefs: any;
  let search: any;
  let service: MemoExpiryService;

  const memo = (expiresAt: Date, extra: object = {}) => ({
    id: 7,
    userId: 1,
    subject: 'Budget',
    memonumber: 'MN-1',
    expiresAt,
    ...extra,
  });
  const sentTo = () => mail.sendEmail.mock.calls.map((c: any[]) => c[0][0]);

  beforeEach(() => {
    process.env['FRONTEND_URL'] = 'https://fe.test/';
    prisma = makePrisma();
    mail = { sendEmail: jest.fn().mockResolvedValue({ accepted: ['x'] }) };
    prefs = { filterUsersForEmail: jest.fn((ids: number[]) => Promise.resolve(ids)) };
    search = { invalidateAll: jest.fn() };
    service = new MemoExpiryService(prisma, mail, prefs, search);
  });

  it('does nothing (and skips status lookups) when no memo is due', async () => {
    prisma.$queryRaw.mockResolvedValue([memo(th('2026-12-01T10:00:00'))]);
    await service.sweepOnce(th('2026-10-15T10:00:00'));
    expect(prisma.status.findFirst).not.toHaveBeenCalled();
    expect(mail.sendEmail).not.toHaveBeenCalled();
  });

  describe('3-day reminder', () => {
    const now = th('2026-10-18T10:00:00');
    beforeEach(() => prisma.$queryRaw.mockResolvedValue([memo(th('2026-10-20T10:00:00'))]));

    it('emails owner + lowest waiting level, notifies and records the daily key', async () => {
      await service.sweepOnce(now);

      expect(prisma.memoApproverAction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { memoId: 7, version: 2, statusId: WAITING } }),
      );
      expect(sentTo()).toEqual(['u1@x.test', 'u20@x.test', 'u21@x.test']);
      const [, subject, text, html] = mail.sendEmail.mock.calls[0];
      expect(subject).toBe('[Memo Expiry] MN-1 – will expire in 2 days');
      expect(text).toContain('This memo will expire in 2 days.');
      expect(text).toContain('Open memo: https://fe.test/memo/7');
      expect(html).toContain('<b>expire in 2 days</b>');
      expect(prefs.filterUsersForEmail).toHaveBeenCalledWith([1, 20, 21], 'wait-for-your-turn');
      expect(prefs.filterUsersForEmail).toHaveBeenCalledWith([1, 20, 21], 'near-expiry');
      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [1, 20, 21].map((userId) => ({
          memoId: 7,
          userId,
          actorId: 1,
          notificationTypeId: 2,
          message: 'Memo "Budget" will expire in 2 days.',
        })),
      });
      expect(prisma.memoHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          memoId: 7,
          userId: 1,
          action: '[expiry:3d-2:2026-10-18] Notification: memo will expire in 2 days',
        }),
      });
      expect(prisma.memoStatusPivot.create).not.toHaveBeenCalled();
    });

    it('only notifies waiting extra approvers when an extra line is active', async () => {
      prisma.extraApprovalLine.findMany.mockResolvedValue([
        { approvers: [{ userId: 50, statusId: null }, { userId: 51, statusId: 2 }] },
      ]);
      await service.sweepOnce(now);
      expect(prisma.extraApprovalLine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { memoId: 7, status: { in: [ExtraStatus.PENDING, ExtraStatus.IN_PROGRESS] } },
        }),
      );
      expect(sentTo()).toEqual(['u1@x.test', 'u50@x.test']);
      expect(prisma.memoApproverAction.findMany).not.toHaveBeenCalled();
    });

    it('skips memos that are not Processing or were already reminded today', async () => {
      prisma.memoStatusPivot.findFirst.mockResolvedValueOnce({ statusId: 1, status: { name: 'Draft' } });
      await service.sweepOnce(now);
      prisma.memoHistory.findFirst.mockResolvedValueOnce({ id: 1, timestamp: new Date() });
      await service.sweepOnce(now);
      expect(mail.sendEmail).not.toHaveBeenCalled();
    });

    it('does not record the key when nothing was delivered', async () => {
      mail.sendEmail.mockResolvedValue(undefined); // MailService swallowed an SMTP error
      prefs.filterUsersForEmail.mockResolvedValue([]);
      await service.sweepOnce(now);
      expect(prisma.memoHistory.create).not.toHaveBeenCalled();
    });
  });

  describe('expired', () => {
    const now = th('2026-10-20T10:05:00');
    beforeEach(() => prisma.$queryRaw.mockResolvedValue([memo(th('2026-10-20T10:00:00'))]));

    it('adds the Expired pivot + history, then emails owner, approvers and CC', async () => {
      await service.sweepOnce(now);

      expect(prisma.memoStatusPivot.create).toHaveBeenCalledWith({
        data: { memoId: 7, statusId: EXPIRED, userId: 1 },
      });
      expect(prisma.memoHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ statusId: EXPIRED, action: 'The memo has expired' }),
      });
      expect(search.invalidateAll).toHaveBeenCalled();
      expect(sentTo()).toEqual(['u1@x.test', 'u20@x.test', 'u21@x.test', 'u40@x.test']);
      expect(mail.sendEmail.mock.calls[0][1]).toBe('[Memo Expired] MN-1');
      expect(prefs.filterUsersForEmail).toHaveBeenCalledWith([1, 20, 21, 40], 'status-expired');
      expect(prisma.memoHistory.create).toHaveBeenCalledTimes(2);
      expect(prisma.memoHistory.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({ action: '[expiry:expired] Notification: memo has expired' }),
      });
    });

    it('without an "Expired" status, notifies once instead of every minute', async () => {
      prisma.status.findFirst.mockResolvedValue(null);
      await service.sweepOnce(now);
      expect(mail.sendEmail).toHaveBeenCalled();
      expect(prisma.memoStatusPivot.create).not.toHaveBeenCalled();

      // next tick sees the marker (newer than expiresAt) and stays quiet
      mail.sendEmail.mockClear();
      prisma.memoHistory.findFirst.mockResolvedValue({ id: 1, timestamp: new Date(now) });
      await service.sweepOnce(new Date(now.getTime() + 60000));
      expect(mail.sendEmail).not.toHaveBeenCalled();
    });

    it('notifies again after a renewal (marker older than the new expiresAt)', async () => {
      prisma.memoHistory.findFirst.mockResolvedValue({ id: 1, timestamp: th('2026-10-01T00:00:00') });
      await service.sweepOnce(now);
      expect(mail.sendEmail).toHaveBeenCalled();
    });

    it('expires a non-Processing memo silently', async () => {
      prisma.memoStatusPivot.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where.statusId ? null : { statusId: 1, userId: 1, status: { name: 'Draft' } }),
      );
      await service.sweepOnce(now);
      expect(prisma.memoStatusPivot.create).toHaveBeenCalled();
      expect(mail.sendEmail).not.toHaveBeenCalled();
    });

    it.each([
      [3, 'Approved'],
      [7, 'Terminated'],
      [9, 'Deleted'],
      [EXPIRED, 'Expired'],
    ])('leaves a memo whose latest status is %s (%s) alone', async (statusId, name) => {
      prisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId, userId: 1, status: { name } });
      await service.sweepOnce(now);
      expect(prisma.memoStatusPivot.create).not.toHaveBeenCalled();
      expect(mail.sendEmail).not.toHaveBeenCalled();
    });

    it('does not duplicate an existing (memo, user, Expired) pivot', async () => {
      prisma.memoStatusPivot.findFirst
        .mockResolvedValueOnce({ statusId: 5, userId: 1, status: { name: 'Processing' } }) // isProcessing
        .mockResolvedValueOnce({ statusId: 5, userId: 1, status: { name: 'Processing' } }) // latest
        .mockResolvedValueOnce({ id: 99 }); // existing inside the tx
      await service.sweepOnce(now);
      expect(prisma.memoStatusPivot.create).not.toHaveBeenCalled();
      expect(search.invalidateAll).not.toHaveBeenCalled();
      expect(mail.sendEmail).toHaveBeenCalled(); // was Processing → still notified
    });

    it('skips the status change when there is no Expired status row', async () => {
      prisma.status.findFirst.mockResolvedValue(null);
      await service.sweepOnce(now);
      expect(prisma.memoStatusPivot.create).not.toHaveBeenCalled();
    });
  });

  it('keeps going when one memo throws', async () => {
    prisma.$queryRaw.mockResolvedValue([
      memo(th('2026-10-20T10:00:00'), { id: 1 }),
      memo(th('2026-10-20T10:00:00'), { id: 2 }),
    ]);
    prisma.memoStatusPivot.findFirst.mockRejectedValueOnce(new Error('boom'));
    await service.sweepOnce(th('2026-10-20T10:05:00'));
    expect(prisma.memoStatusPivot.create).toHaveBeenCalledTimes(1);
    expect(prisma.memoStatusPivot.create).toHaveBeenCalledWith({
      data: { memoId: 2, statusId: EXPIRED, userId: 1 },
    });
  });
});
