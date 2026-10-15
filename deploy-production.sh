#!/bin/bash
################################################################################
# Production deployment — HL Hyper Approve (pnpm monorepo, NestJS API)
# Domain: https://e-approval.hylifeconnect.com
# Server path: /var/www/hlememo
#
#   cd /var/www/hlememo && sudo ./deploy-production.sh
#
# What it does
#   1. checks, filesystem + DB backups (/var/www/backup)
#   2. syncs the repo to origin/$DEPLOY_BRANCH (default: production), keeping .env files
#   3. pnpm install → build @hl/database, apps/api, frontend
#   4. Prisma migrations (baselines a db-push database once, see below)
#   5. pm2: replaces the old Express app (hlememo-backend) with hlememo-api on :3001
#      — nginx keeps proxying /api to 127.0.0.1:3001, no nginx change needed
#   6. health check + logs
#
# Env: apps/api/.env (read via node --env-file, see apps/api/ecosystem.config.js and
# apps/api/env-example.txt). On the first run it is created from backend/.env.
# Besides the old variables, production needs TRUST_PROXY_HOPS=1, APP_BASE_URL,
# EMAIL_TOKEN_SECRET, FRONTEND_URL, SMTP_HOST, SMTP_FROM — the API refuses to boot
# and lists everything missing otherwise.
#
# Migrations: the DB used to be managed with `prisma db push`. On the first run the
# script compares the live DB with schema.prisma; if the only differences are the
# indexes added by later migrations (MemoStatusPivot latest-status, MemoHistory.memoId) it marks 0_init as applied and runs
# `migrate deploy`. Any other difference stops the deploy and prints the SQL.
#
# Rollback
#   pm2 delete hlememo-api
#   cd /var/www && sudo tar -xzf "$(ls -t /var/www/backup/files/hlememo_files_*.tar.gz | head -1)"
#   cd /var/www/hlememo/backend && pm2 start ecosystem.config.js   # old Express app
#   (DB dump: /var/www/backup/db — the index migration is additive, no restore needed)
################################################################################

set -euo pipefail

DEPLOY_BRANCH="${DEPLOY_BRANCH:-production}"
APP_ROOT="/var/www"
APP_NAME="hlememo"
APP_DIR="$APP_ROOT/$APP_NAME"
API_DIR="$APP_DIR/apps/api"
DB_PKG_DIR="$APP_DIR/packages/database"
FRONTEND_DIR="$APP_DIR/frontend"
API_PORT=3001
PM2_APP="hlememo-api"
LEGACY_PM2_APP="hlememo-backend"

BACKUP_ROOT="/var/www/backup"
FS_BACKUP_DIR="$BACKUP_ROOT/files"
DB_BACKUP_DIR="$BACKUP_ROOT/db"
STAMP="$(date +%Y%m%d_%H%M%S)"

ACTUAL_USER="${SUDO_USER:-$USER}"
as_user() { sudo -u "$ACTUAL_USER" "$@"; }

step() { echo; echo "[$(date '+%H:%M:%S')] $*"; }
die() { echo "❌ $*" >&2; exit 1; }

echo "========================================"
echo "🚀 Production deployment ($DEPLOY_BRANCH) — $(date)"
echo "========================================"

########################################
step "🔍 Pre-deployment checks"
########################################
[ -d "$APP_DIR/.git" ] || die "Not a git checkout: $APP_DIR"
systemctl is-active --quiet postgresql || die "PostgreSQL is not running"
systemctl is-active --quiet nginx || die "Nginx is not running"
command -v node >/dev/null || die "node not found"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node >= 20 required (--env-file); found $(node -v)"
command -v pm2 >/dev/null || die "pm2 not found"

# First run on the monorepo: carry the Express .env over.
if [ ! -f "$API_DIR/.env" ]; then
  if [ -f "$APP_DIR/backend/.env" ]; then
    mkdir -p "$API_DIR"
    cp "$APP_DIR/backend/.env" "$API_DIR/.env"
    echo "ℹ️  Created apps/api/.env from backend/.env — review it against apps/api/env-example.txt"
  else
    die "apps/api/.env not found (template: apps/api/env-example.txt)"
  fi
fi
chmod 600 "$API_DIR/.env"

# Load the API env for pg_dump / prisma (same file pm2 gives the app).
set -a
# shellcheck disable=SC1091
. "$API_DIR/.env"
set +a
: "${DATABASE_URL:?DATABASE_URL missing in apps/api/.env}"
PG_URL="${DATABASE_URL%%\?*}" # pg_dump rejects Prisma's ?schema=… parameter

for k in TRUST_PROXY_HOPS APP_BASE_URL EMAIL_TOKEN_SECRET FRONTEND_URL SMTP_HOST SMTP_FROM JWT_SECRET; do
  [ -n "${!k:-}" ] || echo "⚠️  $k is not set in apps/api/.env — the API will refuse to start"
done
echo "✅ Checks passed"

########################################
step "📦 Backups"
########################################
sudo mkdir -p "$FS_BACKUP_DIR" "$DB_BACKUP_DIR"
(cd "$APP_ROOT" && sudo tar -czf "$FS_BACKUP_DIR/hlememo_files_$STAMP.tar.gz" \
  --exclude="$APP_NAME/node_modules" \
  --exclude="$APP_NAME/*/node_modules" \
  --exclude="$APP_NAME/*/*/node_modules" \
  --exclude="$APP_NAME/.git" \
  --exclude="$APP_NAME/uploads" \
  --exclude="$APP_NAME/backend/uploads" \
  "$APP_NAME")
pg_dump "$PG_URL" | sudo tee "$DB_BACKUP_DIR/hlememo_db_$STAMP.sql" >/dev/null
echo "✅ Backups in $BACKUP_ROOT"

########################################
step "💾 Keeping .env files"
########################################
ENV_TMP="$(mktemp -d)"
trap 'rm -rf "$ENV_TMP"' EXIT
cp "$API_DIR/.env" "$ENV_TMP/api.env"
[ -f "$FRONTEND_DIR/.env" ] && cp "$FRONTEND_DIR/.env" "$ENV_TMP/frontend.env"
[ -f "$APP_DIR/backend/.env" ] && cp "$APP_DIR/backend/.env" "$ENV_TMP/backend.env"

########################################
step "📥 Syncing to origin/$DEPLOY_BRANCH"
########################################
cd "$APP_DIR"
as_user git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
CURRENT_REMOTE="$(as_user git remote get-url origin)"
if [[ "$CURRENT_REMOTE" == https://github.com/* ]]; then
  REPO_PATH="$(echo "$CURRENT_REMOTE" | sed -e 's|https://github.com/||' -e 's|\.git$||')"
  as_user git remote set-url origin "git@github.com:${REPO_PATH}.git"
fi
as_user git fetch origin
as_user git checkout -B "$DEPLOY_BRANCH" "origin/$DEPLOY_BRANCH"
as_user git reset --hard "origin/$DEPLOY_BRANCH"
as_user git clean -fd
echo "✅ At $(as_user git log --oneline -1)"

cp "$ENV_TMP/api.env" "$API_DIR/.env" && chmod 600 "$API_DIR/.env"
[ -f "$ENV_TMP/frontend.env" ] && cp "$ENV_TMP/frontend.env" "$FRONTEND_DIR/.env"
if [ -f "$ENV_TMP/backend.env" ]; then
  # backend/ is gone from the repo; keep its .env next to the backups for reference.
  sudo cp "$ENV_TMP/backend.env" "$BACKUP_ROOT/backend.env.$STAMP"
fi

########################################
step "📦 pnpm install"
########################################
corepack enable >/dev/null 2>&1 || sudo npm install -g corepack
# @hl/database's postinstall runs `prisma generate` and builds its dist/.
# Build steps run as root like the old npm-based script (existing node_modules are root-owned).
CI=1 corepack pnpm install --frozen-lockfile

########################################
step "🏗️  Build"
########################################
corepack pnpm --filter apps/api build
[ -f "$API_DIR/dist/main.js" ] || die "apps/api/dist/main.js missing after build"
corepack pnpm --filter my-react-app build
[ -f "$FRONTEND_DIR/dist/index.html" ] || die "frontend/dist/index.html missing after build"

########################################
step "🧬 Database migrations"
########################################
cd "$DB_PKG_DIR"
PRISMA="corepack pnpm exec prisma"

has_baseline() {
  psql "$PG_URL" -tAc "SELECT 1 FROM _prisma_migrations WHERE migration_name = '0_init' AND finished_at IS NOT NULL" 2>/dev/null | grep -q 1
}

if ! has_baseline; then
  echo "No baseline yet (DB was managed with db push) — checking drift against schema.prisma…"
  DRIFT_SQL="$($PRISMA migrate diff \
    --from-url "$DATABASE_URL" --to-schema-datamodel prisma/schema.prisma --script)"
  # Everything except comments, blank lines and the indexes that the later migrations add.
  UNEXPECTED="$(echo "$DRIFT_SQL" | grep -v '^--' | grep -v '^[[:space:]]*$' \
    | grep -v -E 'MemoStatusPivot_memoId_createdAt_id_idx|MemoHistory_memoId_idx' || true)"
  if [ -n "$UNEXPECTED" ]; then
    echo "$DRIFT_SQL"
    die "Live DB differs from schema.prisma beyond the expected indexes. Review the SQL above, fix the DB, then re-run."
  fi
  $PRISMA migrate resolve --applied 0_init
  echo "✅ Baselined 0_init"
fi
$PRISMA migrate deploy

########################################
step "♻️  pm2"
########################################
mkdir -p "$API_DIR/logs"
if pm2 describe "$LEGACY_PM2_APP" >/dev/null 2>&1; then
  echo "Stopping the old Express app ($LEGACY_PM2_APP) — the API takes over :$API_PORT"
  pm2 delete "$LEGACY_PM2_APP"
fi
cd "$API_DIR"
pm2 startOrReload ecosystem.config.js --update-env
pm2 save

########################################
step "🔄 Nginx"
########################################
sudo nginx -t && sudo systemctl reload nginx

########################################
step "🔍 Health check"
########################################
HEALTHY=0
for _ in $(seq 1 15); do
  if curl -fs -o /dev/null "http://127.0.0.1:$API_PORT/api/health"; then HEALTHY=1; break; fi
  sleep 2
done
pm2 logs "$PM2_APP" --lines 20 --nostream || true
if [ "$HEALTHY" -ne 1 ]; then
  die "API did not answer /api/health on :$API_PORT — see the logs above (rollback steps at the top of this script)"
fi

echo
echo "========================================"
echo "✅ Deployment completed — $(date)"
echo "Next: log in at https://e-approval.hylifeconnect.com, open a memo, check that an"
echo "email goes out, and watch: pm2 logs $PM2_APP"
if [ -d "$APP_DIR/backend" ]; then
  echo "ℹ️  $APP_DIR/backend is no longer used (only untracked files remain)."
  echo "   Check backend/uploads and backend/src/uploads for files before deleting it."
fi
echo "========================================"
