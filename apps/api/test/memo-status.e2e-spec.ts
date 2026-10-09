import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService } from '../src/common/mail/mail.service';
import { MemoStatusService } from '../src/modules/memo-status/memo-status.service';
import { MemoRecallService } from '../src/modules/memo-status/memo-recall.service';
import { ApproverStatusService } from '../src/modules/memo-status/approver-status.service';
import { EmailActionService } from '../src/modules/memo-status/email-action.service';

describe('MemoStatus e2e (AppModule, services mocked)', () => {
  let app: INestApplication;
  let jwt: string;

  const mockPrisma: any = {
    user: { findUnique: jest.fn() },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };
  const status = {
    approveWithSignature: jest.fn(),
    act: jest.fn(),
    updateStatus: jest.fn(),
    getMemoActions: jest.fn(),
  };
  const recall = { recallLegacy: jest.fn(), recallPreserve: jest.fn(), recallClear: jest.fn() };
  const approver = { getOne: jest.fn(), getBulk: jest.fn() };
  const emailAction = { handle: jest.fn() };

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(MailService)
      .useValue({ sendEmail: jest.fn() })
      .overrideProvider(MemoStatusService)
      .useValue(status)
      .overrideProvider(MemoRecallService)
      .useValue(recall)
      .overrideProvider(ApproverStatusService)
      .useValue(approver)
      .overrideProvider(EmailActionService)
      .useValue(emailAction)
      .compile();

    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    await app.init();
    jwt = moduleFixture.get(JwtService).sign({ id: 2, name: 'U', role: 'USER', businessUnitId: 1 });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.user.findUnique.mockResolvedValue({ deletedAt: null });
  });

  const server = () => app.getHttpServer();
  const auth = (r: request.Test) => r.set('Cookie', `refreshToken=${jwt}`);

  it('requires auth on the approver routes', async () => {
    expect((await request(server()).post('/api/memos/9/action')).status).toBe(401);
    expect((await request(server()).post('/api/memos/9/status')).status).toBe(401);
  });

  it('POST action-signature → 200 with the row; 409 body passes through', async () => {
    status.approveWithSignature.mockResolvedValueOnce({ id: 500, isDelegatedApproval: false });
    const ok = await auth(request(server()).post('/api/memos/9/action-signature')).send({
      loaUserId: 70,
      statusCode: 'approved',
      signatureText: 'S',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: 500, isDelegatedApproval: false });
    expect(status.approveWithSignature).toHaveBeenCalledWith(9, 2, {
      loaUserId: 70,
      statusCode: 'approved',
      signatureText: 'S',
    });

    const body = {
      code: 'MEMO_STATUS_CHANGED',
      statusCode: 'APPROVED',
      currentStatus: 'Approved',
      currentStatusId: 3,
    };
    status.approveWithSignature.mockRejectedValueOnce(new ConflictException(body));
    const res = await auth(request(server()).post('/api/memos/9/action-signature')).send({});
    expect(res.status).toBe(409);
    expect(res.body).toEqual(body);
  });

  it('POST action → 200', async () => {
    status.act.mockResolvedValue({ ok: true });
    const res = await auth(request(server()).post('/api/memos/9/action')).send({
      loaUserId: 70,
      statusCode: 'approved',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST status uses the code the service picks and the JWT user', async () => {
    status.updateStatus.mockResolvedValue([
      202,
      { message: 'Rejected (emails will be sent async)' },
    ]);
    const res = await auth(request(server()).post('/api/memos/9/status')).send({
      statusId: 4,
      userId: 77,
      rejectReason: 'no',
    });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ message: 'Rejected (emails will be sent async)' });
    expect(status.updateStatus).toHaveBeenCalledWith(9, 2, {
      statusId: 4,
      userId: 77,
      rejectReason: 'no',
    });
  });

  it('recall routes: /recall 201, /recall-preserve and /recall-clear 200', async () => {
    recall.recallLegacy.mockResolvedValue({ message: 'a' });
    recall.recallPreserve.mockResolvedValue({ message: 'b' });
    recall.recallClear.mockResolvedValue({ message: 'c' });
    expect((await auth(request(server()).post('/api/memos/9/recall')).send({})).status).toBe(201);
    expect(
      (await auth(request(server()).post('/api/memos/9/recall-preserve')).send({ fileId: 11 }))
        .status,
    ).toBe(200);
    expect(recall.recallPreserve).toHaveBeenCalledWith(9, 2, 11);
    const clear = await auth(request(server()).post('/api/memos/9/recall-clear')).send({
      fileId: 11,
    });
    expect(clear.status).toBe(200);
    expect(recall.recallClear).toHaveBeenCalledWith(9, 2, 11);
  });

  it('approver-status single and bulk (bulk not caught by :id routes)', async () => {
    approver.getOne.mockResolvedValue([]);
    approver.getBulk.mockResolvedValue({ 9: [] });
    expect((await auth(request(server()).get('/api/memos/9/approver-status'))).body).toEqual([]);
    expect(approver.getOne).toHaveBeenCalledWith(9, 2);
    const bulk = await auth(request(server()).post('/api/memos/approver-status/bulk')).send({
      memoIds: [9],
    });
    expect(bulk.status).toBe(200);
    expect(bulk.body).toEqual({ 9: [] });
    expect(approver.getBulk).toHaveBeenCalledWith(2, [9]);
  });

  it('GET actions', async () => {
    status.getMemoActions.mockResolvedValue([{ loaUserId: 70, statusCode: 'waiting' }]);
    const res = await auth(request(server()).get('/api/memos/9/actions'));
    expect(res.body).toEqual([{ loaUserId: 70, statusCode: 'waiting' }]);
  });

  describe('GET action/email (no login)', () => {
    it('sends the HTML page with the status the service chose', async () => {
      emailAction.handle.mockResolvedValue({ status: 400, html: '<h1>used</h1>' });
      const res = await request(server()).get('/api/memos/action/email?token=t&action=approve');
      expect(res.status).toBe(400);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toBe('<h1>used</h1>');
      expect(emailAction.handle).toHaveBeenCalledWith('t', 'approve');
    });

    it('redirects reject', async () => {
      emailAction.handle.mockResolvedValue({ redirect: 'https://fe.test/memo/9?action=reject' });
      const res = await request(server()).get('/api/memos/action/email?token=t&action=reject');
      expect(res.status).toBe(302);
      expect(res.headers['location']).toBe('https://fe.test/memo/9?action=reject');
    });

    it('empty 400 for a bad token', async () => {
      emailAction.handle.mockResolvedValue({ status: 400, html: '' });
      const res = await request(server()).get('/api/memos/action/email?token=x&action=approve');
      expect(res.status).toBe(400);
      expect(res.text).toBe('');
    });
  });
});
