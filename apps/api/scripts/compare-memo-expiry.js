/* eslint-disable */
// memo-expiry parity: Express sweepMemoExpiryOnce on DB A, Nest MemoExpiryService.sweepOnce
// on DB B (both cloned from the same fixture DB), same sequence of pretend "now" ticks.
// Compares every email (to/subject/text/html) per tick and the final rows of
// MemoStatusPivot, MemoHistory and Notification.
//
//   URL_FX=postgresql://…:55432/hl_fx URL_A=…/hl_a URL_B=…/hl_b node apps/api/scripts/compare-memo-expiry.js .
//
// URL_FX is the fixture DB (prepared in place, then cloned to A and B). Needs `nest build` first.
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(process.argv[2] || '.');
const backend = path.join(root, 'backend');
const apiDist = path.join(root, 'apps/api/dist');
const { URL_FX, URL_A, URL_B } = process.env;
for (const u of [URL_FX, URL_A, URL_B]) {
  if (!u || !/:55432\//.test(u)) {
    console.error('URL_FX / URL_A / URL_B must point at the throwaway parity DB (port 55432)');
    process.exit(2);
  }
}
const dbName = (u) => new URL(u).pathname.slice(1);
process.env.DATABASE_URL = URL_A;
process.env.FRONTEND_URL = 'https://fe.test';

const dbPkg = require.resolve('@hl/database', { paths: [apiDist] });
const { PrismaClient } = require(require.resolve('@prisma/client', { paths: [dbPkg] }));

// Thai-time anchor for the run: every expiry is placed relative to this.
const NOW0 = new Date('2026-10-20T10:00:00+07:00').getTime();
const MIN = 60000;
const DAY = 86400000;

let seed = 777;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (a) => a[Math.floor(rnd() * a.length)];

async function prepareFixture() {
  const p = new PrismaClient({ datasources: { db: { url: URL_FX } } });
  await p.status.upsert({ where: { id: 2 }, update: {}, create: { id: 2, name: 'Expired', description: 'Expired' } });
  const memos = await p.masterMemo.findMany({ select: { id: true, userId: true }, orderBy: { id: 'asc' } });
  const offsets = [
    -5 * DAY, -1 * DAY, -1 * MIN, 0, 30 * 1000, 1 * MIN, 2 * MIN, 5 * MIN, // around / past expiry
    1 * DAY, 2 * DAY, 3 * DAY, 4 * DAY, 1 * DAY - MIN, 2 * DAY + MIN, 3 * DAY + 2 * MIN, // reminders
    1 * DAY + 3 * 3600000, 14 * 3600000, // reminder day, other minute / crosses Thai midnight
  ];
  for (const m of memos) {
    const r = rnd();
    if (r < 0.15) {
      await p.masterMemo.update({ where: { id: m.id }, data: { expiresAt: null } });
      continue;
    }
    await p.masterMemo.update({
      where: { id: m.id },
      data: { expiresAt: new Date(NOW0 + pick(offsets)) },
    });
    // Make ~half the memos Processing as latest status so emails actually go out.
    if (rnd() < 0.5) {
      await p.memoStatusPivot.deleteMany({ where: { memoId: m.id, userId: m.userId, statusId: 5 } });
      await p.memoStatusPivot.create({
        data: { memoId: m.id, userId: m.userId, statusId: 5, createdAt: new Date('2026-09-01T00:00:00Z') },
      });
      await p.$executeRawUnsafe(
        `UPDATE "MemoStatusPivot" SET "createdAt" = '2026-01-01' WHERE "memoId" = ${m.id} AND "statusId" <> 5`,
      );
    }
    // Owner already has an Expired row (latest still Processing) → no duplicate pivot.
    if (rnd() < 0.05) {
      await p.memoStatusPivot
        .create({ data: { memoId: m.id, userId: m.userId, statusId: 2, createdAt: new Date('2025-01-01') } })
        .catch(() => {});
    }
    // Reminder already recorded for the first tick's Thai day.
    if (rnd() < 0.05) {
      for (const k of [1, 2, 3]) {
        await p.memoHistory.create({
          data: { memoId: m.id, userId: m.userId, action: `[expiry:3d-${k}:2026-10-20] x`, actiontype: 'UPDATE' },
        });
      }
    }
  }
  await p.$disconnect();
}

function cloneDb(from, to) {
  const psql = process.env.PSQL || 'psql';
  const port = new URL(from).port;
  const args = ['-p', port, '-U', 'postgres', '-q'];
  execFileSync(psql, [...args, '-c', `DROP DATABASE IF EXISTS ${dbName(to)}`]);
  execFileSync(psql, [...args, '-c', `CREATE DATABASE ${dbName(to)} TEMPLATE ${dbName(from)}`]);
}

(async () => {
  await prepareFixture();
  cloneDb(URL_FX, URL_A);
  cloneDb(URL_FX, URL_B);

  require(require.resolve('ts-node', { paths: [backend] })).register({
    transpileOnly: true,
    project: path.join(backend, 'tsconfig.json'),
  });
  require(require.resolve('reflect-metadata', { paths: [apiDist] }));
  const out = console.log;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  // Users whose id % 7 === 0 get an SMTP rejection on both sides (→ sent = 0 paths).
  const fakeSmtp = (bucket) => async (to, subject, text, html) => {
    bucket.push({ to, subject, text, html });
    const uid = Number(/^u(\d+)@|fx(\d+)@/.exec(to[0])?.slice(1).find(Boolean) ?? 1);
    return uid % 7 === 0 ? { accepted: [] } : { accepted: to };
  };

  // ── Express ──
  let mailsA = [];
  require(path.join(backend, 'src/lib/mailer')).sendEmail = (...a) => fakeSmtp(mailsA)(...a);
  const legacy = require(path.join(backend, 'src/lib/memo-expiry'));
  const { prisma: prismaA } = require(path.join(backend, 'prisma/client'));

  // ── Nest ──
  const prismaB = new PrismaClient({ datasources: { db: { url: URL_B } } });
  const { Logger } = require(require.resolve('@nestjs/common', { paths: [apiDist] }));
  Logger.overrideLogger(false);
  const D = (p) => require(path.join(apiDist, p));
  const { MemoExpiryService } = D('modules/memo-expiry/memo-expiry.service');
  const { EmailPreferenceService } = D('common/mail/email-preference.service');
  let mailsB = [];
  const nest = new MemoExpiryService(
    prismaB,
    { sendEmail: (...a) => fakeSmtp(mailsB)(...a) },
    new EmailPreferenceService(prismaB),
    { invalidateAll() {} },
  );

  const ticks = [
    0, 30 * 1000, MIN, 2 * MIN, 3 * MIN, 6 * MIN, // around NOW0
    DAY - MIN, DAY, DAY + MIN, // next day: reminders for memos 2–4 days out at NOW0
    14 * 3600000, 14 * 3600000 + MIN, // 00:00 TH next day (midnight wrap)
    2 * DAY, 3 * DAY, 3 * DAY + 2 * MIN, 4 * DAY + 3 * 3600000, 10 * DAY,
    0, // re-run the first instant: everything must be idempotent
  ];

  const diffs = [];
  let checks = 0;
  const eq = (label, a, b) => {
    checks++;
    const ja = JSON.stringify(a);
    const jb = JSON.stringify(b);
    if (ja !== jb) diffs.push({ label, a: ja.slice(0, 400), b: jb.slice(0, 400) });
  };

  let mailTotal = 0;
  for (const t of ticks) {
    const now = new Date(NOW0 + t);
    mailsA = [];
    mailsB = [];
    await legacy.sweepMemoExpiryOnce(now);
    await nest.sweepOnce(now);
    mailTotal += mailsA.length;
    eq(`tick ${now.toISOString()} mail count`, mailsA.length, mailsB.length);
    for (let i = 0; i < Math.max(mailsA.length, mailsB.length); i++) {
      eq(`tick ${now.toISOString()} mail #${i}`, mailsA[i], mailsB[i]);
    }
  }

  // Final rows. Rows created during the run carry wall-clock times → normalise.
  const runStart = new Date(Date.now() - 10 * 60000);
  const norm = (rows) =>
    rows.map((r) => {
      const o = { ...r };
      for (const k of ['createdAt', 'timestamp', 'updatedAt']) {
        if (o[k] instanceof Date && o[k] >= runStart) o[k] = '<t>';
      }
      return o;
    });
  const tables = {
    memoStatusPivot: { orderBy: { id: 'asc' } },
    memoHistory: { orderBy: { id: 'asc' } },
    notification: { orderBy: { id: 'asc' } },
  };
  const counts = {};
  for (const [t, q] of Object.entries(tables)) {
    const a = norm(await prismaA[t].findMany(q));
    const b = norm(await prismaB[t].findMany(q));
    counts[t] = a.length;
    eq(`${t} row count`, a.length, b.length);
    for (let i = 0; i < Math.max(a.length, b.length); i++) eq(`${t}[${i}]`, a[i], b[i]);
  }

  out(`ticks=${ticks.length} emails=${mailTotal} rows=${JSON.stringify(counts)}`);
  out(`${checks} checks, ${diffs.length} diffs`);
  for (const d of diffs.slice(0, 20)) out(JSON.stringify(d, null, 1));
  await prismaA.$disconnect();
  await prismaB.$disconnect();
  process.exit(diffs.length ? 1 : 0);
})().catch((e) => {
  process.stdout.write(String(e?.stack || e) + '\n');
  process.exit(1);
});
