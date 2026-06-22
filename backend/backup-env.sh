#!/bin/bash
# Script to backup production .env file before git operations
# Usage: ./backup-env.sh

BACKUP_FILE=".env.production.backup"

if [ -f ".env" ]; then
    cp .env "$BACKUP_FILE"
    echo "✅ Backed up .env to $BACKUP_FILE"
    echo "📝 You can now safely run: git pull origin main"
    echo "🔄 After pulling, restore with: cp $BACKUP_FILE .env"
else
    echo "❌ .env file not found!"
    exit 1
fi
