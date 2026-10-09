// Parity check for the extra approval port (Batch 7b), read endpoints only:
// list / active / active-bulk / eligible-users through the legacy Express
// handlers and ExtraApprovalService (apps/api/dist) on one database. Read-only.
//
// The legacy handlers were deleted in the 7b cut; restore them next to their
// old location first (relative imports must still resolve):
//   git show <pre-7b>:backend/src/services/extraApproval.service.ts > backend/src/services/_legacy_extraApproval.ts
//   git show <pre-7b>:backend/src/controllers/memo.controller.ts \
//     | sed 's#services/extraApproval.service#services/_legacy_extraApproval#' > backend/src/controllers/_legacy_memo.controller.ts
// Usage (from repo root, after `pnpm --filter apps/api build`):
//   DATABASE_URL=... FRONTEND_URL=http://x EMAIL_TOKEN_SECRET=x JWT_SECRET=x \
//     node apps/api/scripts/compare-extra-approval.js .
//
// Express list/active had no access check (Nest adds canViewMemo), so access is
// stubbed open here; the check itself is covered by unit tests.
const path = require('path');
const root = path.resolve(process.argv[2] || '.');
const backend = path.join(root, 'backend');
const apiDist = path.join(root, 'apps/api/dist');

require(require.resolve('ts-node', { paths: [backend] })).register({
  transpileOnly: true,
  project: path.join(backend, 'tsconfig.json'),
});
require(require.resolve('reflect-metadata', { paths: [apiDist] }));
const out = console.log;
console.log = () => {};
console.warn = () => {};

const legacyExtra = require(path.join(backend, 'src/services/_legacy_extraApproval'));
const legacyCtl = require(path.join(backend, 'src/controllers/_legacy_memo.controller'));
const { prisma } = require(require.resolve('@hl/database', { paths: [apiDist] }));
const { Logger } = require(require.resolve('@nestjs/common', { paths: [apiDist] }));
Logger.overrideLogger(false);
const { ExtraApprovalService } = require(
  path.join(apiDist, 'modules/extra-approval/extra-approval.service'),
);
const { MemoNotificationService } = require(
  path.join(apiDist, 'modules/memo-notification/memo-notification.service'),
);
const { EmailPreferenceService } = require(
  path.join(apiDist, 'common/mail/email-preference.service'),
);
const prefs = new EmailPreferenceService(prisma);
const noti = new MemoNotificationService(prisma, { sendEmail: async () => {} }, prefs);
const nest = new ExtraApprovalService(
  prisma,
  { sendEmail: async () => {} },
  prefs,
  { canViewMemo: async () => true },
  noti,
);

/** Run an Express handler and capture {status, body}. */
function express(handler, { params = {}, query = {}, body = {}, userId }) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(c) {
        this.statusCode = c;
        return this;
      },
      json(b) {
        resolve({ status: this.statusCode, body: b });
        return this;
      },
      sendStatus(c) {
        resolve({ status: c, body: undefined });
        return this;
      },
    };
    Promise.resolve(handler({ params, query, body, user: { id: userId } }, res, reject)).catch(
      reject,
    );
  });
}
async function nestCall(fn, okStatus = 200) {
  try {
    return { status: okStatus, body: await fn() };
  } catch (e) {
    if (typeof e.getStatus === 'function') return { status: e.getStatus(), body: e.getResponse() };
    throw e;
  }
}
const norm = (r) =>
  JSON.stringify({
    status: r.status,
    body: r.body === undefined ? null : JSON.parse(JSON.stringify(r.body)),
  });

(async () => {
  const memos = await prisma.masterMemo.findMany({
    orderBy: { id: 'asc' },
    select: { id: true, userId: true },
  });
  const users = (await prisma.user.findMany({ select: { id: true }, orderBy: { id: 'asc' } })).map(
    (u) => u.id,
  );
  const lines = await prisma.extraApprovalLine.findMany({
    select: { id: true, memoId: true, createdById: true, approvers: { select: { userId: true } } },
  });
  let checked = 0;
  let diffs = 0;
  const cmp = async (label, a, b) => {
    checked++;
    const [x, y] = await Promise.all([a(), b()]);
    if (norm(x) !== norm(y)) {
      diffs++;
      if (diffs <= 15)
        out(`DIFF ${label}\n  legacy ${norm(x).slice(0, 300)}\n  nest   ${norm(y).slice(0, 300)}`);
    }
  };

  for (const m of memos) {
    await cmp(
      `list memo=${m.id}`,
      () =>
        express(legacyExtra.listExtraApprovalLines, {
          params: { id: String(m.id) },
          userId: m.userId,
        }),
      () => nestCall(() => nest.listLines(m.id, m.userId)),
    );
    await cmp(
      `active memo=${m.id}`,
      () =>
        express(legacyExtra.getActiveExtraApprovalLine, {
          params: { id: String(m.id) },
          userId: m.userId,
        }),
      () => nestCall(() => nest.getActiveLine(m.id, m.userId)),
    );

    const memoLines = lines.filter((l) => l.memoId === m.id);
    const actors = new Set([
      m.userId,
      users[m.id % users.length],
      ...memoLines.flatMap((l) => [l.createdById, ...l.approvers.map((a) => a.userId)]),
    ]);
    for (const actor of actors) {
      for (const q of ['', 'a', 'Sae1', 'NICK']) {
        for (const lineId of [null, ...memoLines.map((l) => l.id)]) {
          const params = lineId
            ? { memoId: String(m.id), lineId: String(lineId) }
            : { memoId: String(m.id) };
          await cmp(
            `eligible memo=${m.id} actor=${actor} line=${lineId} q=${q}`,
            () =>
              express(legacyCtl.searchEligibleUsersForExtra, {
                params,
                query: { q },
                userId: actor,
              }),
            () => nestCall(() => nest.searchEligibleUsers(m.id, lineId, actor, q)),
          );
        }
      }
    }
  }
  const allIds = memos.map((m) => m.id);
  for (const u of users) {
    await cmp(
      `bulk user=${u}`,
      () =>
        express(legacyExtra.getActiveExtraApprovalLinesBulk, {
          body: { memoIds: [...allIds, 'x', -1] },
          userId: u,
        }),
      () => nestCall(() => nest.getActiveLinesBulk(u, [...allIds, 'x', -1])),
    );
  }
  out(`\n${checked} comparisons, ${diffs} differences`);
  await prisma.$disconnect();
  process.exit(diffs ? 1 : 0);
})().catch(async (e) => {
  out(e);
  await prisma.$disconnect();
  process.exit(2);
});
