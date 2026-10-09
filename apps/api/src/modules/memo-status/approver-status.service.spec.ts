import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApproverStatusService } from './approver-status.service';

const T = (s: string) => new Date(`2026-01-0${s}T00:00:00Z`);

describe('ApproverStatusService', () => {
  let prisma: any;
  let service: ApproverStatusService;

  beforeEach(() => {
    prisma = {
      masterMemo: { findMany: jest.fn() },
      memoApproverAction: { groupBy: jest.fn(), findMany: jest.fn() },
      lineOfApprovalUserPivot: { findMany: jest.fn() },
    };
    service = new ApproverStatusService(prisma);
  });

  const memo = (
    id: number,
    status = 'Processing',
    userId = 1,
    approvalLineId: number | null = 50,
  ) => ({
    id,
    userId,
    approvalLineId,
    statuses: [{ status: { name: status } }],
  });
  const row = (
    memoId: number,
    userId: number,
    level: number,
    code: string,
    actedAt: Date | null,
    approvalRequirement = 'ALL',
  ) => ({
    memoId,
    loaUserId: userId * 10,
    actedAt,
    createdAt: T('1'),
    status: { code },
    loaUser: {
      level,
      userId,
      approvalRequirement,
      user: { name: `U${userId}`, lastname: null, nickname: null },
    },
  });

  it('builds waiting / not_required / borrowed "since" from the snapshot', async () => {
    prisma.masterMemo.findMany.mockResolvedValue([memo(9)]);
    prisma.memoApproverAction.groupBy.mockResolvedValue([{ memoId: 9, _max: { version: 2 } }]);
    prisma.memoApproverAction.findMany.mockResolvedValue([
      row(9, 2, 1, 'approved', T('3'), 'ANY'),
      row(9, 3, 1, 'waiting', null, 'ANY'),
      row(9, 4, 2, 'waiting', null),
    ]);

    const res: any = await service.getBulk(1, [9, '9', -1, 'x']);

    expect(Object.keys(res)).toEqual(['9']);
    expect(res[9]).toEqual([
      {
        userId: 2,
        name: 'U2',
        level: 1,
        statusCode: 'approved',
        actedAt: T('3').toISOString(),
        since: T('3').toISOString(),
        approvalRequirement: 'ANY',
        isLevelSatisfied: true,
        approvedBy: 'U2',
      },
      {
        userId: 3,
        name: 'U3',
        level: 1,
        statusCode: 'not_required',
        actedAt: undefined,
        since: null,
        approvalRequirement: 'ANY',
        isLevelSatisfied: true,
        approvedBy: 'U2',
      },
      {
        userId: 4,
        name: 'U4',
        level: 2,
        statusCode: 'waiting',
        actedAt: undefined,
        since: T('3').toISOString(),
        approvalRequirement: 'ALL',
        isLevelSatisfied: false,
      },
    ]);
    expect(prisma.memoApproverAction.findMany.mock.calls[0][0].where).toEqual({
      OR: [{ memoId: 9, version: 2 }],
    });
  });

  it('falls back to the approval line for drafts and hides other people’s drafts', async () => {
    prisma.masterMemo.findMany.mockResolvedValue([
      memo(9, 'Draft', 1),
      memo(10, 'Draft', 2),
      memo(11, 'Deleted'),
    ]);
    prisma.memoApproverAction.groupBy.mockResolvedValue([]);
    prisma.lineOfApprovalUserPivot.findMany.mockResolvedValue([
      {
        lineOfApprovalId: 50,
        userId: 5,
        level: 1,
        user: { name: 'Five', lastname: 'F', nickname: 'ff' },
      },
    ]);

    const res: any = await service.getBulk(1, [9, 10, 11]);
    expect(Object.keys(res)).toEqual(['9']);
    expect(res[9]).toEqual([
      {
        userId: 5,
        name: 'Five F (ff)',
        level: 1,
        statusCode: 'waiting',
        actedAt: undefined,
        since: null,
      },
    ]);
  });

  it('validates the bulk input', async () => {
    await expect(service.getBulk(1, 'x')).rejects.toThrow(BadRequestException);
    expect(await service.getBulk(1, [])).toEqual({});
    await expect(
      service.getBulk(
        1,
        Array.from({ length: 5001 }, (_, i) => i + 1),
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('single memo: 403 when not visible, rows otherwise', async () => {
    prisma.masterMemo.findMany.mockResolvedValueOnce([]);
    await expect(service.getOne(9, 1)).rejects.toThrow(ForbiddenException);

    prisma.masterMemo.findMany.mockResolvedValue([memo(9, 'Processing', 1, null)]);
    prisma.memoApproverAction.groupBy.mockResolvedValue([]);
    expect(await service.getOne(9, 1)).toEqual([]);
  });
});
