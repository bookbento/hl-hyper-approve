import { Test, TestingModule } from '@nestjs/testing';
import { MemoNotificationService } from './memo-notification.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { EmailPreferenceService } from '../../common/mail/email-preference.service';
import { makeEmailToken, verifyEmailToken } from './email-token';
import { safeFilename, statusLabelFromId } from './memo-notification.templates';

jest.mock('../memo-pdf/pdf.core', () => ({
  createSignedPdfBuffer: jest.fn(() => Promise.resolve(Buffer.from('%PDF'))),
}));

const WAITING = 1;
const APPROVED = 2;

const mockPrisma = {
  masterMemo: { findUnique: jest.fn() },
  approvalActionStatus: { findUnique: jest.fn() },
  memoApproverAction: {
    findMany: jest.fn(),
    aggregate: jest.fn(),
    findFirst: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  notification: { create: jest.fn((args) => args) },
  user: { findMany: jest.fn(), findUnique: jest.fn() },
  memoCc: { findMany: jest.fn() },
  comment: { count: jest.fn() },
  attachedFile: { count: jest.fn() },
  extraApprovalLine: { findMany: jest.fn() },
  extraApprover: { findMany: jest.fn() },
  $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
};
const mockMail = { sendEmail: jest.fn() };
const mockPrefs = { filterUsersForEmail: jest.fn() };

const MEMO = {
  id: 9,
  memonumber: 'MN-9',
  memoNumberRecord: null,
  subject: 'Budget',
  memoType: { name: 'Internal' },
  businessUnit: { name: 'BU' },
  department: { name: 'IT' },
  userId: 1,
  approvalLineId: 3,
  expiresAt: null,
};

const USERS: Record<
  number,
  { id: number; name: string; lastname: string; nickname: string | null; email: string }
> = {
  1: { id: 1, name: 'Owner', lastname: 'O', nickname: null, email: 'owner@x.test' },
  2: { id: 2, name: 'Actor', lastname: 'A', nickname: null, email: 'actor@x.test' },
  3: { id: 3, name: 'Next', lastname: 'N', nickname: 'nn', email: 'next@x.test' },
  4: { id: 4, name: 'Cc', lastname: 'C', nickname: null, email: 'cc@x.test' },
};

/** notification.create args, flattened */
const pushed = () =>
  mockPrisma.notification.create.mock.calls.map(([a]) => ({
    userId: a.data.userId,
    message: a.data.message,
  }));

describe('MemoNotificationService', () => {
  let service: MemoNotificationService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MemoNotificationService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: mockMail },
        { provide: EmailPreferenceService, useValue: mockPrefs },
      ],
    }).compile();
    service = module.get(MemoNotificationService);
    jest.clearAllMocks();
    process.env['FRONTEND_URL'] = 'https://fe.test';
    process.env['APP_BASE_URL'] = 'https://api.test';
    process.env['EMAIL_TOKEN_SECRET'] = 'email-secret';

    mockPrisma.masterMemo.findUnique.mockResolvedValue(MEMO);
    mockPrisma.approvalActionStatus.findUnique.mockImplementation(({ where }) =>
      Promise.resolve({
        id: where.code === 'waiting' ? WAITING : where.code === 'approved' ? APPROVED : 9,
      }),
    );
    mockPrisma.memoApproverAction.aggregate.mockResolvedValue({ _max: { version: 1 } });
    mockPrisma.memoApproverAction.findMany.mockResolvedValue([]);
    mockPrisma.memoApproverAction.findFirst.mockResolvedValue(null);
    mockPrisma.user.findMany.mockImplementation(({ where }) =>
      Promise.resolve((where.id.in as number[]).map((id) => USERS[id]).filter(Boolean)),
    );
    mockPrisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(USERS[where.id] ?? null),
    );
    mockPrisma.memoCc.findMany.mockResolvedValue([]);
    mockPrisma.comment.count.mockResolvedValue(2);
    mockPrisma.attachedFile.count.mockResolvedValue(1);
    mockPrisma.extraApprovalLine.findMany.mockResolvedValue([]);
    mockPrisma.extraApprover.findMany.mockResolvedValue([]);
    mockPrefs.filterUsersForEmail.mockImplementation((ids: number[]) => Promise.resolve(ids));
    mockMail.sendEmail.mockResolvedValue(undefined);
  });

  /** getClonePivots rows; other memoApproverAction.findMany queries get [] */
  const pivots = (rows: unknown[]) =>
    mockPrisma.memoApproverAction.findMany.mockImplementation(({ select }) =>
      Promise.resolve(select?.loaUser && !select.status ? rows : []),
    );

  describe('notifyStatusUpdate', () => {
    it('does nothing for a missing memo or an unhandled status', async () => {
      await service.notifyStatusUpdate(9, 2, 'Actor A', 1, null);
      mockPrisma.masterMemo.findUnique.mockResolvedValue(null);
      await service.notifyStatusUpdate(9, 2, 'Actor A', 4, null);
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      expect(mockMail.sendEmail).not.toHaveBeenCalled();
    });

    it('Rejected: notifies and emails the owner with the latest reject reason', async () => {
      mockPrisma.memoApproverAction.findFirst.mockResolvedValue({
        approveWithCondition: null,
        rejectReason: 'งบเกิน',
        terminationReason: null,
      });
      await service.notifyStatusUpdate(9, 2, 'Actor A', 4, 0);

      expect(pushed()).toEqual([{ userId: 1, message: 'Actor A has rejected memo "Budget".' }]);
      expect(mockPrefs.filterUsersForEmail).toHaveBeenCalledWith([1], 'status-rejected');
      const [to, subject, text, html, attachments] = mockMail.sendEmail.mock.calls[0];
      expect(to).toEqual(['owner@x.test']);
      expect(subject).toBe('Notification for memo MN-9: Budget');
      expect(text + html).toContain('งบเกิน');
      expect(attachments).toBeUndefined();
    });

    it('prefers reasonOverride over the stored reason', async () => {
      await service.notifyStatusUpdate(9, 2, 'Actor A', 7, 0, undefined, 'หยุดโครงการ');
      expect(mockPrisma.memoApproverAction.findFirst).not.toHaveBeenCalled();
      expect(mockMail.sendEmail.mock.calls[0][2]).toContain('หยุดโครงการ');
    });

    it('Approved at an intermediate level: next level gets "your turn" mail with the signed PDF', async () => {
      // getClonePivots: levels 0 (actor) and 1 (user 3)
      pivots([
        { loaUser: { id: 10, userId: 2, level: 0, approvalRequirement: 'ALL', user: USERS[2] } },
        { loaUser: { id: 11, userId: 3, level: 1, approvalRequirement: 'ALL', user: USERS[3] } },
      ]);
      await service.notifyStatusUpdate(9, 2, 'Actor A', 3, 0);

      expect(pushed()).toEqual([
        { userId: 3, message: `It's your turn to approve request "Budget".` },
      ]);
      expect(mockPrefs.filterUsersForEmail).toHaveBeenCalledWith([3], 'wait-for-your-turn');
      const [to, , , , attachments] = mockMail.sendEmail.mock.calls[0];
      expect(to).toEqual(['next@x.test']);
      expect(attachments).toEqual([
        { filename: 'MN-9.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' },
      ]);
    });

    it('Approved at the last level: owner plus CC-only users (CC mail has no attachment)', async () => {
      pivots([
        { loaUser: { id: 10, userId: 2, level: 0, approvalRequirement: 'ALL', user: USERS[2] } },
      ]);
      mockPrisma.memoCc.findMany.mockResolvedValue([{ userId: 4 }, { userId: 1 }, { userId: 4 }]);
      await service.notifyStatusUpdate(9, 2, 'Actor A', 3, 0);

      expect(pushed()).toEqual([
        { userId: 1, message: 'Memo "Budget" has been approved by all approvers.' },
        { userId: 4, message: 'Memo "Budget" has been approved by all approvers.' },
      ]);
      expect(mockPrefs.filterUsersForEmail).toHaveBeenCalledWith([4], 'cc-notification');
      const cc = mockMail.sendEmail.mock.calls[1];
      expect(cc[0]).toEqual(['cc@x.test']);
      expect(cc[1]).toBe('Memo MN-9 — Approved (CC)');
      expect(cc[2]).toContain('All approvers have approved.');
      expect(cc[4]).toBeUndefined();
    });

    it('skips CC mail when every receiver opted out (Express behavior)', async () => {
      mockPrisma.memoCc.findMany.mockResolvedValue([{ userId: 4 }]);
      mockPrefs.filterUsersForEmail.mockImplementation((ids: number[], slug: string) =>
        Promise.resolve(slug === 'status-rejected' ? [] : ids),
      );
      await service.notifyStatusUpdate(9, 2, 'Actor A', 4, 0);
      expect(mockMail.sendEmail).not.toHaveBeenCalled();
      expect(mockPrisma.memoCc.findMany).not.toHaveBeenCalled();
    });

    it('Processing: picks the lowest waiting level that is not an already-satisfied ANY level', async () => {
      mockPrisma.memoApproverAction.findMany.mockImplementation(({ where, include }) => {
        if (include) return Promise.resolve([]); // getPendingActions in the async mailer
        if (where.statusId === WAITING)
          return Promise.resolve([
            {
              loaUser: { userId: 2, level: 0, approvalRequirement: 'ANY', user: { name: 'Actor' } },
            },
            {
              loaUser: { userId: 3, level: 1, approvalRequirement: 'ALL', user: { name: 'Next' } },
            },
          ]);
        if (where.statusId === APPROVED)
          return Promise.resolve([{ loaUser: { level: 0, approvalRequirement: 'ANY' } }]);
        return Promise.resolve([]);
      });
      await service.notifyStatusUpdate(9, 2, 'Actor A', 5, null);
      expect(pushed()).toEqual([
        { userId: 3, message: `It's your turn to approve request "Budget".` },
      ]);
      expect(mockPrefs.filterUsersForEmail).toHaveBeenCalledWith([3], 'wait-for-your-turn');
    });

    it('Processing: does not let an email failure escape (fire-and-forget)', async () => {
      mockPrisma.memoApproverAction.findMany.mockImplementation(({ where }) =>
        Promise.resolve(
          where.statusId === WAITING
            ? [
                {
                  loaUser: {
                    userId: 3,
                    level: 0,
                    approvalRequirement: 'ALL',
                    user: { name: 'Next' },
                  },
                },
              ]
            : [],
        ),
      );
      mockPrisma.comment.count.mockRejectedValue(new Error('db down'));
      await expect(service.notifyStatusUpdate(9, 2, 'Actor A', 5, null)).resolves.toBeUndefined();
      await new Promise((r) => setImmediate(r));
    });
  });

  describe('sendEmailsAsync', () => {
    const args = {
      receivers: [3],
      subject: 'Budget',
      message: `It's your turn to approve request "Budget".`,
      ref: 'MN-9',
      typeName: 'Internal',
      buName: 'BU',
      deptName: 'IT',
      memoId: 9,
      statusId: 5,
      ownerId: 1,
      notificationTypeSlug: 'wait-for-your-turn',
    };

    it('rotates one-click tokens and mails each pending approver once, at their lowest level', async () => {
      mockPrisma.memoApproverAction.findMany.mockImplementation(({ include }) =>
        Promise.resolve(
          include
            ? [
                {
                  id: 71,
                  loaUser: { userId: 3, level: 2, user: { email: 'next@x.test', name: 'Next' } },
                },
                {
                  id: 70,
                  loaUser: { userId: 3, level: 1, user: { email: 'next@x.test', name: 'Next' } },
                },
                {
                  id: 72,
                  loaUser: { userId: 4, level: 1, user: { email: 'cc@x.test', name: 'Cc' } },
                },
              ]
            : [],
        ),
      );
      await service.sendEmailsAsync(args);

      expect(mockPrisma.memoApproverAction.updateMany).toHaveBeenCalledWith({
        where: { id: { in: [71, 70, 72] } },
        data: { emailToken: null },
      });
      // user 4 is pending but not a receiver → no new token, no mail
      expect(mockPrisma.memoApproverAction.update).toHaveBeenCalledTimes(1);
      const { where, data } = mockPrisma.memoApproverAction.update.mock.calls[0][0];
      expect(where).toEqual({ id: 70 });
      expect(verifyEmailToken(data.emailToken)).toMatchObject({ memoId: 9, loaActionId: 70 });

      expect(mockMail.sendEmail).toHaveBeenCalledTimes(1);
      const [to, , text] = mockMail.sendEmail.mock.calls[0];
      expect(to).toEqual(['next@x.test']);
      expect(text).toContain(
        `https://api.test/api/memos/action/email?token=${data.emailToken}&action=approve`,
      );
      expect(text).toContain('Next N (nn)');
    });

    it('sends nothing when every receiver opted out', async () => {
      mockPrefs.filterUsersForEmail.mockResolvedValue([]);
      await service.sendEmailsAsync(args);
      expect(mockPrisma.memoApproverAction.updateMany).not.toHaveBeenCalled();
      expect(mockMail.sendEmail).not.toHaveBeenCalled();
    });
  });

  describe('notifyCcAssigned', () => {
    it('pushes once per CC user and mails with an empty attachment list', async () => {
      await service.notifyCcAssigned(9, 2, [4, 4], 5);
      expect(pushed()).toEqual([
        { userId: 4, message: `Actor A CC'd you on memo "Budget" (Processing).` },
      ]);
      const [to, subject, , , attachments] = mockMail.sendEmail.mock.calls[0];
      expect(to).toEqual(['cc@x.test']);
      expect(subject).toBe('Memo MN-9 — Processing (CC)');
      expect(attachments).toEqual([]);
    });

    it('does nothing for an empty CC list', async () => {
      await service.notifyCcAssigned(9, 2, []);
      expect(mockPrisma.masterMemo.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('notifyRecallUpdate', () => {
    it('pushes and mails CC users with the recall line', async () => {
      mockPrisma.memoCc.findMany.mockResolvedValue([{ userId: 4 }]);
      await service.notifyRecallUpdate(9, 1, 'Owner O');
      expect(pushed()).toEqual([{ userId: 4, message: 'Owner O has recalled memo "Budget".' }]);
      const [, subject, text] = mockMail.sendEmail.mock.calls[0];
      expect(subject).toBe('Memo MN-9 — Recalled (CC)');
      expect(text).toContain('Recalled by: Owner O');
    });

    it('swallows errors', async () => {
      mockPrisma.memoCc.findMany.mockRejectedValue(new Error('boom'));
      await expect(service.notifyRecallUpdate(9, 1, 'Owner O')).resolves.toBeUndefined();
    });
  });

  describe('pushNoti', () => {
    it('drops users who turned the notification type off', async () => {
      mockPrefs.filterUsersForEmail.mockResolvedValue([3]);
      await service.pushNoti(
        [3, 4],
        2,
        { notificationTypeId: 3, memoId: 9, message: 'm' },
        'status-approved',
      );
      expect(pushed()).toEqual([{ userId: 3, message: 'm' }]);
    });
  });

  describe('getApproverLineStatus', () => {
    const row = (over: Record<string, unknown>) => ({
      status: { code: 'waiting' },
      assignedUserId: null,
      actualActorId: null,
      actualActor: null,
      loaUser: {
        level: 0,
        approvalRequirement: 'ALL',
        user: {
          ...USERS[2],
          delegatedToUserId: null,
          delegationStartDate: null,
          delegationEndDate: null,
          delegatedToUser: null,
        },
      },
      ...over,
    });

    it('shows the active delegate, then the actual actor, and marks satisfied ANY levels', async () => {
      const day = 86_400_000;
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([
        row({
          status: { code: 'approved' },
          loaUser: {
            level: 0,
            approvalRequirement: 'ANY',
            user: {
              ...USERS[2],
              delegatedToUserId: 3,
              delegationStartDate: new Date(Date.now() - day),
              delegationEndDate: new Date(Date.now() + day),
              delegatedToUser: USERS[3],
            },
          },
        }),
        row({
          loaUser: {
            level: 0,
            approvalRequirement: 'ANY',
            user: { ...row({}).loaUser.user, ...USERS[4] },
          },
        }),
        row({ actualActorId: 1, actualActor: USERS[1], loaUser: { ...row({}).loaUser, level: 1 } }),
        row({ loaUser: { level: 2, approvalRequirement: 'ALL', user: null } }),
      ]);

      expect(await service.getApproverLineStatus(9, 1)).toEqual([
        { name: 'Next N (nn)', level: 0, statusCode: 'approved', isLevelSatisfied: false },
        { name: 'Cc C', level: 0, statusCode: 'approved', isLevelSatisfied: true },
        { name: 'Owner O', level: 1, statusCode: 'waiting', isLevelSatisfied: false },
      ]);
    });
  });

  describe('getActiveExtraApproversForEmail', () => {
    it('uses active lines, keeps the most severe status per user, sorted by name', async () => {
      mockPrisma.extraApprovalLine.findMany.mockResolvedValue([
        { id: 2, status: 'IN_PROGRESS' },
        { id: 1, status: 'APPROVED' },
      ]);
      mockPrisma.extraApprover.findMany.mockResolvedValue([
        { userId: 4, actedAt: new Date(), status: { name: 'Approved' } },
        { userId: 4, actedAt: null, status: { name: 'Rejected' } },
        { userId: 3, actedAt: null, status: null },
      ]);
      expect(await service.getActiveExtraApproversForEmail(9)).toEqual([
        { userId: 4, name: 'Cc C', statusCode: 'rejected' },
        { userId: 3, name: 'Next N (nn)', statusCode: 'waiting' },
      ]);
      expect(mockPrisma.extraApprover.findMany.mock.calls[0][0].where).toEqual({
        extraId: { in: [2] },
      });
    });
  });
});

describe('email token', () => {
  it('round-trips and rejects a token signed with another secret', () => {
    process.env['EMAIL_TOKEN_SECRET'] = 'a';
    const t = makeEmailToken(9, 70);
    expect(verifyEmailToken(t)).toMatchObject({ memoId: 9, loaActionId: 70 });
    process.env['EMAIL_TOKEN_SECRET'] = 'b';
    expect(verifyEmailToken(t)).toBeNull();
  });
});

describe('templates', () => {
  it('safeFilename strips path characters and caps length', () => {
    expect(safeFilename('a/b:c')).toBe('a-b-c.pdf');
    expect(safeFilename('x'.repeat(200))).toHaveLength(154);
    expect(statusLabelFromId(7)).toBe('Terminated');
  });
});
