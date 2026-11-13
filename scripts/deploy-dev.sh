#!/usr/bin/env bash
################################################################################
# Deploy to the DEV server — build here, ship the build, install + run there.
#
#   SSH_KEY=~/Downloads/hlserver-git.ppk ./scripts/deploy-dev.sh
#
# Server: ubuntu@43.210.109.106 (shared box, other sites run on it)
#   app     /var/www/hlememo-dev            (.env, uploads/ and node_modules stay between deploys)
#   api     pm2 "hlememo-dev-api" on 127.0.0.1:3011 (apps/api/ecosystem.dev.config.js)
#   web     nginx :8088 → frontend/dist, /api → :3011 (/etc/nginx/sites-available/hlememo-dev)
#   db      Postgres 16 on the box, database hlememo_dev
#
# The server never compiles TypeScript or runs Vite (RAM is tight there). It only runs
# `pnpm install` for the API's dependencies so native modules (bcrypt, sharp) and the
# Prisma engine match Linux, then `prisma migrate deploy` and a pm2 reload.
#
# One-time server setup (database, .env, nginx) is in docs/DEV-SERVER.md.
################################################################################
set -euo pipefail

HOST="${DEV_HOST:-ubuntu@43.210.109.106}"
SSH_KEY="${SSH_KEY:-$HOME/Downloads/hlserver-git.ppk}"
APP_DIR="/var/www/hlememo-dev"
PUBLIC_URL="${DEV_PUBLIC_URL:-http://43.210.109.106:8088}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

step() { echo; echo "[$(date '+%H:%M:%S')] $*"; }
SSH_OPTS=(-i "$SSH_KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new)

[ -f "$SSH_KEY" ] || { echo "SSH key not found: $SSH_KEY (set SSH_KEY=...)" >&2; exit 1; }

step "🔨 build @hl/database"
corepack pnpm --filter @hl/database build

step "🔨 build api"
corepack pnpm --filter apps/api build

step "🔨 build frontend (API → $PUBLIC_URL)"
VITE_BACKEND_API_URL="$PUBLIC_URL" VITE_APP_BASE_URL="$PUBLIC_URL" VITE_NODE_ENV=development \
  corepack pnpm --filter my-react-app build

step "📦 pack"
REV="$(git rev-parse --short HEAD)$(git diff --quiet HEAD -- . ':!docs' || echo '-dirty')"
echo "$REV" > .deploy-rev
TARBALL="$(mktemp -d)/hlememo-dev.tgz"
tar -czf "$TARBALL" \
  --exclude='node_modules' --exclude='*.tsbuildinfo' \
  .deploy-rev package.json pnpm-lock.yaml pnpm-workspace.yaml \
  apps/api/package.json apps/api/dist apps/api/fonts apps/api/ecosystem.dev.config.js \
  packages/database/package.json packages/database/prisma packages/database/src \
  packages/database/tsconfig.json packages/database/tsconfig.build.json \
  frontend/package.json frontend/dist
rm -f .deploy-rev
ls -lh "$TARBALL" | awk '{print "   " $5}'

step "🚚 upload"
scp "${SSH_OPTS[@]}" -q "$TARBALL" "$HOST:/tmp/hlememo-dev.tgz"
rm -f "$TARBALL"

step "🚀 install, migrate, reload on server"
ssh "${SSH_OPTS[@]}" "$HOST" APP_DIR="$APP_DIR" 'bash -s' <<'REMOTE'
set -euo pipefail
cd "$APP_DIR"
[ -f apps/api/.env ] || { echo "❌ $APP_DIR/apps/api/.env missing — see docs/DEV-SERVER.md" >&2; exit 1; }

# replace build output only; .env, uploads/, node_modules/ stay
rm -rf apps/api/dist frontend/dist packages/database/prisma packages/database/src
tar -xzf /tmp/hlememo-dev.tgz -C "$APP_DIR"
rm -f /tmp/hlememo-dev.tgz
mkdir -p apps/api/logs uploads

export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 CI=1
# API + @hl/database only (its postinstall runs prisma generate + tsc for dist/)
corepack pnpm install --frozen-lockfile --filter 'apps/api...'

DATABASE_URL="$(grep -E '^DATABASE_URL=' apps/api/.env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')"
export DATABASE_URL
(cd packages/database && corepack pnpm exec prisma migrate deploy)

pm2 startOrReload apps/api/ecosystem.dev.config.js --update-env
pm2 save >/dev/null

for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3011/api/health >/dev/null 2>&1; then
    echo "✅ api healthy — rev $(cat .deploy-rev)"; exit 0
  fi
  sleep 1
done
echo "❌ api did not answer /api/health in 20s — last log lines:" >&2
tail -30 apps/api/logs/api.err.log >&2 || true
exit 1
REMOTE

step "✅ done → $PUBLIC_URL"
