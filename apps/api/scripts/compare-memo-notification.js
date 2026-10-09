// Parity check for the memo notification port (Batch 8a-2): runs the same
// notify* calls through backend memoNotification.service (legacy) and
// MemoNotificationService (apps/api/dist) against one database, with mail
// captured instead of sent, and diffs emails + created notifications.
//
// WRITES to the database (Notification rows, emailToken) — throwaway DB only.
//
// Usage (from repo root, after `pnpm --filter apps/api build`):
//   DATABASE_URL=...:55432/... UPLOADS_DIR=<uploads> FRONTEND_URL=http://fe.test \
//     APP_BASE_URL=http://api.test EMAIL_TOKEN_SECRET=x JWT_SECRET=x \
//     node apps/api/scripts/compare-memo-notification.js .
//
// Delete together with backend/ once Express is removed.
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(process.argv[2] || '.');
const backend = path.join(root, 'backend');
const apiDist = path.join(root, 'apps/api/dist');
if (!/55432/.test(process.env.DATABASE_URL || '')) throw new Error('refusing: not the throwaway DB');

// Same "now" for both sides: JWT iat, delegation windows, PDF dates.
const FIXED = new Date('2026-05-05T05:05:05Z').getTime();
const RealDate = Date;
global.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [FIXED]));
  }
  static now() {
    return FIXED;
  }
};

process.chdir(backend);
require(require.resolve('ts-node', { paths: [backend] })).register({
  transpileOnly: true,
  project: path.join(backend, 'tsconfig.json'),
});
require(require.resolve('reflect-metadata', { paths: [apiDist] }));

const out = console.log;
console.log = () => {};
console.warn = () => {};
console.error = () => {};

let sink = [];
const capture = async (to, subject, text, html, attachments) => {
  sink.push({
    to,
    subject,
    text,
    html,
    attachments:
      attachments === undefined
        ? undefined
        : attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            sha: crypto.createHash('sha1').update(a.content || '').digest('hex'),
          })),
  });
};
require(path.join(backend, 'src/lib/mailer')).sendEmail = capture;
const legacy = require(path.join(backend, 'src/services/memoNotification.service'));

const { prisma } = require(require.resolve('@hl/database', { paths: [apiDist] }));
const { Logger } = require(require.resolve('@nestjs/common', { paths: [apiDist] }));
Logger.overrideLogger(false);
const { MemoNotificationService } = require(
  path.join(apiDist, 'modules/memo-notification/memo-notification.service'),
);
const { EmailPreferenceService } = require(path.join(apiDist, 'common/mail/email-preference.service'));
const nest = new MemoNotificationService(prisma, { sendEmail: capture }, new EmailPreferenceService(prisma));
// Await Nest's fire-and-forget mailer so we know how many emails to expect from Express.
let nestAsync = Promise.resolve();
const origAsync = nest.sendEmailsAsync.bind(nest);
nest.sendEmailsAsync = (a) => (nestAsync = origAsync(a));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(fn, expectAtLeast) {
  sink = [];
  const before = (await prisma.notification.aggregate({ _max: { id: true } }))._max.id ?? 0;
  await fn();
  if (expectAtLeast !== undefined) {
    // Express's async mailer can't be awaited — wait for it to catch up.
    for (let i = 0; i < 100 && sink.length < expectAtLeast; i++) await sleep(100);
    await sleep(300);
  }
  const notis = await prisma.notification.findMany({
    where: { id: { gt: before } },
    orderBy: { id: 'asc' },
    select: { userId: true, actorId: true, memoId: true, statusId: true, notificationTypeId: true, message: true },
  });
  await prisma.notification.deleteMany({ where: { id: { gt: before } } });
  const tokens = await prisma.memoApproverAction.findMany({
    where: { emailToken: { not: null } },
    select: { id: true, emailToken: true },
    orderBy: { id: 'asc' },
  });
  const mails = sink.slice().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { notis, mails, tokens };
}

(async () => {
  const memos = await prisma.masterMemo.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, userId: true },
  });
  const users = (await prisma.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map((u) => u.id);
  let checked = 0;
  let diffs = 0;
  let mailsSeen = 0;
  let tieRetries = 0;

  for (const m of memos) {
    const levels = await prisma.lineOfApprovalUserPivotForUse.findMany({
      where: { memoId: m.id },
      select: { level: true },
    });
    const maxLevel = levels.length ? Math.max(...levels.map((l) => l.level)) : 0;
    const actor = users[m.id % users.length];
    const cc = [users[(m.id * 7) % users.length], users[(m.id * 11) % users.length]];

    const cases = [
      ['status 5', (s) => s.notifyStatusUpdate(m.id, actor, 'Actor X', 5, null), true],
      ['status 3 mid', (s) => s.notifyStatusUpdate(m.id, actor, 'Actor X', 3, 0), false],
      ['status 3 last', (s) => s.notifyStatusUpdate(m.id, actor, 'Actor X', 3, maxLevel), false],
      ['status 4', (s) => s.notifyStatusUpdate(m.id, actor, 'Actor X', 4, 0), false],
      ['status 7 override', (s) => s.notifyStatusUpdate(m.id, actor, 'Actor X', 7, 0, undefined, 'ยกเลิก'), false],
      ['cc assigned', (s) => s.notifyCcAssigned(m.id, actor, cc), false],
      ['cc assigned 3', (s) => s.notifyCcAssigned(m.id, actor, cc, 3), false],
      ['recall', (s) => s.notifyRecallUpdate(m.id, m.userId, 'Owner X'), false],
    ];

    for (const [name, call, isAsync] of cases) {
      // Same-level approvers come back in no fixed order (both sides use
      // orderBy level only), so a mismatch is retried before it counts.
      let n;
      let l;
      for (let attempt = 0; attempt < 6; attempt++) {
        n = await run(async () => {
          await call(nest);
          await nestAsync;
        });
        l = await run(() => call(legacy), isAsync ? n.mails.length : undefined);
        if (JSON.stringify(l) === JSON.stringify(n)) {
          if (attempt) tieRetries++;
          break;
        }
      }
      checked++;
      mailsSeen += n.mails.length;
      if (JSON.stringify(l) !== JSON.stringify(n)) {
        diffs++;
        out(`DIFF memo=${m.id} ${name}: legacy mails=${l.mails.length} notis=${l.notis.length} | nest mails=${n.mails.length} notis=${n.notis.length}`);
        for (let i = 0; i < Math.max(l.mails.length, n.mails.length); i++) {
          for (const k of ['to', 'subject', 'text', 'html', 'attachments']) {
            if (JSON.stringify(l.mails[i]?.[k]) !== JSON.stringify(n.mails[i]?.[k])) out(`   mail[${i}].${k} differs`);
          }
        }
        if (JSON.stringify(l.notis) !== JSON.stringify(n.notis)) out('   notifications differ');
        if (JSON.stringify(l.tokens) !== JSON.stringify(n.tokens)) out('   email tokens differ');
      }
    }
  }
  out(`\n${checked} calls compared (${mailsSeen} emails), ${diffs} differences, ${tieRetries} matched after retry (row-order ties)`);
  await prisma.$disconnect();
  process.exit(diffs ? 1 : 0);
})().catch(async (e) => {
  out(e);
  await prisma.$disconnect();
  process.exit(2);
});
