#!/bin/bash
################################################################################
# Production Deployment Script for E-Approval System
# Domain: https://e-approval.hylifeconnect.com
# Server Path: /var/www/hlememo
################################################################################
#
# HOW TO RUN THIS SCRIPT:
#
# 1. Upload to server (choose one method):
#    
#    Method A - Using SCP from local machine:
#    scp deploy-production.sh user@your-server-ip:/var/www/hlememo/
#    
#    Method B - Create directly on server:
#    ssh user@your-server-ip
#    nano /var/www/hlememo/deploy-production.sh
#    # Paste the script content, then Ctrl+X, Y, Enter
#
# 2. Make it executable:
#    chmod +x /var/www/hlememo/deploy-production.sh
#
# 3. Run the deployment:
#    cd /var/www/hlememo
#    sudo ./deploy-production.sh
#
# 4. Monitor the output:
#    - Watch for ⚠️ warnings or ❌ errors
#    - Check post-deployment verification section
#    - Review backend logs at the end
#
# IMPORTANT NOTES:
# - This script requires sudo privileges
# - Ensure production .env file exists before first run
# - Script will backup and restore .env automatically
# - All backups saved to /var/www/backup/
# - Script stops on any error (set -e)
#
# ROLLBACK IF NEEDED:
# If deployment fails, restore from backup:
#   cd /var/www
#   LATEST_BACKUP=$(ls -t /var/www/backup/files/hlememo_files_*.tar.gz | head -1)
#   sudo tar -xzf "$LATEST_BACKUP"
#   pm2 restart hlememo-backend
#
################################################################################

set -e
set -o pipefail

echo "========================================"
echo "🚀 Production Deployment Started"
echo "Time: $(date)"
echo "========================================"

########################################
# Variables
########################################
APP_ROOT="/var/www"
APP_NAME="hlememo"
APP_DIR="$APP_ROOT/$APP_NAME"

BACKUP_ROOT="/var/www/backup"
FS_BACKUP_DIR="$BACKUP_ROOT/files"
DB_BACKUP_DIR="$BACKUP_ROOT/db"

DB_NAME="hlememo"
DB_USER="hlememouser"
DB_PASSWORD="HlEpass2025x"

########################################
# Pre-Deployment Checks
########################################
echo "🔍 Running pre-deployment checks..."

# Check if app directory exists
if [ ! -d "$APP_DIR" ]; then
  echo "❌ ERROR: Application directory not found: $APP_DIR"
  exit 1
fi

# Check if backend directory exists
if [ ! -d "$APP_DIR/backend" ]; then
  echo "❌ ERROR: Backend directory not found: $APP_DIR/backend"
  exit 1
fi

# Check if frontend directory exists
if [ ! -d "$APP_DIR/frontend" ]; then
  echo "❌ ERROR: Frontend directory not found: $APP_DIR/frontend"
  exit 1
fi

# Check if PostgreSQL is running
if ! systemctl is-active --quiet postgresql; then
  echo "❌ ERROR: PostgreSQL is not running"
  exit 1
fi

# Check if Nginx is running
if ! systemctl is-active --quiet nginx; then
  echo "❌ ERROR: Nginx is not running"
  exit 1
fi

echo "✅ Pre-deployment checks passed"

########################################
# Prepare Backup Directories
########################################
sudo mkdir -p "$FS_BACKUP_DIR"
sudo mkdir -p "$DB_BACKUP_DIR"

########################################
# Filesystem Backup
########################################
echo "📦 Creating filesystem backup..."

cd "$APP_ROOT"

FS_BACKUP_NAME="hlememo_files_$(date +%Y%m%d_%H%M%S).tar.gz"

sudo tar -czf "$FS_BACKUP_DIR/$FS_BACKUP_NAME" \
  --exclude="$APP_NAME/backend/node_modules" \
  --exclude="$APP_NAME/frontend/node_modules" \
  --exclude="$APP_NAME/.git" \
  --exclude="$APP_NAME/uploads" \
  --exclude="$APP_NAME/backend/uploads" \
  "$APP_NAME"

echo "✅ Filesystem backup saved to $FS_BACKUP_DIR"

########################################
# Database Backup
########################################
echo "🗄️ Creating database backup..."

export PGPASSWORD="$DB_PASSWORD"

DB_BACKUP_FILE="$DB_BACKUP_DIR/hlememo_db_$(date +%Y%m%d_%H%M%S).sql"

# Run pg_dump and save to file (without sudo for redirect)
pg_dump -U "$DB_USER" -d "$DB_NAME" > "$DB_BACKUP_FILE"

# Move to backup directory with sudo if needed
if [ ! -f "$DB_BACKUP_FILE" ]; then
  # If direct write failed, try with temp file
  TEMP_BACKUP="/tmp/hlememo_db_$(date +%Y%m%d_%H%M%S).sql"
  pg_dump -U "$DB_USER" -d "$DB_NAME" > "$TEMP_BACKUP"
  sudo mv "$TEMP_BACKUP" "$DB_BACKUP_FILE"
fi

unset PGPASSWORD

echo "✅ Database backup saved to $DB_BACKUP_FILE"

########################################
# Backup Production .env Files
########################################
echo "💾 Backing up production .env files..."

# Backup to a safe location outside the git directory
BACKUP_TEMP_DIR="/tmp/hlememo_env_backup_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$BACKUP_TEMP_DIR"

cd "$APP_DIR/backend"
if [ -f .env ]; then
  cp .env "$BACKUP_TEMP_DIR/backend.env"
  echo "✅ Backend .env backed up to $BACKUP_TEMP_DIR"
else
  echo "⚠️  Warning: backend/.env not found!"
fi

cd "$APP_DIR/frontend"
if [ -f .env ]; then
  cp .env "$BACKUP_TEMP_DIR/frontend.env"
  echo "✅ Frontend .env backed up to $BACKUP_TEMP_DIR"
fi

########################################
# Update Source Code
########################################
echo "📥 Updating Git repository..."

cd "$APP_DIR"

# Get the actual user who invoked sudo (not root)
ACTUAL_USER="${SUDO_USER:-$USER}"

# Allow the directory to be operated on
sudo -u "$ACTUAL_USER" git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

# Configure pull strategy
sudo -u "$ACTUAL_USER" git config pull.rebase false 2>/dev/null || true

# Check if remote is using HTTPS and convert to SSH
CURRENT_REMOTE=$(sudo -u "$ACTUAL_USER" git remote get-url origin)
if [[ "$CURRENT_REMOTE" == https://github.com/* ]]; then
  echo "🔧 Converting git remote from HTTPS to SSH..."
  # Extract repo path from HTTPS URL
  REPO_PATH=$(echo "$CURRENT_REMOTE" | sed 's|https://github.com/||' | sed 's|\.git$||')
  SSH_URL="git@github.com:${REPO_PATH}.git"
  sudo -u "$ACTUAL_USER" git remote set-url origin "$SSH_URL"
  echo "✅ Remote URL updated to: $SSH_URL"
fi

# Fetch latest changes (run as actual user to use their SSH keys)
echo "Fetching as user: $ACTUAL_USER"
sudo -u "$ACTUAL_USER" git fetch origin

# Show current branch
echo "Current branch: $(sudo -u "$ACTUAL_USER" git branch --show-current)"

# Reset to remote state (discard any local changes)
sudo -u "$ACTUAL_USER" git reset --hard origin/main
sudo -u "$ACTUAL_USER" git clean -fd

# Pull latest changes
sudo -u "$ACTUAL_USER" git pull origin main

echo "✅ Git repository synced with origin/main"

########################################
# Restore Production .env Files
########################################
echo "♻️  Restoring production .env files..."

cd "$APP_DIR/backend"
if [ -f "$BACKUP_TEMP_DIR/backend.env" ]; then
  cp "$BACKUP_TEMP_DIR/backend.env" .env
  echo "✅ Backend .env restored"
else
  echo "❌ ERROR: backend .env backup not found at $BACKUP_TEMP_DIR"
  echo "Please manually create backend/.env with production settings"
  exit 1
fi

cd "$APP_DIR/frontend"
if [ -f "$BACKUP_TEMP_DIR/frontend.env" ]; then
  cp "$BACKUP_TEMP_DIR/frontend.env" .env
  echo "✅ Frontend .env restored"
fi

# Verify production settings
echo "🔍 Verifying backend .env configuration..."
cd "$APP_DIR/backend"
if grep -q "NODE_ENV=production" .env; then
  echo "✅ NODE_ENV is set to production"
else
  echo "⚠️  WARNING: NODE_ENV is not set to production!"
fi

if grep -q "e-approval.hylifeconnect.com" .env; then
  echo "✅ Production domain configured"
else
  echo "⚠️  WARNING: Production domain not found in .env!"
fi

# Clean up temp backup
rm -rf "$BACKUP_TEMP_DIR"
echo "✅ Temporary backup cleaned up"

########################################
# Backend Dependencies
########################################
echo "📦 Installing backend dependencies..."
cd "$APP_DIR/backend"
sudo npm ci

########################################
# Frontend Dependencies
########################################
echo "📦 Installing frontend dependencies..."
cd "$APP_DIR/frontend"
sudo npm ci

########################################
# Prisma
########################################
echo "🧬 Running Prisma..."
cd "$APP_DIR/backend"
sudo npx prisma generate
sudo npx prisma db push

########################################
# Backend Build
########################################
echo "🏗️ Building backend..."
sudo rm -rf dist
sudo npm run build
ls -la dist/src/

########################################
# Frontend Build
########################################
echo "🏗️ Building frontend..."
cd "$APP_DIR/frontend"
sudo rm -rf dist
sudo npm run build
ls -la dist/

########################################
# Reload Services
########################################
echo "🔄 Reloading Nginx..."
sudo systemctl reload nginx

########################################
# PM2 Restart
########################################
echo "♻️ Restarting PM2 process..."

# Check if PM2 process exists
if pm2 list | grep -q "hlememo-backend"; then
  pm2 restart hlememo-backend --update-env
  echo "✅ PM2 process restarted"
else
  echo "⚠️  Warning: hlememo-backend process not found in PM2"
  echo "You may need to start it manually with: pm2 start ecosystem.config.js"
fi

pm2 save
pm2 list

########################################
# Done
########################################
echo "========================================"
echo "✅ Deployment completed successfully"
echo "Time: $(date)"
echo "========================================"

########################################
# Post-Deployment Verification
########################################
echo ""
echo "🔍 Post-Deployment Verification:"
echo "--------------------------------"

# Check PM2 status
echo "PM2 Status:"
pm2 status | grep hlememo-backend || echo "⚠️  hlememo-backend not found in PM2"

# Check if backend is responding
echo ""
echo "Backend Health Check:"
sleep 3  # Give backend time to start
if curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/health | grep -q "200"; then
  echo "✅ Backend is responding"
else
  echo "⚠️  Backend health check failed - check logs with: pm2 logs hlememo-backend"
fi

# Show recent logs
echo ""
echo "Recent Backend Logs (last 10 lines):"
pm2 logs hlememo-backend --lines 10 --nostream

echo ""
echo "========================================"
echo "📋 Next Steps:"
echo "1. Test login at: https://e-approval.hylifeconnect.com"
echo "2. Verify file uploads work"
echo "3. Check email notifications"
echo "4. Monitor logs: pm2 logs hlememo-backend"
echo "========================================"