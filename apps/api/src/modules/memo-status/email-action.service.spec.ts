import { EmailActionService } from './email-action.service';
import { makeEmailToken } from '../memo-notification/email-token';

const ACTION_STATUS: Record<string, number> = {
  waiting: 1,
  approved: 2,
  rejected: 3,
  terminated: 4,
};

describe('EmailActionService', () => {
  let prisma: any;
  let noti: any;
  let status: any;
  let service: EmailActionService;
  let token: string;

  beforeEach(() => {
    process.env['EMAIL_TOKEN_SECRET'] = 'test-secret';
    process.env['FRONTEND_URL'] = 'https://fe.test/';
    token = makeEmailToken(9, 500);
    prisma = {
      approvalActionStatus: {
        findUnique: jest.fn(({ where }: any) => {
          if (where.code) return Promise.resolve({ id: ACTION_STATUS[where.code] });
          const code = Object.keys(ACTION_STATUS).find((k) => ACTION_STATUS[k] === where.id);
          return Promise.resolve({ code });
        }),
      },
      memoApproverAction: {
        findUnique: jest.fn(({ select }: any) =>
          Promise.resolve(
            select.emailToken
              ? { emailToken: token, statusId: 1, loaUserId: 70 }
              : { approveWithCondition: null, rejectReason: 'too much', terminationReason: null },
          ),
        ),
        update: jest.fn(),
      },
      lineOfApprovalUserPivotForUse: {
        findUnique: jest.fn().mockResolvedValue({
          userId: 2,
          user: { name: 'Ap', lastname: 'P', nickname: 'ap', defaultSignatureText: null },
        }),
      },
      masterMemo: {
        findUnique: jest.fn(({ select }: any) =>
          Promise.resolve(select.expiresAt ? { expiresAt: null } : { userId: 1 }),
        ),
      },
      memoStatusPivot: { findUnique: jest.fn().mockResolvedValue({ id: 1 }), create: jest.fn() },
      memoHistory: { create: jest.fn() },
    };
    noti = { notifyStatusUpdate: jest.fn().mockResolvedValue(undefined) };
    status = { evaluateAndUpdateMemoStatus: jest.fn().mockResolvedValue(undefined) };
    service = new EmailActionService(prisma, noti, status);
  });

  it('400s a missing token or unknown action, and a bad signature', async () => {
    expect(await service.handle(undefined, 'approve')).toEqual({
      status: 400,
      html: 'ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว',
    });
    expect(await service.handle(token, 'delete')).toMatchObject({ status: 400 });
    expect(await service.handle('garbage', 'approve')).toEqual({ status: 400, html: '' });
  });

  it('redirects reject to the frontend', async () => {
    expect(await service.handle(token, 'REJECT')).toEqual({
      redirect: `https://fe.test/memo/9?action=reject&token=${token}`,
    });
  });

  it('approves: clears the token, signs with the display name, re-evaluates', async () => {
    const res: any = await service.handle(token, 'approve');
    expect(res.status).toBe(200);
    expect(res.html).toContain('Document has been approved');
    expect(res.html).toContain('href="https://fe.test/memos/9"');
    expect(res.html).not.toContain('__CONDITION_SECTION__');
    expect(prisma.memoApproverAction.update).toHaveBeenCalledWith({
      where: { id: 500 },
      data: {
        statusId: 2,
        actedAt: expect.any(Date),
        emailToken: null,
        signatureText: 'Ap P (ap)',
      },
    });
    expect(prisma.memoHistory.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 2, action: 'Ap Approved the memo via email' }),
    });
    expect(status.evaluateAndUpdateMemoStatus).toHaveBeenCalledWith(9, 70);
  });

  it('shows the already-used page with the reject reason', async () => {
    prisma.memoApproverAction.findUnique.mockImplementation(({ select }: any) =>
      Promise.resolve(
        select.emailToken
          ? { emailToken: null, statusId: 3, loaUserId: 70 }
          : { approveWithCondition: null, rejectReason: 'too much', terminationReason: null },
      ),
    );
    const res: any = await service.handle(token, 'approve');
    expect(res.status).toBe(400);
    expect(res.html).toContain('This document has been already Rejected');
    expect(res.html).toContain('Reject Reason:</p>');
    expect(res.html).toContain('too much');
    expect(prisma.memoApproverAction.update).not.toHaveBeenCalled();
  });

  it('refuses a superseded token, an expired memo and a non-Processing memo', async () => {
    prisma.memoApproverAction.findUnique.mockImplementationOnce(() =>
      Promise.resolve({ emailToken: 'newer', statusId: 1, loaUserId: 70 }),
    );
    expect(((await service.handle(token, 'approve')) as any).html).toContain(
      'This link has been canceled or already used',
    );

    prisma.masterMemo.findUnique.mockImplementationOnce(() =>
      Promise.resolve({ expiresAt: new Date(Date.now() - 1000) }),
    );
    expect(((await service.handle(token, 'approve')) as any).html).toContain(
      'You cannot approve this document because it has already expired.',
    );

    prisma.memoStatusPivot.findUnique.mockResolvedValueOnce(null);
    const res: any = await service.handle(token, 'terminate');
    expect(res.status).toBe(400);
    expect(res.html).toContain('<h1>Cannot terminate</h1>');
  });

  it('terminate: writes status 7, renders the page, notifies after', async () => {
    const res: any = await service.handle(token, 'terminate');
    expect(res.status).toBe(200);
    expect(res.html).toContain('Memo has been terminated');
    expect(prisma.memoStatusPivot.create).toHaveBeenCalledWith({
      data: { memoId: 9, userId: 1, statusId: 7 },
    });
    await new Promise((r) => setImmediate(r));
    expect(noti.notifyStatusUpdate).toHaveBeenCalledWith(9, 2, 'Ap', 7, null);
    expect(status.evaluateAndUpdateMemoStatus).not.toHaveBeenCalled();
  });
});
