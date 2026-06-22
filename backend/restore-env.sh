#!/bin/bash
# Script to restore production .env file after git operations
# Usage: ./restore-env.sh

BACKUP_FILE=".env.production.backup"

if [ -f "$BACKUP_FILE" ]; then
    cp "$BACKUP_FILE" .env
    echo "✅ Restored .env from $BACKUP_FILE"
    echo "🔄 Restarting backend..."
    pm2 restart hlememo-backend
    echo "✅ Done!"
else
    echo "❌ Backup file $BACKUP_FILE not found!"
    echo "💡 Run ./backup-env.sh before git pull"
    exit 1
fi
