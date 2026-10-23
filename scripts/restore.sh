#!/bin/sh
# Restores a dump made by scripts/backup.sh into the database (replacing existing objects).
# Stop the web app and worker first. Uses PG* variables or DATABASE_URL.
#   scripts/restore.sh ./backups/vigil-20261023T020000Z.dump
set -eu
file="${1:?usage: restore.sh <dump file>}"
[ -f "$file" ] || { echo "no such file: $file" >&2; exit 1; }
if [ -n "${DATABASE_URL:-}" ]; then
  pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$DATABASE_URL" "$file"
else
  pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="${PGDATABASE:-vigil}" "$file"
fi
echo "restored from $file"
