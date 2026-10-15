/**
 * "Latest status" of a memo = its MemoStatusPivot row with the newest createdAt,
 * ties broken by id. Same rule as the raw SQL in memo-query/search
 * (`ORDER BY sp."createdAt" DESC, sp."id" DESC`). Without the id tie-break,
 * two pivots with equal createdAt came back in whatever order Postgres chose.
 */
export const LATEST_STATUS_ORDER: [{ createdAt: 'desc' }, { id: 'desc' }] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];
