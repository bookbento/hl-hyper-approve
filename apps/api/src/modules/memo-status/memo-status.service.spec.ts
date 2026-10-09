import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ActionType } from '@prisma/client';
import { MemoStatusService } from './memo-status.service';

const ACTION_STATUS: Record<string, number> = {
  waiting: 1,
  approved: 2,
  rejected: 3,
  terminated: 4,
};

function makePrisma() {
  const p: any = {
    masterMemo: { findUnique: jest.fn() },
    memoStatusPivot: {
      findFirst: jest.fn(),
      deleteMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    approvalActionStatus: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(where.code in ACTION_STATUS ? { id: ACTION_STATUS[where.code] } : null),
      ),
    },
    memoApproverAction: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      aggregate: jest.fn().mockResolvedValue({ _max: { version: 2 } }),
    },
    lineOfApprovalUserPivotForUse: { findUnique: jest.fn(), findFirst: jest.fn() },
    lineOfApprovalUserPivot: { findFirst: jest.fn() },
    status: { findFirst: jest.fn(), findUnique: jest.fn() },
    memoHistory: { create: jest.fn() },
    memoCc: { findMany: jest.fn().mockResolvedValue([]) },
    user: { findMany: jest.fn() },
  };
  p.$transaction = jest.fn((arg: any) => (typeof arg === 'function' ? arg(p) : Promise.all(arg)));
  return p;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

describe('MemoStatusService', () => {
  let prisma: any;
  let mail: any;
  let prefs: any;
  let access: any;
  let search: any;
  let noti: any;
  let extra: any;
  let recall: any;
  let service: MemoStatusService;

  beforeEach(() => {
    prisma = makePrisma();
    mail = { sendEmail: jest.fn() };
    prefs = { filterUsersForEmail: jest.fn((ids: number[]) => Promise.resolve(ids)) };
    access = { canViewMemo: jest.fn().mockResolvedValue(true) };
    search = { invalidateAll: jest.fn() };
    noti = {
      getLatestVersion: jest.fn().mockResolvedValue(2),
      getUserDisplayName: jest.fn((id: number) => Promise.resolve(`User ${id}`)),
      notifyStatusUpdate: jest.fn().mockResolvedValue(undefined),
      notifyRecallUpdate: jest.fn().mockResolvedValue(undefined),
      notifyCcAssigned: jest.fn().mockResolvedValue(undefined),
      pushNoti: jest.fn().mockResolvedValue(undefined),
    };
    extra = { hasActiveExtraLine: jest.fn().mockResolvedValue(false) };
    recall = { handleRecall: jest.fn().mockResolvedValue(undefined) };
    service = new MemoStatusService(prisma, mail, prefs, access, search, noti, extra, recall);
    process.env['FRONTEND_URL'] = 'https://fe.test';
  });

  /** Latest pivot = Processing, approver row for loaUserId 70 assigned to user 2. */
  function processingWithApprover(assignedUser = 2, user: any = { delegatedToUserId: null }) {
    prisma.memoStatusPivot.findFirst.mockResolvedValue({
      statusId: 5,
      status: { id: 5, name: 'Processing' },
    });
    prisma.memoApproverAction.findFirst.mockResolvedValue({
      id: 500,
      assignedUserId: null,
      loaUser: { userId: assignedUser, user: { name: 'Orig', lastname: 'O', ...user } },
    });
  }

  describe('approveWithSignature', () => {
    it('409s while an extra approval line is open', async () => {
      extra.hasActiveExtraLine.mockResolvedValue(true);
      await expect(
        service.approveWithSignature(9, 2, { loaUserId: 70, statusCode: 'approved' }),
      ).rejects.toThrow(ConflictException);
    });

    it('400s without loaUserId/statusCode', async () => {
      await expect(service.approveWithSignature(9, 2, { statusCode: 'approved' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('409 MEMO_STATUS_CHANGED with the Express body when not Processing', async () => {
      prisma.memoStatusPivot.findFirst.mockResolvedValue({
        statusId: 3,
        status: { id: 3, name: 'Approved' },
      });
      const err = await service
        .approveWithSignature(9, 2, { loaUserId: 70, statusCode: 'approved' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({
        code: 'MEMO_STATUS_CHANGED',
        statusCode: 'APPROVED',
        currentStatus: 'Approved',
        currentStatusId: 3,
      });
    });

    it('404 when the approver row is missing, 403 when the actor is someone else', async () => {
      processingWithApprover();
      prisma.memoApproverAction.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.approveWithSignature(9, 2, { loaUserId: 70, statusCode: 'approved' }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        service.approveWithSignature(9, 99, { loaUserId: 70, statusCode: 'approved' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('lets an active delegate approve and records "on behalf of"', async () => {
      processingWithApprover(2, {
        delegatedToUserId: 8,
        delegationStartDate: new Date(Date.now() - 1000),
        delegationEndDate: new Date(Date.now() + 100000),
        delegatedToUser: { name: 'Del', lastname: 'D' },
      });
      prisma.memoApproverAction.update.mockResolvedValue({ id: 500, statusId: 2 });
      prisma.status.findFirst.mockResolvedValue({ id: 3 });

      const res = await service.approveWithSignature(9, 8, {
        loaUserId: 70,
        statusCode: 'approved',
        signatureText: ' Sig ',
      });

      expect(res).toMatchObject({ id: 500, isDelegatedApproval: true });
      expect(res.delegationInfo).toMatchObject({
        originalUserId: 2,
        originalUserName: 'Orig O',
        delegatedUserName: 'Del D',
      });
      expect(prisma.memoApproverAction.update).toHaveBeenCalledWith({
        where: { memoId_loaUserId_version: { memoId: 9, loaUserId: 70, version: 2 } },
        data: expect.objectContaining({
          statusId: 2,
          signatureText: 'Sig',
          actualActorId: 8,
          approveWithCondition: null,
        }),
      });
      expect(prisma.memoHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'User 8 approved the memo (on behalf of Orig O)',
          actiontype: ActionType.APPROVE,
          statusId: 3,
        }),
      });
    });

    it('emails the owner and CCs (not the actor) about an approval condition', async () => {
      processingWithApprover();
      prisma.memoApproverAction.update.mockResolvedValue({ id: 500 });
      prisma.lineOfApprovalUserPivotForUse.findUnique.mockResolvedValue(null); // evaluate fails, logged
      prisma.masterMemo.findUnique.mockResolvedValue({
        userId: 1,
        subject: 'Buy',
        memonumber: 'M-1',
        memoType: { name: 'T' },
        businessUnit: null,
        department: null,
      });
      prisma.memoCc.findMany.mockResolvedValue([{ userId: 2 }, { userId: 5 }]);
      prisma.user.findMany.mockResolvedValue([
        { id: 1, name: 'Own', lastname: 'O', nickname: null, email: 'o@x' },
        { id: 5, name: 'Cc', lastname: null, nickname: 'c', email: null },
      ]);

      await service.approveWithSignature(9, 2, {
        loaUserId: 70,
        statusCode: 'approved',
        approveWithCondition: ' within budget ',
      });
      await flush();

      expect(prefs.filterUsersForEmail).toHaveBeenCalledWith([1, 5], 'approve-with-condition');
      expect(noti.pushNoti).toHaveBeenCalledWith(
        [1, 5],
        2,
        expect.objectContaining({
          message: 'User 2 approved memo "Buy" with condition: within budget',
        }),
        'status-approved',
      );
      expect(mail.sendEmail).toHaveBeenCalledTimes(1);
      expect(mail.sendEmail.mock.calls[0][0]).toEqual(['o@x']);
      expect(mail.sendEmail.mock.calls[0][1]).toBe('Memo M-1: Approved with Conditions by User 2');
      expect(mail.sendEmail.mock.calls[0][2]).toContain('View memo: https://fe.test/memo/9');
    });

    it('maps unexpected errors to 500 { error }', async () => {
      prisma.memoStatusPivot.findFirst.mockRejectedValue(new Error('db down'));
      const err = await service
        .approveWithSignature(9, 2, { loaUserId: 70, statusCode: 'approved' })
        .catch((e) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(err.getResponse()).toEqual({ error: 'Approve action failed' });
    });
  });

  describe('act', () => {
    it('400s an unknown status code', async () => {
      prisma.memoStatusPivot.findFirst.mockResolvedValue({ status: { id: 5, name: 'Processing' } });
      await expect(service.act(9, 2, { loaUserId: 70, statusCode: 'maybe' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('403s when the actor is not the approver (Express allowed it)', async () => {
      processingWithApprover(3);
      await expect(service.act(9, 2, { loaUserId: 70, statusCode: 'approved' })).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.memoApproverAction.update).not.toHaveBeenCalled();
    });

    it('approves the waiting row, logs history, then re-evaluates', async () => {
      processingWithApprover();
      prisma.memoApproverAction.findFirst
        .mockResolvedValueOnce({
          id: 500,
          assignedUserId: 2,
          loaUser: { userId: 2, user: {} },
        })
        .mockResolvedValueOnce({ id: 501 });
      const evaluate = jest.spyOn(service, 'evaluateAndUpdateMemoStatus').mockResolvedValue();

      expect(await service.act(9, 2, { loaUserId: 70, statusCode: 'approved' })).toEqual({
        ok: true,
      });
      expect(prisma.memoApproverAction.update).toHaveBeenCalledWith({
        where: { id: 501 },
        data: { statusId: 2, actedAt: expect.any(Date) },
      });
      expect(prisma.memoHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'User 2 has approved the memo',
          actiontype: ActionType.APPROVE,
          statusId: 5,
        }),
      });
      await flush();
      expect(evaluate).toHaveBeenCalledWith(9, 70);
    });

    it('routes recalled to MemoRecallService.handleRecall', async () => {
      processingWithApprover();
      jest.spyOn(service, 'evaluateAndUpdateMemoStatus').mockResolvedValue();
      await service.act(9, 2, { loaUserId: 70, statusCode: 'recalled' });
      expect(recall.handleRecall).toHaveBeenCalledWith({ memoId: 9, loaUserId: 70 });
    });
  });

  describe('evaluateAndUpdateMemoStatus', () => {
    function setup(pivots: any[], actions: any[]) {
      prisma.lineOfApprovalUserPivotForUse.findUnique.mockResolvedValue({
        userId: 2,
        level: 1,
        user: { name: 'Approver' },
      });
      prisma.masterMemo.findUnique.mockResolvedValue({ userId: 1 });
      prisma.memoApproverAction.findMany
        .mockResolvedValueOnce(pivots.map((p) => ({ loaUser: p })))
        .mockResolvedValueOnce(actions);
      prisma.memoStatusPivot.findFirst.mockResolvedValue({ id: 40, statusId: 5 });
    }
    const pivot = (id: number, level: number, approvalRequirement = 'ALL') => ({
      id,
      userId: id,
      level,
      approvalRequirement,
    });
    const action = (loaUserId: number, level: number, code: string) => ({
      loaUserId,
      status: { code },
      loaUser: { level },
    });

    it('stays Processing until every ALL approver has approved', async () => {
      setup([pivot(1, 1), pivot(2, 1)], [action(1, 1, 'approved'), action(2, 1, 'waiting')]);
      await service.evaluateAndUpdateMemoStatus(9, 70);
      expect(prisma.memoStatusPivot.update).toHaveBeenCalledWith({
        where: { id: 40 },
        data: { createdAt: expect.any(Date) },
      });
      expect(noti.notifyStatusUpdate).toHaveBeenCalledWith(9, 2, 'Approver', 5, 1);
      expect(search.invalidateAll).toHaveBeenCalled();
    });

    it('approves when an ANY level has one approval', async () => {
      setup(
        [pivot(1, 1, 'ANY'), pivot(2, 1, 'ANY'), pivot(3, 2)],
        [action(1, 1, 'approved'), action(2, 1, 'waiting'), action(3, 2, 'approved')],
      );
      await service.evaluateAndUpdateMemoStatus(9, 70);
      expect(prisma.memoStatusPivot.update).toHaveBeenCalledWith({
        where: { id: 40 },
        data: { statusId: 3, createdAt: expect.any(Date) },
      });
      expect(noti.notifyStatusUpdate).toHaveBeenCalledWith(9, 2, 'Approver', 3, 1);
    });

    it('rejects when anyone rejected', async () => {
      setup([pivot(1, 1), pivot(2, 2)], [action(1, 1, 'approved'), action(2, 2, 'rejected')]);
      await service.evaluateAndUpdateMemoStatus(9, 70);
      expect(noti.notifyStatusUpdate).toHaveBeenCalledWith(9, 2, 'Approver', 4, 1);
    });
  });

  describe('updateStatus', () => {
    beforeEach(() => {
      prisma.masterMemo.findUnique.mockResolvedValue({ userId: 1 });
    });

    /** Every pivot lookup returns `row`, except the "already terminated?" check. */
    const latestPivot = (row: unknown) =>
      prisma.memoStatusPivot.findFirst.mockImplementation(({ where }: any) =>
        Promise.resolve(where.statusId === 7 ? null : row),
      );

    it('403s when the user cannot see the memo, 404s an unknown memo', async () => {
      access.canViewMemo.mockResolvedValue(false);
      await expect(service.updateStatus(9, 2, { statusId: 5 })).rejects.toThrow(ForbiddenException);
      prisma.masterMemo.findUnique.mockResolvedValue(null);
      await expect(service.updateStatus(9, 2, { statusId: 5 })).rejects.toThrow(NotFoundException);
    });

    it('400s anything but terminate on a terminated memo', async () => {
      prisma.memoStatusPivot.findFirst.mockResolvedValueOnce({ id: 1 });
      const err = await service.updateStatus(9, 2, { statusId: 5 }).catch((e) => e);
      expect(err.getResponse()).toEqual({
        error: 'This memo is already terminated; no further actions allowed.',
      });
    });

    it('terminate: 409 DRAFT_TERMINATE on a draft, 403 for a non-current approver', async () => {
      prisma.memoStatusPivot.findFirst
        .mockResolvedValueOnce(null) // not terminated
        .mockResolvedValueOnce({ statusId: 1 });
      prisma.status.findUnique.mockResolvedValue({ name: 'Draft' });
      const err = await service.updateStatus(9, 2, { statusId: 7 }).catch((e) => e);
      expect(err.getResponse()).toMatchObject({
        statusCode: 'DRAFT_TERMINATE',
        currentStatusId: 1,
      });

      prisma.memoStatusPivot.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ statusId: 5 });
      prisma.memoApproverAction.findMany.mockResolvedValue([
        { loaUser: { userId: 3, level: 1 } },
        { loaUser: { userId: 2, level: 2 } },
      ]);
      await expect(service.updateStatus(9, 2, { statusId: 7 })).rejects.toThrow(ForbiddenException);
    });

    it('terminate: marks the approver row, sets status 7 and notifies', async () => {
      prisma.memoStatusPivot.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ statusId: 5 })
        .mockResolvedValueOnce({ id: 40, statusId: 5 });
      prisma.memoApproverAction.findMany
        .mockResolvedValueOnce([{ loaUser: { userId: 2, level: 1 } }])
        .mockResolvedValue([{ loaUser: { id: 70, userId: 2, level: 1 } }]);

      const res = await service.updateStatus(9, 2, {
        statusId: 7,
        terminationReason: 'dup',
        fileId: 11,
      });
      expect(res).toEqual([202, { message: 'Memo terminated (emails queued)' }]);
      expect(prisma.memoApproverAction.updateMany).toHaveBeenCalledWith({
        where: { memoId: 9, loaUserId: 70, version: 2, statusId: { in: [1, 3] } },
        data: { statusId: 4, actedAt: expect.any(Date), terminationReason: 'dup' },
      });
      expect(prisma.memoHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'User 2 terminated the memo: dup',
          statusId: 5,
          fileId: 11,
        }),
      });
      await flush();
      expect(noti.notifyStatusUpdate).toHaveBeenCalledWith(9, 2, 'User 2', 7, 1);
    });

    it('reject: saves the reason on the approver row and returns 202', async () => {
      latestPivot({ id: 40, statusId: 5 });
      prisma.memoApproverAction.findMany.mockResolvedValue([
        { loaUser: { id: 70, userId: 2, level: 2 } },
      ]);
      prisma.lineOfApprovalUserPivotForUse.findFirst.mockResolvedValue({ id: 70 });
      prisma.memoApproverAction.findFirst.mockResolvedValue({ version: 2 });

      const res = await service.updateStatus(9, 2, { statusId: 4, rejectReason: 'no' });
      expect(res[0]).toBe(202);
      expect(prisma.memoApproverAction.updateMany).toHaveBeenCalledWith({
        where: { memoId: 9, loaUserId: 70, version: 2 },
        data: { statusId: 3, actedAt: expect.any(Date), rejectReason: 'no' },
      });
      await flush();
      expect(noti.notifyStatusUpdate).toHaveBeenCalledWith(9, 2, 'User 2', 4, 2);
    });

    it('publish: 400 without approvers; otherwise notifies approvers then CCs', async () => {
      latestPivot({ id: 40, statusId: 1 });
      prisma.memoApproverAction.findMany.mockResolvedValueOnce([]);
      await expect(service.updateStatus(9, 1, { statusId: 5 })).rejects.toThrow(
        BadRequestException,
      );

      prisma.memoApproverAction.findMany.mockResolvedValue([
        { loaUser: { id: 70, userId: 2, level: 1 } },
      ]);
      prisma.memoCc.findMany.mockResolvedValue([{ userId: 6 }, { userId: 6 }]);
      expect(await service.updateStatus(9, 1, { statusId: 5 })).toEqual([
        200,
        { message: 'Processing started (no version bump)' },
      ]);
      await flush();
      expect(noti.notifyStatusUpdate).toHaveBeenCalledWith(9, 1, 'User 1', 5, 0);
      expect(noti.notifyCcAssigned).toHaveBeenCalledWith(9, 1, [6]);
    });

    it('draft after a recall is logged as EDIT', async () => {
      latestPivot({ id: 40, statusId: 6 });
      await service.updateStatus(9, 1, { statusId: 1, fileId: 11 });
      expect(prisma.memoHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'User 1 edited memo after recalled',
          actiontype: ActionType.EDIT,
          statusId: 6,
          fileId: 11,
        }),
      });
    });

    it('400s an unknown status id', async () => {
      prisma.memoStatusPivot.findFirst.mockResolvedValue(null);
      const err = await service.updateStatus(9, 1, { statusId: '5' }).catch((e) => e);
      expect(err.getResponse()).toEqual({ error: 'Invalid status transition' });
    });
  });

  it('getMemoActions maps the latest row per approver', async () => {
    prisma.memoApproverAction.findMany.mockResolvedValue([
      { loaUserId: 70, status: { code: 'approved' } },
    ]);
    expect(await service.getMemoActions(9, 2)).toEqual([{ loaUserId: 70, statusCode: 'approved' }]);
    access.canViewMemo.mockResolvedValue(false);
    await expect(service.getMemoActions(9, 2)).rejects.toThrow(ForbiddenException);
  });
});
