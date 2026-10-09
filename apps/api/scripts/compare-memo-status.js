/* eslint-disable */
// Batch 8b write/read parity: Express handlers on DB A, Nest services on DB B
// (both cloned from the same fixture DB), same op sequence. Compares responses,
// captured emails, notify* calls and the final rows of every touched table.
//
//   URL_A=postgresql://…/hl_a URL_B=postgresql://…/hl_b node apps/api/scripts/compare-memo-status.js .
//
// Needs `nest build` first. Times are real (ordering by createdAt must behave),
// so timestamps are normalised to "<t>" before comparing.
const path = require('path');
const root = path.resolve(process.argv[2] || '.');
const backend = path.join(root, 'backend');
const apiDist = path.join(root, 'apps/api/dist');
const URL_A = process.env.URL_A;
const URL_B = process.env.URL_B;
if (!URL_A || !URL_B || !/:55432\//.test(URL_A) || !/:55432\//.test(URL_B)) {
  console.error('URL_A / URL_B must point at the throwaway parity DB (port 55432)');
  process.exit(2);
}
process.env.DATABASE_URL = URL_A;
process.env.FRONTEND_URL = 'https://fe.test';
process.env.APP_BASE_URL = 'https://api.test';
process.env.EMAIL_TOKEN_SECRET = 'parity-secret';

require(require.resolve('ts-node', { paths: [backend] })).register({
  transpileOnly: true,
  project: path.join(backend, 'tsconfig.json'),
});
require(require.resolve('reflect-metadata', { paths: [apiDist] }));
const out = console.log;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

// ── async capture: every setImmediate callback's promise is awaited by drain() ──
const realSetImmediate = global.setImmediate;
let pending = [];
global.setImmediate = (fn, ...a) =>
  realSetImmediate(() => {
    const r = fn(...a);
    if (r && typeof r.then === 'function') pending.push(r.catch(() => {}));
  });
async function drain() {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => realSetImmediate(r));
    if (pending.length) await Promise.allSettled(pending.splice(0));
    else if (i > 4) break;
  }
}

// ── legacy (Express) ────────────────────────────────────────────────────────
let mailsA = [];
let mailsB = [];
let notA = [];
let notB = [];
require(path.join(backend, 'src/lib/mailer')).sendEmail = async (...a) => {
  mailsA.push(a);
};
const legacyNoti = require(path.join(backend, 'src/services/memoNotification.service'));
for (const fn of ['notifyStatusUpdate', 'notifyCcAssigned', 'notifyRecallUpdate']) {
  legacyNoti[fn] = async (...a) => {
    notA.push([fn, ...a]);
  };
}
const legacyApprove = require(path.join(backend, 'src/services/memoApproveAction.service'));
const origEvaluate = legacyApprove.evaluateAndUpdateMemoStatus;
legacyApprove.evaluateAndUpdateMemoStatus = (...a) => {
  const p = origEvaluate(...a);
  pending.push(p.catch(() => {}));
  return p;
};
const legacyStatus = require(path.join(backend, 'src/controllers/memoStatus.controller'));
const legacyRecall = require(path.join(backend, 'src/services/memoRecall.service'));
const legacyEmail = require(path.join(backend, 'src/controllers/emailAction.controller'));
const { prisma: prismaA } = require(path.join(backend, 'prisma/client'));

// ── Nest ────────────────────────────────────────────────────────────────────
const dbPkg = require.resolve('@hl/database', { paths: [apiDist] });
const { PrismaClient } = require(require.resolve('@prisma/client', { paths: [dbPkg] }));
const prismaB = new PrismaClient({ datasources: { db: { url: URL_B } } });
const { Logger } = require(require.resolve('@nestjs/common', { paths: [apiDist] }));
Logger.overrideLogger(false);
const D = (p) => require(path.join(apiDist, p));
const { MemoNotificationService } = D('modules/memo-notification/memo-notification.service');
const { EmailPreferenceService } = D('common/mail/email-preference.service');
const { MemoAccessService } = D('modules/memo-query/memo-access.service');
const { ExtraApprovalService } = D('modules/extra-approval/extra-approval.service');
const { MemoStatusService } = D('modules/memo-status/memo-status.service');
const { MemoRecallService } = D('modules/memo-status/memo-recall.service');
const { ApproverStatusService } = D('modules/memo-status/approver-status.service');
const { EmailActionService } = D('modules/memo-status/email-action.service');
const { makeEmailToken } = D('modules/memo-notification/email-token');

const mailB = {
  sendEmail: async (...a) => {
    mailsB.push(a);
  },
};
const prefs = new EmailPreferenceService(prismaB);
const noti = new MemoNotificationService(prismaB, mailB, prefs);
for (const fn of ['notifyStatusUpdate', 'notifyCcAssigned', 'notifyRecallUpdate']) {
  noti[fn] = async (...a) => {
    notB.push([fn, ...a]);
  };
}
const access = new MemoAccessService(prismaB);
const search = { invalidateAll() {} };
const extra = new ExtraApprovalService(prismaB, mailB, prefs, access, noti);
const recallB = new MemoRecallService(prismaB, access, search, noti);
const statusB = new MemoStatusService(prismaB, mailB, prefs, access, search, noti, extra, recallB);
statusB.later = (label, fn) => {
  pending.push(fn().catch(() => {}));
};
const origEvalB = statusB.evaluateAndUpdateMemoStatus.bind(statusB);
statusB.evaluateAndUpdateMemoStatus = (...a) => {
  const p = origEvalB(...a);
  pending.push(p.catch(() => {}));
  return p;
};
const approverB = new ApproverStatusService(prismaB);
const emailB = new EmailActionService(prismaB, noti, statusB);

// ── call helpers ────────────────────────────────────────────────────────────
function express(handler, { params = {}, body = {}, query = {}, userId }) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        resolve({ status: this.statusCode, body: b });
        return this;
      },
      send(b) {
        resolve({ status: this.statusCode, body: b === undefined ? '' : b });
        return this;
      },
      redirect(u) {
        resolve({ status: 302, redirect: u });
      },
    };
    const req = { params, body, query, user: userId ? { id: userId } : undefined };
    Promise.resolve()
      .then(() => handler(req, res, (e) => resolve({ status: 500, error: String(e) })))
      .catch(() => resolve({ status: 500, body: { message: 'Internal server error' } }));
  });
}
async function nest(fn, okStatus = 200) {
  try {
    const r = await fn();
    if (Array.isArray(r) && typeof r[0] === 'number') return { status: r[0], body: r[1] };
    if (r && 'redirect' in r) return { status: 302, redirect: r.redirect };
    if (r && 'html' in r && 'status' in r) return { status: r.status, body: r.html };
    return { status: okStatus, body: r };
  } catch (e) {
    return typeof e.getStatus === 'function'
      ? { status: e.getStatus(), body: e.getResponse() }
      : { status: 500, body: { message: 'Internal server error' } };
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const norm = (v) =>
  JSON.parse(
    JSON.stringify(v ?? null, (k, x) => {
      if (x instanceof Date) return '<t>';
      if (typeof x === 'string' && ISO.test(x)) return '<t>';
      return x;
    }),
  );

async function dump(p) {
  const tables = [
    'MemoStatusPivot',
    'MemoHistory',
    'MemoApproverAction',
    'Notification',
    'ExtraApprovalLine',
    'ExtraApprover',
    'Comment',
  ];
  const r = {};
  for (const t of tables) r[t] = norm(await p.$queryRawUnsafe(`select * from "${t}" order by id`));
  return r;
}

/** Lowest-level waiting approver of the latest version (read from DB A). */
async function currentWaiting(memoId) {
  const agg = await prismaA.memoApproverAction.aggregate({ where: { memoId }, _max: { version: true } });
  const rows = await prismaA.memoApproverAction.findMany({
    where: { memoId, version: agg._max.version ?? 1, status: { code: 'waiting' } },
    select: { id: true, loaUserId: true, assignedUserId: true, loaUser: { select: { userId: true, level: true } } },
    orderBy: [{ loaUser: { level: 'asc' } }, { loaUserId: 'asc' }],
  });
  const r = rows.find((x) => (x.assignedUserId ?? x.loaUser.userId) != null);
  return r ? { actionId: r.id, loaUserId: r.loaUserId, userId: r.assignedUserId ?? r.loaUser.userId } : null;
}

(async () => {
  const memos = await prismaA.$queryRawUnsafe(
    `select m.id, m."userId" from "MasterMemo" m where (select "statusId" from "MemoStatusPivot" p where p."memoId"=m.id order by "createdAt" desc limit 1)=5 order by m.id`,
  );
  const allIds = (await prismaA.masterMemo.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((m) => m.id);
  let checked = 0;
  let diffs = 0;
  let intended = 0;
  const byOp = {};

  // `allow(ra, rb)`: a difference Nest makes on purpose (tighter access), counted separately.
  const step = async (label, a, b, allow) => {
    mailsA = [];
    mailsB = [];
    notA = [];
    notB = [];
    const ra = await a();
    await drain();
    const rb = await b();
    await drain();
    checked++;
    const op = label.split(' ')[0];
    byOp[op] = byOp[op] || { n: 0, status: {} };
    byOp[op].n++;
    byOp[op].status[ra.status] = (byOp[op].status[ra.status] || 0) + 1;
    const ja = JSON.stringify(norm({ r: ra, mails: mailsA, notify: notA }));
    const jb = JSON.stringify(norm({ r: rb, mails: mailsB, notify: notB }));
    if (ja !== jb && allow && allow(ra, rb)) {
      intended++;
    } else if (ja !== jb) {
      diffs++;
      if (diffs <= 15) out(`DIFF ${label}\n  legacy ${ja.slice(0, 700)}\n  nest   ${jb.slice(0, 700)}`);
    }
    return ra;
  };
  const both = async (sql) => {
    await prismaA.$executeRawUnsafe(sql);
    await prismaB.$executeRawUnsafe(sql);
  };

  // Read paths over every memo, before any write.
  for (const id of allIds) {
    const owner = (await prismaA.masterMemo.findUnique({ where: { id }, select: { userId: true } })).userId;
    await step(
      `approver-status m=${id}`,
      () => express(legacyStatus.getApproverStatus, { params: { id: String(id) }, userId: owner }),
      () => nest(() => approverB.getOne(id, owner)),
      (ra, rb) => rb.status === 403,
    );
  }
  const users = (await prismaA.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((u) => u.id);
  for (const u of users) {
    await step(
      `bulk u=${u}`,
      () => express(legacyStatus.getApproverStatusBulk, { body: { memoIds: [...allIds, 'x', -1] }, userId: u }),
      () => nest(() => approverB.getBulk(u, [...allIds, 'x', -1])),
    );
  }

  for (const m of memos) {
    const id = m.id;
    const owner = m.userId;
    const v = id % 6;
    const P = { id: String(id) };
    const fileId = (await prismaA.mainFile.findFirst({ where: { memoId: id }, select: { id: true } }))?.id;

    await step(
      `actions m=${id}`,
      () => express(legacyStatus.getMemoActions, { params: P, userId: owner }),
      () => nest(() => statusB.getMemoActions(id, owner)),
    );
    await step(
      `bad-sig m=${id}`,
      () => express(legacyApprove.approveAction, { params: P, body: { statusCode: 'approved' }, userId: owner }),
      () => nest(() => statusB.approveWithSignature(id, owner, { statusCode: 'approved' })),
    );

    // First approver acts — a different route per memo.
    let w = await currentWaiting(id);
    if (w) {
      const sigBody = (code, cond) => ({
        loaUserId: w.loaUserId,
        statusCode: code,
        signatureText: ' Sig ',
        ...(cond ? { approveWithCondition: cond } : {}),
      });
      if (v === 0) {
        await step(
          `sig-approve m=${id}`,
          () => express(legacyApprove.approveAction, { params: P, body: sigBody('approved', ' within budget '), userId: w.userId }),
          () => nest(() => statusB.approveWithSignature(id, w.userId, sigBody('approved', ' within budget '))),
        );
      } else if (v === 1) {
        const body = { loaUserId: w.loaUserId, statusCode: 'approved' };
        await step(
          `act-approve m=${id}`,
          () => express(legacyStatus.actOnMemo, { params: P, body, userId: w.userId }),
          () => nest(() => statusB.act(id, w.userId, body)),
        );
      } else if (v === 2) {
        const body = { statusId: 4, userId: w.userId, rejectReason: 'not this time' };
        await step(
          `status-reject m=${id}`,
          () => express(legacyStatus.updateMemoStatus, { params: P, body, userId: w.userId }),
          () => nest(() => statusB.updateStatus(id, w.userId, body)),
        );
      } else if (v === 3) {
        const body = { statusId: 7, userId: w.userId, terminationReason: 'duplicate', fileId };
        await step(
          `status-terminate m=${id}`,
          () => express(legacyStatus.updateMemoStatus, { params: P, body, userId: w.userId }),
          () => nest(() => statusB.updateStatus(id, w.userId, body)),
        );
      } else if (v === 4) {
        const token = makeEmailToken(id, w.actionId);
        await both(`update "MemoApproverAction" set "emailToken"='${token}' where id=${w.actionId}`);
        await step(
          `email-reject m=${id}`,
          () => express(legacyEmail.handleEmailAction, { query: { token, action: 'reject' } }),
          () => nest(() => emailB.handle(token, 'reject')),
        );
        await step(
          `email-approve m=${id}`,
          () => express(legacyEmail.handleEmailAction, { query: { token, action: 'Approve' } }),
          () => nest(() => emailB.handle(token, 'Approve')),
        );
        await step(
          `email-reuse m=${id}`,
          () => express(legacyEmail.handleEmailAction, { query: { token, action: 'approve' } }),
          () => nest(() => emailB.handle(token, 'approve')),
        );
      } else {
        await step(
          `sig-reject m=${id}`,
          () => express(legacyApprove.approveAction, { params: P, body: sigBody('rejected'), userId: w.userId }),
          () => nest(() => statusB.approveWithSignature(id, w.userId, sigBody('rejected'))),
        );
      }
    }

    // Second approver (if the memo is still going).
    w = await currentWaiting(id);
    if (w) {
      if (id % 2 === 0) {
        const body = { loaUserId: w.loaUserId, statusCode: 'approved' };
        await step(
          `act-approve2 m=${id}`,
          () => express(legacyStatus.actOnMemo, { params: P, body, userId: w.userId }),
          () => nest(() => statusB.act(id, w.userId, body)),
        );
      } else {
        const token = makeEmailToken(id, w.actionId);
        await both(`update "MemoApproverAction" set "emailToken"='${token}' where id=${w.actionId}`);
        if (id % 5 === 0) {
          await both(`update "MasterMemo" set "expiresAt"=now() - interval '1 day' where id=${id}`);
        }
        await step(
          `email-terminate m=${id}`,
          () => express(legacyEmail.handleEmailAction, { query: { token, action: 'terminate' } }),
          () => nest(() => emailB.handle(token, 'terminate')),
        );
        const stale = makeEmailToken(id, w.actionId) + 'x';
        await step(
          `email-badtoken m=${id}`,
          () => express(legacyEmail.handleEmailAction, { query: { token: stale, action: 'approve' } }),
          () => nest(() => emailB.handle(stale, 'approve')),
        );
      }
    }

    // A repeat approve on a finished row / non-Processing memo.
    if (w) {
      const body = { loaUserId: w.loaUserId, statusCode: 'approved', signatureText: 'again' };
      await step(
        `sig-repeat m=${id}`,
        () => express(legacyApprove.approveAction, { params: P, body, userId: w.userId }),
        () => nest(() => statusB.approveWithSignature(id, w.userId, body)),
      );
    }

    // Owner recalls, then publishes again.
    await step(
      `recall-clear m=${id}`,
      () => express(legacyRecall.recallClear, { params: P, body: { userId: owner, fileId }, userId: owner }),
      () => nest(() => recallB.recallClear(id, owner, fileId)),
    );
    if (v % 3 === 0) {
      const draft = { statusId: 1, userId: owner, fileId };
      await step(
        `status-draft m=${id}`,
        () => express(legacyStatus.updateMemoStatus, { params: P, body: draft, userId: owner }),
        () => nest(() => statusB.updateStatus(id, owner, draft)),
      );
    }
    const publish = { statusId: 5, userId: owner };
    await step(
      `status-publish m=${id}`,
      () => express(legacyStatus.updateMemoStatus, { params: P, body: publish, userId: owner }),
      () => nest(() => statusB.updateStatus(id, owner, publish)),
    );
    await step(
      `approver-status-after m=${id}`,
      () => express(legacyStatus.getApproverStatus, { params: P, userId: owner }),
      () => nest(() => approverB.getOne(id, owner)),
    );

    // Less-used routes.
    if (v === 0 || v === 3) {
      await step(
        `recall-preserve m=${id}`,
        () => express(legacyRecall.recallPreserve, { params: P, body: { userId: owner, fileId }, userId: owner }),
        () => nest(() => recallB.recallPreserve(id, owner, fileId)),
      );
    }
    if (v === 1) {
      await step(
        `recall-legacy m=${id}`,
        () => express(legacyRecall.recallMemo, { params: P, body: { userId: owner }, userId: owner }),
        () => nest(() => recallB.recallLegacy(id, owner), 201),
      );
      for (const statusId of [6, 3, 99]) {
        const body = { statusId, userId: owner, fileId };
        await step(
          `status-${statusId} m=${id}`,
          () => express(legacyStatus.updateMemoStatus, { params: P, body, userId: owner }),
          () => nest(() => statusB.updateStatus(id, owner, body)),
        );
      }
    }
    w = await currentWaiting(id);
    if (w && (v === 2 || v === 4 || v === 5)) {
      const code = { 2: 'recalled', 4: 'processing', 5: 'terminated' }[v];
      const body = { loaUserId: w.loaUserId, statusCode: code };
      await step(
        `act-${code} m=${id}`,
        () => express(legacyStatus.actOnMemo, { params: P, body, userId: w.userId }),
        () => nest(() => statusB.act(id, w.userId, body)),
      );
      const bad = { loaUserId: w.loaUserId, statusCode: 'maybe' };
      await step(
        `act-bad m=${id}`,
        () => express(legacyStatus.actOnMemo, { params: P, body: bad, userId: w.userId }),
        () => nest(() => statusB.act(id, w.userId, bad)),
      );
    }
  }

  const da = await dump(prismaA);
  const db = await dump(prismaB);
  for (const t of Object.keys(da)) {
    checked++;
    if (JSON.stringify(da[t]) !== JSON.stringify(db[t])) {
      diffs++;
      out(`DIFF table ${t}: legacy ${da[t].length} rows, nest ${db[t].length} rows`);
      for (let i = 0; i < Math.max(da[t].length, db[t].length); i++) {
        if (JSON.stringify(da[t][i]) !== JSON.stringify(db[t][i])) {
          out(`  first diff\n  ${JSON.stringify(da[t][i])}\n  ${JSON.stringify(db[t][i])}`);
          break;
        }
      }
    } else out(`table ${t}: ${da[t].length} rows identical`);
  }
  out('\nops (legacy status codes):');
  for (const [op, s] of Object.entries(byOp)) out(`  ${op.padEnd(22)} ${s.n}  ${JSON.stringify(s.status)}`);
  out(
    `\n${memos.length} Processing memos, ${checked} checks, ${diffs} differences, ${intended} intended (Nest 403 where Express answered)`,
  );
  await prismaA.$disconnect();
  await prismaB.$disconnect();
  process.exit(diffs ? 1 : 0);
})().catch((e) => {
  out(e);
  process.exit(2);
});
