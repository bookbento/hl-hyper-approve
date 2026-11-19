#!/bin/sh
# Apply Prisma migrations inside the api image (or anywhere with node_modules installed).
#
#   docker compose run --rm api sh packages/database/scripts/migrate-deploy.sh
#
# The old databases were managed with `prisma db push`, so they have no
# _prisma_migrations history. On the first run against such a DB this compares the
# live schema with schema.prisma; if the only differences are the indexes added by
# the later migrations, it marks 0_init as applied, then runs `migrate deploy`.
# Any other difference stops here and prints the SQL. A brand-new empty DB just
# gets `migrate deploy`. (Same logic as the old deploy-production.sh.)
set -eu

cd "$(dirname "$0")/.."
PRISMA="node_modules/.bin/prisma"
[ -x "$PRISMA" ] || PRISMA="npx --no-install prisma"

# Runs one SQL query that returns a single number, prints it (0 on error).
sql_count() {
  node -e '
    const { PrismaClient } = require("@prisma/client");
    const p = new PrismaClient();
    p.$queryRawUnsafe(process.argv[1])
      .then((r) => console.log(Number(Object.values(r[0] ?? { n: 0 })[0] ?? 0)))
      .catch(() => console.log(0))
      .finally(() => p.$disconnect());
  ' "$1"
}

HAS_BASELINE="$(sql_count "SELECT count(*) FROM _prisma_migrations WHERE migration_name = '0_init' AND finished_at IS NOT NULL")"
TABLES="$(sql_count "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"

if [ "$HAS_BASELINE" = "0" ] && [ "$TABLES" != "0" ]; then
  echo "No baseline yet (DB was managed with db push) — checking drift against schema.prisma…"
  DRIFT_SQL="$($PRISMA migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script)"
  UNEXPECTED="$(echo "$DRIFT_SQL" | grep -v '^--' | grep -v '^[[:space:]]*$' \
    | grep -v -E 'MemoStatusPivot_memoId_createdAt_id_idx|MemoHistory_memoId_idx|Comment_memoId_createdAt_idx|ExtraApprovalLine_memoId_idx|"AttachedFile" ADD COLUMN +"orderNo"' || true)"
  if [ -n "$UNEXPECTED" ]; then
    echo "$DRIFT_SQL"
    echo "❌ Live DB differs from schema.prisma beyond the expected indexes. Review the SQL above, fix the DB, then re-run." >&2
    exit 1
  fi
  $PRISMA migrate resolve --applied 0_init
  echo "✅ Baselined 0_init"
fi

$PRISMA migrate deploy
