#!/bin/sh
# Compressed PostgreSQL dump with a timestamp; keeps the newest $BACKUP_KEEP (default 14).
# Uses the standard libpq variables (PGHOST, PGUSER, PGPASSWORD, PGDATABASE) or DATABASE_URL.
#   scripts/backup.sh ./backups
set -eu
dir="${1:-./backups}"
keep="${BACKUP_KEEP:-14}"
mkdir -p "$dir"
file="$dir/vigil-$(date -u +%Y%m%dT%H%M%SZ).dump"
if [ -n "${DATABASE_URL:-}" ]; then pg_dump --format=custom --no-owner --file="$file" "$DATABASE_URL"; else pg_dump --format=custom --no-owner --file="$file"; fi
echo "backup written: $file ($(wc -c < "$file") bytes)"
ls -1t "$dir"/vigil-*.dump 2>/dev/null | tail -n +"$((keep + 1))" | xargs -r rm -f
