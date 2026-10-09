import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ActionType, ExtraStatus } from '@prisma/client';
import { MemoRecallService } from './memo-recall.service';

const STATUS_BY_NAME: Record<string, number> = { Rejected: 4, Recall: 6, Draft: 1 };

function makePrisma() {
  const p: any = {
    masterMemo: { findUnique: jest.fn().mockResolvedValue({ userId: 1 }) },
    memoStatusPivot: {
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    approvalActionStatus: { findUnique: jest.fn().mockResolvedValue({ id: 1 }) },
    memoApproverAction: { updateMany: jest.fn() },
    memoHistory: { create: jest.fn(), deleteMany: jest.fn() },
    extraApprovalLine: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    extraApprover: {
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    comment: { updateMany: jest.fn() },
    status: {
      findFirst: jest.fn(({ where }: any) => {
        const name = where.name.in.find((n: string) => n in STATUS_BY_NAME);
        return Promise.resolve(name ? { id: STATUS_BY_NAME[name] } : null);
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ name: 'Own' }) },
  };
  p.$transaction = jest.fn((arg: any) => (typeof arg === 'function' ? arg(p) : Promise.all(arg)));
  return p;
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

describe('MemoRecallService', () => {
  let prisma: any;
  let access: any;
  let search: any;
  let noti: any;
  let service: MemoRecallService;

  beforeEach(() => {
    prisma = makePrisma();
    access = { canViewMemo: jest.fn().mockResolvedValue(true) };
    search = { invalidateAll: jest.fn() };
    noti = {
      getLatestVersion: jest.fn().mockResolvedValue(3),
      getUserDisplayName: jest.fn().mockResolvedValue('Owner O'),
      notifyRecallUpdate: jest.fn().mockResolvedValue(undefined),
    };
    service = new MemoRecallService(prisma, access, search, noti);
  });

  describe('recallClear', () => {
    it('400s a bad id and 403s a user who cannot see the memo', async () => {
      await expect(service.recallClear(NaN, 1, undefined)).rejects.toThrow(BadRequestException);
      access.canViewMemo.mockResolvedValue(false);
      await expect(service.recallClear(9, 1, undefined)).rejects.toThrow(ForbiddenException);
    });

    it('409s unless Processing or Rejected', async () => {
      prisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 3 });
      const err = await service.recallClear(9, 1, undefined).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({
        code: 'MEMO_STATUS_CHANGED',
        statusCode: 'APPROVED',
        currentStatusId: 3,
      });
    });

    it('resets approvals, moves to Draft, removes extra lines and logs a recall', async () => {
      prisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
      prisma.extraApprovalLine.findMany.mockResolvedValue([{ id: 30 }, { id: 31 }]);

      const res = await service.recallClear(9, 1, '11');

      expect(res).toEqual({
        message: 'Recall done on version 3',
        removedExtraLines: 2,
        performedBy: { id: 1, name: 'Owner O' },
      });
      expect(prisma.memoApproverAction.updateMany).toHaveBeenCalledWith({
        where: { memoId: 9, version: 3 },
        data: expect.objectContaining({ statusId: 1, actedAt: null, emailToken: null }),
      });
      expect(
        prisma.memoStatusPivot.upsert.mock.calls.map((c: any) => c[0].create.statusId),
      ).toEqual([6, 1]);
      expect(prisma.comment.updateMany).toHaveBeenCalledWith({
        where: { extraApprovalLineId: { in: [30, 31] } },
        data: { isRecallExtra: true, extraApprovalLineId: null },
      });
      expect(prisma.memoHistory.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          action: 'Owner O recalled the memo',
          actiontype: ActionType.RECALL,
          fileId: 11,
          statusId: 5,
        }),
      });
      expect(search.invalidateAll).toHaveBeenCalled();
      await flush();
      expect(noti.notifyRecallUpdate).toHaveBeenCalledWith(9, 1, 'Owner O');
    });

    it('logs REVISE when an extra approver had rejected', async () => {
      prisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 5 });
      prisma.extraApprover.count.mockResolvedValue(1);
      await service.recallClear(9, 1, undefined);
      expect(prisma.memoHistory.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          action: 'Owner O revised the memo',
          actiontype: ActionType.REVISE,
        }),
      });
    });

    it('maps unexpected errors to 500 { error }', async () => {
      prisma.memoStatusPivot.findFirst.mockResolvedValue({ statusId: 4 });
      prisma.masterMemo.findUnique.mockResolvedValue(null);
      const err = await service.recallClear(9, 1, undefined).catch((e) => e);
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect(err.getResponse()).toEqual({ error: 'internal error' });
    });
  });

  it('recallPreserve keeps approvals and writes two history rows', async () => {
    prisma.memoStatusPivot.findFirst
      .mockResolvedValueOnce({ statusId: 4 }) // gate
      .mockResolvedValueOnce({ statusId: 4 }) // prev by id
      .mockResolvedValue({ id: 40, statusId: 4 });

    expect(await service.recallPreserve(9, 1, 11)).toEqual({ message: 'Recall (preserve) done' });
    expect(prisma.memoStatusPivot.deleteMany).toHaveBeenCalledWith({
      where: { memoId: 9, statusId: { in: [3, 4, 5] } },
    });
    expect(prisma.memoApproverAction.updateMany).not.toHaveBeenCalled();
    expect(prisma.memoHistory.create.mock.calls.map((c: any) => c[0].data.action)).toEqual([
      'Own recalled memo (preserve)',
      'Own set memo back to Draft (preserve)',
    ]);
  });

  it('recallLegacy wipes Processing history and soft-resets open extra lines', async () => {
    prisma.extraApprovalLine.findMany.mockResolvedValue([{ id: 30 }]);
    expect(await service.recallLegacy(9, 1)).toEqual({
      message: 'Memo recalled; previous approvals cleared (including Extra waiting reset).',
    });
    expect(prisma.memoStatusPivot.create).toHaveBeenCalledWith({
      data: { memoId: 9, userId: 1, statusId: 6 },
    });
    expect(prisma.memoHistory.deleteMany).toHaveBeenCalledWith({
      where: { memoId: 9, statusId: 5 },
    });
    expect(prisma.extraApprovalLine.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [30] } },
      data: { status: ExtraStatus.PENDING, closedAt: null },
    });
  });

  it('handleRecall resets only waiting/rejected rows and bumps Recall then Draft', async () => {
    prisma.memoStatusPivot.findFirst.mockResolvedValue({ id: 40 });
    await service.handleRecall({ memoId: 9, loaUserId: 70 });
    expect(prisma.memoApproverAction.updateMany).toHaveBeenCalledWith({
      where: { memoId: 9, version: 3, status: { code: { in: ['waiting', 'rejected'] } } },
      data: expect.any(Object),
    });
    expect(prisma.memoStatusPivot.update.mock.calls.map((c: any) => c[0].data.statusId)).toEqual([
      6, 1,
    ]);
  });
});
