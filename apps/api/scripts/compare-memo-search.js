// Parity check for the memo search port (Batch 6c): runs the same requests
// through backend memoSearch.service (legacy) and MemoSearchNestService
// (apps/api/dist) against one database and diffs the JSON. Read-only.
//
// Usage (from repo root, after `pnpm --filter apps/api build`):
//   DATABASE_URL=... FRONTEND_URL=http://x EMAIL_TOKEN_SECRET=x JWT_SECRET=x \
//     node apps/api/scripts/compare-memo-search.js .
// (the extra env vars only satisfy backend import-time checks)
// COMPARE_USERS=N compares the N users owning the most memos (default 5).
//
// Delete together with backend/ once Express is removed.
const path = require('path');
const root = path.resolve(process.argv[2] || '.');
const backend = path.join(root, 'backend');
const apiDist = path.join(root, 'apps/api/dist');

require(require.resolve('ts-node', { paths: [backend] })).register({
  transpileOnly: true,
  project: path.join(backend, 'tsconfig.json'),
});
require(require.resolve('reflect-metadata', { paths: [apiDist] }));

const legacy = require(path.join(backend, 'src/services/memoSearch.service'));
const { prisma } = require(require.resolve('@hl/database', { paths: [apiDist] }));
const { MemoSearchNestService } = require(path.join(apiDist, 'modules/memo-query/memo-search.service'));
const nest = new MemoSearchNestService(prisma);

const requests = [
  {},
  { includeFacets: true },
  { page: 2, pageSize: 10 },
  { pageSize: 'all', includeStatCounts: false },
  { view: 'MY_APPROVAL' },
  { view: 'MY_CREATED' },
  { status: 'Approved' },
  { statuses: ['Processing', 'Draft'] },
  { search: 'a' },
  { search: 'MEMO-1' },
  { sortBy: 'latestAction' },
  { sortBy: 'latest', sortDir: 'asc' },
  { sortBy: 'subject', sortDir: 'asc' },
  { sortBy: 'expires' },
  { latestCommentContains: 'a' },
  { currentApproverNames: ['a'] },
  { extraApproverContains: 'a' },
  { createdFrom: '2025-01-01', createdTo: '2026-12-31' },
  { expiresFrom: '2026-03-01', expiresTo: '2026-09-30', sortBy: 'createdAt', sortDir: 'asc' },
  { businessUnitId: 27 },
  { departmentId: 'All', businessUnitId: 'All', sortBy: 'memonumber' },
  { ccStatuses: ['a'] },
  { extraApproverNames: ['a'], extraApproverIds: [1] },
  { view: 'MY_APPROVAL', sortBy: 'latestAction', sortDir: 'asc' },
  { statuses: ['Published', 'Recalled', 'Terminated', 'Rejected'], pageSize: 5, page: 2 },
  { memonumberContains: '00', subjectContains: 'memo', authorContains: 'a' },
];
// Search one memo by id, using an id that exists
const extraRequests = async () => {
  const [m] = await prisma.masterMemo.findMany({ select: { id: true }, orderBy: { id: 'desc' }, take: 1 });
  return m ? [{ search: `MEMO-${m.id}` }] : [];
};

(async () => {
  const users = await prisma.$queryRaw`
    SELECT u.id FROM "User" u
    LEFT JOIN "MasterMemo" m ON m."userId" = u.id
    WHERE u."deletedAt" IS NULL
    GROUP BY u.id ORDER BY COUNT(m.id) DESC LIMIT ${Number(process.env.COMPARE_USERS || 5)}`;
  const userIds = users.map((u) => u.id);
  console.log('users:', userIds.join(','));
  requests.push(...(await extraRequests()));

  let diffs = 0, checked = 0;
  for (const userId of userIds) {
    for (const req of requests) {
      const a = await legacy.searchMemos({ ...req }, userId, 'http://host');
      const b = await nest.searchMemos({ ...req }, userId, 'http://host');
      const sa = JSON.stringify(a), sb = JSON.stringify(b);
      checked++;
      if (sa !== sb) {
        diffs++;
        console.log(`DIFF user=${userId} req=${JSON.stringify(req)} legacyTotal=${a.total} nestTotal=${b.total}`);
      } else if (userId === userIds[0]) {
        console.log(`ok   user=${userId} req=${JSON.stringify(req)} total=${a.total} items=${a.items.length}`);
      }
    }
    const sa = JSON.stringify(await legacy.getCachedStatCounts(userId, undefined, { forceRefresh: true }));
    const sb = JSON.stringify(await nest.getCachedStatCounts(userId, true));
    checked++;
    if (sa !== sb) { diffs++; console.log(`DIFF statCounts user=${userId}`); }
  }
  console.log(`\n${checked} comparisons, ${diffs} differences`);
  await prisma.$disconnect();
  process.exit(diffs ? 1 : 0);
})().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(2); });
