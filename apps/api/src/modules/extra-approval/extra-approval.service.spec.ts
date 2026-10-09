import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ExtraStatus } from '@prisma/client';
import { ExtraApprovalService } from './extra-approval.service';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../../common/mail/mail.service';
import { EmailPreferenceService } from '../../common/mail/email-preference.service';
import { MemoAccessService } from '../memo-query/memo-access.service';
import { MemoNotificationService } from '../memo-notification/memo-notification.service';

const APPROVED = 3;
const REJECTED = 4;

const mockPrisma = {
  masterMemo: { findUnique: jest.fn(), findMany: jest.fn() },
  memoStatusPivot: {
    findFirst: jest.fn(),
    deleteMany: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  status: { findFirst: jest.fn() },
  lineOfApprovalUserPivotForUse: { findFirst: jest.fn() },
  memoCc: { findFirst: jest.fn(), findMany: jest.fn() },
  commentTag: { findFirst: jest.fn(), findMany: jest.fn() },
  extraApprover: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    createMany: jest.fn(),
  },
  extraApprovalLine: {
    create: jest.fn(),
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  memoApproverAction: { findMany: jest.fn(), findFirst: jest.fn() },
  comment: { createMany: jest.fn(), findMany: jest.fn(), updateMany: jest.fn(), delete: jest.fn() },
  user: { findUnique: jest.fn(), findMany: jest.fn() },
  notification: { createMany: jest.fn() },
  memoHistory: { create: jest.fn() },
};
const mockMail = { sendEmail: jest.fn() };
const mockPrefs = { filterUsersForEmail: jest.fn() };
const mockAccess = { canViewMemo: jest.fn() };
const mockNoti = {
  notifyStatusUpdate: jest.fn(),
  getLatestVersion: jest.fn(),
  getUserDisplayName: jest.fn(),
};

const USERS: Record<
  number,
  { id: number; name: string; lastname: string; nickname: string | null; email: string }
> = {
  1: { id: 1, name: 'Owner', lastname: 'O', nickname: null, email: 'owner@x.test' },
  2: { id: 2, name: 'Actor', lastname: 'A', nickname: 'aa', email: 'actor@x.test' },
  3: { id: 3, name: 'Extra', lastname: 'E', nickname: null, email: 'extra@x.test' },
  4: { id: 4, name: 'Other', lastname: 'X', nickname: null, email: 'other@x.test' },
};

const flush = () => new Promise((r) => setImmediate(r));

describe('ExtraApprovalService', () => {
  let service: ExtraApprovalService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExtraApprovalService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: MailService, useValue: mockMail },
        { provide: EmailPreferenceService, useValue: mockPrefs },
        { provide: MemoAccessService, useValue: mockAccess },
        { provide: MemoNotificationService, useValue: mockNoti },
      ],
    }).compile();
    service = module.get(ExtraApprovalService);
    jest.clearAllMocks();
    process.env['FRONTEND_URL'] = 'https://fe.test';

    mockPrisma.masterMemo.findUnique.mockResolvedValue({
      userId: 1,
      subject: 'Budget',
      memonumber: 'MN-1',
    });
    // Processing — both for the guard (statusId) and the silent check (status.id)
    mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({
      id: 9,
      statusId: 5,
      status: { id: 5, name: 'Processing' },
    });
    mockPrisma.status.findFirst.mockImplementation(({ where }) =>
      Promise.resolve({ id: where.name === 'Approved' ? APPROVED : REJECTED }),
    );
    for (const m of [
      mockPrisma.lineOfApprovalUserPivotForUse.findFirst,
      mockPrisma.memoCc.findFirst,
      mockPrisma.commentTag.findFirst,
      mockPrisma.extraApprover.findFirst,
    ]) {
      m.mockResolvedValue(null);
    }
    mockPrisma.extraApprovalLine.create.mockImplementation(({ data }) =>
      Promise.resolve({
        id: 70,
        memoId: data.memoId,
        status: data.status,
        approvers: data.approvers.create,
        comment: [],
      }),
    );
    mockPrisma.comment.findMany.mockResolvedValue([{ id: 1 }]);
    mockPrisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(USERS[where.id] ?? null),
    );
    mockPrisma.user.findMany.mockImplementation(({ where }) =>
      Promise.resolve(((where.id?.in as number[]) ?? []).map((id) => USERS[id]).filter(Boolean)),
    );
    mockPrefs.filterUsersForEmail.mockImplementation((ids: number[]) => Promise.resolve(ids));
    mockMail.sendEmail.mockResolvedValue(undefined);
    mockAccess.canViewMemo.mockResolvedValue(true);
    mockPrisma.memoHistory.create.mockResolvedValue({});
    mockPrisma.comment.delete.mockResolvedValue({});
    mockNoti.notifyStatusUpdate.mockResolvedValue(undefined);
    mockNoti.getLatestVersion.mockResolvedValue(1);
    mockNoti.getUserDisplayName.mockImplementation((id: number) =>
      Promise.resolve(`${USERS[id].name} ${USERS[id].lastname}`),
    );
  });

  describe('createLine', () => {
    it('400s without userIds', async () => {
      await expect(service.createLine(9, 1, { userIds: [] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('409s with the status code map when the memo is not Processing', async () => {
      mockPrisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 6 });
      await expect(service.createLine(9, 1, { userIds: [3] })).rejects.toMatchObject({
        response: { code: 'MEMO_STATUS_CHANGED', statusCode: 'RECALLED', currentStatusId: 6 },
      });
    });

    it('403s for a user with no part in the memo', async () => {
      await expect(service.createLine(9, 4, { userIds: [3] })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mockPrisma.extraApprovalLine.create).not.toHaveBeenCalled();
    });

    it('creates the line, one comment per approver, notifies and emails owner + approvers', async () => {
      mockPrisma.lineOfApprovalUserPivotForUse.findFirst.mockResolvedValue({ id: 1 });
      const line = await service.createLine(9, 2, {
        userIds: [3, '3', 4],
        preApprovedUsers: [{ userId: 4, actedAt: '2026-01-02T03:04:05Z' }],
        comment: '  please check  ',
      });

      const approvers = mockPrisma.extraApprovalLine.create.mock.calls[0][0].data.approvers.create;
      expect(approvers).toEqual([
        { userId: 3, statusId: null, actedAt: null },
        { userId: 4, statusId: APPROVED, actedAt: new Date('2026-01-02T03:04:05Z') },
      ]);
      expect(mockPrisma.comment.createMany.mock.calls[0][0].data).toEqual([
        expect.objectContaining({
          ExtraUserid: 3,
          ExtraStatus: 'Pending',
          comment: 'please check',
          extraApprovalLineId: 70,
        }),
        expect.objectContaining({ ExtraUserid: 4, ExtraStatus: 'Approved' }),
      ]);
      expect(line.comment).toEqual([{ id: 1 }]);

      const messages = mockPrisma.notification.createMany.mock.calls.flatMap(([a]) =>
        a.data.map((n: any) => n.message),
      );
      expect(messages).toEqual([
        'Actor A (aa) requested an extra approval line from Extra E, Other X for "Budget".',
        'You were assigned as an extra approver to "Budget".',
        'You were assigned as an extra approver to "Budget".',
      ]);
      expect(mockMail.sendEmail.mock.calls.map((c) => c[1])).toEqual([
        'Extra approval line requested for your memo MN-1: Budget',
        'Extra approval requested on memo MN-1: Budget',
        'Extra approval requested on memo MN-1: Budget',
      ]);
      // pre-approved users are left out of the history line
      expect(mockPrisma.memoHistory.create.mock.calls[0][0].data.action).toBe(
        'Extra Approver added: Extra E by Actor A (aa)',
      );
    });
  });

  describe('act', () => {
    beforeEach(() => {
      mockPrisma.extraApprover.findFirst.mockResolvedValue({
        id: 80,
        statusId: null,
        extra: { memoId: 9 },
      });
      mockPrisma.extraApprovalLine.findUnique.mockResolvedValue({
        id: 70,
        status: ExtraStatus.PENDING,
      });
    });

    it('rejects an unknown statusCode', async () => {
      await expect(service.act(9, 70, 3, 'maybe')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404s for a non-approver and 409s for a repeat action or a closed line', async () => {
      mockPrisma.extraApprover.findFirst.mockResolvedValueOnce(null);
      await expect(service.act(9, 70, 4, 'approved')).rejects.toBeInstanceOf(NotFoundException);

      mockPrisma.extraApprover.findFirst.mockResolvedValueOnce({
        id: 80,
        statusId: APPROVED,
        extra: { memoId: 9 },
      });
      await expect(service.act(9, 70, 3, 'approved')).rejects.toBeInstanceOf(ConflictException);

      mockPrisma.extraApprovalLine.findUnique.mockResolvedValueOnce({
        id: 70,
        status: ExtraStatus.COMPLETED,
      });
      await expect(service.act(9, 70, 3, 'approved')).rejects.toBeInstanceOf(ConflictException);
    });

    it('reject closes the line, rejects the memo and notifies status 4 after returning', async () => {
      mockPrisma.memoStatusPivot.findFirst
        .mockResolvedValueOnce({ statusId: 5 }) // guard
        .mockResolvedValueOnce({ id: 33 }); // owner pivot
      const res = await service.act(9, 70, 3, 'REJECTED');

      expect(res).toEqual({ ok: true, closed: 'rejected' });
      expect(mockPrisma.extraApprovalLine.update.mock.calls[0][0].data.status).toBe(
        ExtraStatus.REJECTED,
      );
      expect(mockPrisma.memoStatusPivot.update).toHaveBeenCalledWith({
        where: { id: 33 },
        data: { statusId: REJECTED, createdAt: expect.any(Date) },
      });
      expect(mockNoti.notifyStatusUpdate).not.toHaveBeenCalled();
      await flush();
      expect(mockNoti.notifyStatusUpdate).toHaveBeenCalledWith(9, 3, 'Extra E', 4, null);
    });

    it('approve by the last approver completes the line and resumes the main line (status 5)', async () => {
      mockPrisma.extraApprover.findMany.mockResolvedValue([
        { statusId: APPROVED },
        { statusId: APPROVED },
      ]);
      const res = await service.act(9, 70, 3, 'approved');

      expect(res).toEqual({ ok: true, closed: 'approved' });
      expect(mockPrisma.comment.updateMany.mock.calls.map(([a]) => a.data.ExtraStatus)).toEqual([
        'In Progress',
        'Completed',
      ]);
      await flush();
      expect(mockNoti.notifyStatusUpdate).toHaveBeenCalledWith(9, 3, 'Extra E', 5, null);
    });

    it('approve with others still waiting leaves the line open', async () => {
      mockPrisma.extraApprover.findMany.mockResolvedValue([
        { statusId: APPROVED },
        { statusId: null },
      ]);
      expect(await service.act(9, 70, 3, 'approved')).toEqual({ ok: true, closed: null });
      await flush();
      expect(mockNoti.notifyStatusUpdate).not.toHaveBeenCalled();
    });

    it('a notify failure does not escape', async () => {
      mockPrisma.extraApprover.findMany.mockResolvedValue([{ statusId: APPROVED }]);
      mockNoti.notifyStatusUpdate.mockRejectedValue(new Error('smtp'));
      await service.act(9, 70, 3, 'approved');
      await flush();
      await flush();
    });
  });

  describe('appendApprovers', () => {
    beforeEach(() => {
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([{ loaUser: { userId: 4 } }]);
      mockPrisma.memoCc.findMany.mockResolvedValue([]);
      mockPrisma.extraApprover.findMany.mockResolvedValue([]);
      mockPrisma.extraApprovalLine.findMany.mockResolvedValue([{ createdById: 2 }]);
      mockPrisma.commentTag.findMany.mockResolvedValue([]);
      mockPrisma.extraApprovalLine.findUnique.mockResolvedValue({
        id: 70,
        memoId: 9,
        status: ExtraStatus.COMPLETED,
        approvers: [{ userId: 3, statusId: APPROVED }],
      });
    });

    it('403s for non-participants', async () => {
      await expect(service.appendApprovers(9, 70, 99, [5])).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('409s while someone on the line has not acted', async () => {
      mockPrisma.extraApprovalLine.findUnique.mockResolvedValue({
        id: 70,
        memoId: 9,
        status: ExtraStatus.PENDING,
        approvers: [{ userId: 3, statusId: null }],
      });
      await expect(service.appendApprovers(9, 70, 2, [5])).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('skips existing and main-line approvers, recomputes the line and logs history', async () => {
      mockPrisma.extraApprover.findMany.mockResolvedValue([
        { statusId: APPROVED },
        { statusId: null },
      ]);
      await service.appendApprovers(9, 70, 2, [3, 4, 1]);

      expect(mockPrisma.extraApprover.createMany).toHaveBeenCalledWith({
        data: [{ extraId: 70, userId: 1 }],
      });
      expect(mockPrisma.extraApprovalLine.update.mock.calls[0][0].data.status).toBe(
        ExtraStatus.IN_PROGRESS,
      );
      expect(mockPrisma.memoHistory.create.mock.calls[0][0].data.action).toBe(
        'Actor A added 1 Owner O; skipped 2 (duplicate in Extra/LoA); line → IN_PROGRESS; emailed 1/1',
      );
    });
  });

  describe('removeLine', () => {
    const line = {
      id: 70,
      status: 'PENDING',
      createdById: 2,
      commentId: 5,
      memo: { subject: 'Budget', memonumber: 'MN-1', userId: 1 },
      approvers: [{ userId: 3 }, { userId: 2 }],
    };

    it('only the creator may remove, and only while PENDING', async () => {
      mockPrisma.extraApprovalLine.findFirst.mockResolvedValue(line);
      await expect(service.removeLine(9, 70, 3)).rejects.toBeInstanceOf(ForbiddenException);
      mockPrisma.extraApprovalLine.findFirst.mockResolvedValue({ ...line, status: 'IN_PROGRESS' });
      await expect(service.removeLine(9, 70, 2)).rejects.toBeInstanceOf(ConflictException);
      expect(mockPrisma.extraApprovalLine.delete).not.toHaveBeenCalled();
    });

    it('notifies approvers (minus the actor) and the owner, then deletes', async () => {
      mockPrisma.extraApprovalLine.findFirst.mockResolvedValue(line);
      await service.removeLine(9, 70, 2);

      expect(
        mockPrisma.notification.createMany.mock.calls[0][0].data.map((n: any) => [
          n.userId,
          n.message,
        ]),
      ).toEqual([
        [3, 'Actor A (aa) removed your extra approval line from "Budget".'],
        [1, 'Actor A (aa) removed an extra approval line (Extra E) from "Budget".'],
      ]);
      expect(mockMail.sendEmail.mock.calls.map((c) => [c[0], c[1]])).toEqual([
        [['extra@x.test'], 'Your extra approval line was deleted on memo MN-1: Budget'],
        [['owner@x.test'], 'Extra approval line deleted on your memo MN-1: Budget'],
      ]);
      expect(mockPrisma.comment.delete).toHaveBeenCalledWith({ where: { id: 5 } });
      expect(mockPrisma.extraApprovalLine.delete).toHaveBeenCalledWith({ where: { id: 70 } });
    });
  });

  describe('reads', () => {
    it('list and active require memo access', async () => {
      mockAccess.canViewMemo.mockResolvedValue(false);
      await expect(service.listLines(9, 4)).rejects.toBeInstanceOf(ForbiddenException);
      await expect(service.getActiveLine(9, 4)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mockPrisma.extraApprovalLine.findMany).not.toHaveBeenCalled();
    });

    it('active falls back to the latest closed line, then null', async () => {
      mockPrisma.extraApprovalLine.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 7, status: 'COMPLETED', createdAt: 'd', comment: [] });
      mockPrisma.extraApprover.findMany.mockResolvedValue([{ id: 1 }]);
      expect(await service.getActiveLine(9, 1)).toEqual({
        id: 7,
        status: 'COMPLETED',
        createdAt: 'd',
        comments: [],
        approvers: [{ id: 1 }],
      });
      mockPrisma.extraApprovalLine.findFirst.mockResolvedValue(null);
      expect(await service.getActiveLine(9, 1)).toBeNull();
    });

    it('bulk picks the latest active line per visible memo and hides drafts of others', async () => {
      mockPrisma.masterMemo.findMany.mockResolvedValue([
        { id: 1, userId: 2, statuses: [{ status: { name: 'Processing' } }] },
        { id: 2, userId: 9, statuses: [{ status: { name: 'Draft' } }] },
        { id: 3, userId: 9, statuses: [{ status: { name: 'Approved' } }] },
      ]);
      mockPrisma.extraApprovalLine.findMany.mockResolvedValue([
        { id: 12, memoId: 1, status: 'COMPLETED', createdAt: 'c' },
        { id: 11, memoId: 1, status: 'PENDING', createdAt: 'b' },
      ]);
      mockPrisma.extraApprover.findMany.mockResolvedValue([
        { id: 5, extraId: 11, actedAt: null, statusId: null, status: null, user: { id: 3 } },
      ]);

      expect(await service.getActiveLinesBulk(2, [1, '2', 3, 'x', 1])).toEqual({
        1: {
          id: 11,
          status: 'PENDING',
          createdAt: 'b',
          approvers: [{ id: 5, actedAt: null, statusId: null, status: null, user: { id: 3 } }],
        },
        3: null,
      });
      await expect(service.getActiveLinesBulk(2, 'nope')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('searchEligibleUsers', () => {
    it('403s for outsiders', async () => {
      mockPrisma.memoApproverAction.findFirst.mockResolvedValue(null);
      await expect(service.searchEligibleUsers(9, null, 4, '')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('excludes self, owner and main approvers by id and email', async () => {
      mockPrisma.memoApproverAction.findMany.mockResolvedValue([
        { loaUser: { userId: 4, user: { email: 'Other@X.test' } } },
      ]);
      await service.searchEligibleUsers(9, null, 1, 'ex');
      const { where, take } = mockPrisma.user.findMany.mock.calls[0][0];
      expect(where.id).toEqual({ notIn: [4, 1] });
      expect(where.email).toEqual({ notIn: ['other@x.test'] });
      expect(where.OR).toHaveLength(4);
      expect(take).toBe(20);
    });

    it('404s for a line from another memo', async () => {
      mockPrisma.extraApprovalLine.findFirst.mockResolvedValue(null);
      await expect(service.searchEligibleUsers(9, 70, 1, '')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  it('recomputeLineStatus: any reject wins, else all approved → COMPLETED', async () => {
    mockPrisma.extraApprover.findMany.mockResolvedValueOnce([
      { statusId: APPROVED },
      { statusId: REJECTED },
    ]);
    expect(await service.recomputeLineStatus(70)).toBe(ExtraStatus.REJECTED);
    mockPrisma.extraApprover.findMany.mockResolvedValueOnce([{ statusId: APPROVED }]);
    expect(await service.recomputeLineStatus(70)).toBe(ExtraStatus.COMPLETED);
    mockPrisma.extraApprover.findMany.mockResolvedValueOnce([]);
    expect(await service.recomputeLineStatus(70)).toBe(ExtraStatus.PENDING);
  });
});
