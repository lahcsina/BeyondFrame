#!/bin/bash

# --- Configuration ---
BACKUP_DIR="/opt/lampp/htdocs/BeyondFrame/backups"
DB_NAME="beyondframe_db"
DB_USER="nischal"
DB_PASS="cleartype"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
RETENTION_DAYS=7

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

# Set the password temporarily for this shell session so pg_dump doesn't prompt
export PGPASSWORD="$DB_PASS"

# --- Run Backup ---
echo "🚀 Starting backup of $DB_NAME at $(date)..."

BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_$TIMESTAMP.sql.gz"

pg_dump -h 127.0.0.1 -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"

if [ $? -eq 0 ]; then
    echo "✅ Backup successful: $BACKUP_FILE"
else
    echo "❌ Backup failed!"
    exit 1
fi

# --- Cleanup ---
find "$BACKUP_DIR" -type f -name "*.sql.gz" -mtime +$RETENTION_DAYS -delete
echo "🧹 Old backups (older than $RETENTION_DAYS days) have been removed."