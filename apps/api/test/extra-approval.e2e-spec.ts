import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, ForbiddenException, INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { JwtService } from '@nestjs/jwt';
import * as cookieParser from 'cookie-parser';
import { PrismaService } from '../src/prisma/prisma.service';
import { MailService } from '../src/common/mail/mail.service';
import { ExtraApprovalService } from '../src/modules/extra-approval/extra-approval.service';

describe('ExtraApproval e2e (AppModule, service mocked)', () => {
  let app: INestApplication;
  let jwt: string;

  const mockPrisma: any = {
    user: { findUnique: jest.fn() },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };
  const svc = {
    createLine: jest.fn(),
    listLines: jest.fn(),
    getActiveLine: jest.fn(),
    getActiveLinesBulk: jest.fn(),
    act: jest.fn(),
    appendApprovers: jest.fn(),
    removeLine: jest.fn(),
    searchEligibleUsers: jest.fn(),
  };

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { AppModule } = require('../src/app.module');
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PrismaService)
      .useValue(mockPrisma)
      .overrideProvider(MailService)
      .useValue({ sendEmail: jest.fn() })
      .overrideProvider(ExtraApprovalService)
      .useValue(svc)
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

  it('requires auth', async () => {
    expect((await request(server()).get('/api/memos/1/extra-approval-lines')).status).toBe(401);
  });

  it('POST create → 201 with the line', async () => {
    svc.createLine.mockResolvedValue({ id: 70 });
    const res = await auth(request(server()).post('/api/memos/9/extra-approval-lines')).send({
      userIds: [3],
      comment: 'x',
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: 70 });
    expect(svc.createLine).toHaveBeenCalledWith(9, 2, { userIds: [3], comment: 'x' });
  });

  it('passes the Express-shaped 409 body through', async () => {
    svc.createLine.mockRejectedValue(
      new ConflictException({
        code: 'MEMO_STATUS_CHANGED',
        statusCode: 'APPROVED',
        currentStatusId: 3,
      }),
    );
    const res = await auth(request(server()).post('/api/memos/9/extra-approval-lines')).send({
      userIds: [3],
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'MEMO_STATUS_CHANGED',
      statusCode: 'APPROVED',
      currentStatusId: 3,
    });
  });

  it('GET list / active', async () => {
    svc.listLines.mockResolvedValue([]);
    svc.getActiveLine.mockResolvedValue(null);
    expect((await auth(request(server()).get('/api/memos/9/extra-approval-lines'))).body).toEqual(
      [],
    );
    const active = await auth(
      request(server()).get('/api/memos/9/extra-approval-lines/active?_=123'),
    );
    expect(active.status).toBe(200);
    expect(svc.getActiveLine).toHaveBeenCalledWith(9, 2);
  });

  it('GET list 403 when the user cannot see the memo', async () => {
    svc.listLines.mockRejectedValue(new ForbiddenException({ error: 'Access denied' }));
    const res = await auth(request(server()).get('/api/memos/9/extra-approval-lines'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Access denied' });
  });

  it('POST bulk → 200 (not caught by :id routes)', async () => {
    svc.getActiveLinesBulk.mockResolvedValue({ 1: null });
    const res = await auth(
      request(server()).post('/api/memos/extra-approval-lines/active/bulk'),
    ).send({
      memoIds: [1],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ 1: null });
    expect(svc.getActiveLinesBulk).toHaveBeenCalledWith(2, [1]);
  });

  it('POST action → 200, append → 200, DELETE → 204', async () => {
    svc.act.mockResolvedValue({ ok: true, closed: null });
    svc.appendApprovers.mockResolvedValue({ id: 70 });
    svc.removeLine.mockResolvedValue(undefined);

    const act = await auth(
      request(server()).post('/api/memos/9/extra-approval-lines/70/action'),
    ).send({
      statusCode: 'approved',
    });
    expect(act.status).toBe(200);
    expect(svc.act).toHaveBeenCalledWith(9, 70, 2, 'approved');

    const app2 = await auth(
      request(server()).post('/api/memos/9/extra-approval-lines/70/append'),
    ).send({
      userIds: [5],
    });
    expect(app2.status).toBe(200);
    expect(svc.appendApprovers).toHaveBeenCalledWith(9, 70, 2, [5]);

    const del = await auth(request(server()).delete('/api/memos/9/extra-approval-lines/70'));
    expect(del.status).toBe(204);
    expect(svc.removeLine).toHaveBeenCalledWith(9, 70, 2);
  });

  it('GET eligible-users with and without a line', async () => {
    svc.searchEligibleUsers.mockResolvedValue([]);
    await auth(
      request(server()).get('/api/memos/9/extra-approval-lines/eligible-users?q=%20ab%20'),
    );
    expect(svc.searchEligibleUsers).toHaveBeenLastCalledWith(9, null, 2, 'ab');
    await auth(request(server()).get('/api/memos/9/extra-approval-lines/70/eligible-users'));
    expect(svc.searchEligibleUsers).toHaveBeenLastCalledWith(9, 70, 2, '');
  });

  it('400s for a bad line id', async () => {
    const res = await auth(request(server()).delete('/api/memos/9/extra-approval-lines/abc'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid memoId or lineId' });
  });
});
