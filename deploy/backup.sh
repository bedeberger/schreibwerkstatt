#!/bin/bash
# DB-Backup via sqlite3 .backup (online-sicher, kein Lock).
# Konfigurierbar via .env oder Env-Vars:
#   BACKUP_DIR              Zielordner (Default: /opt/schreibwerkstatt/backup)
#   BACKUP_RETENTION_DAYS   Aufbewahrung in Tagen (Default: 30)
#   BACKUP_DB_FILE          DB-Pfad (Default: /opt/schreibwerkstatt/schreibwerkstatt.db)
#
# Aufruf:
#   bash backup.sh                 # nutzt /opt/schreibwerkstatt/.env falls vorhanden
#   bash backup.sh /pfad/zur/.env  # alternative .env

set -e
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

ENV_FILE="${1:-/opt/schreibwerkstatt/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

BACKUP_DIR="${BACKUP_DIR:-/opt/schreibwerkstatt/backup}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
BACKUP_DB_FILE="${BACKUP_DB_FILE:-/opt/schreibwerkstatt/schreibwerkstatt.db}"

if [ ! -f "$BACKUP_DB_FILE" ]; then
  echo "✗ DB nicht gefunden: $BACKUP_DB_FILE"
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS=$(date '+%Y%m%d-%H%M%S')
BACKUP_FILE="$BACKUP_DIR/schreibwerkstatt-$TS.db"

if ! sqlite3 "$BACKUP_DB_FILE" ".backup '$BACKUP_FILE'"; then
  echo "✗ DB-Backup fehlgeschlagen"
  rm -f "$BACKUP_FILE"
  exit 1
fi

gzip "$BACKUP_FILE"
echo "✓ DB-Backup: ${BACKUP_FILE}.gz"

# Retention: nach Mtime löschen (Tage), nicht nach Anzahl.
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'schreibwerkstatt-*.db.gz' \
  -mtime "+${BACKUP_RETENTION_DAYS}" -delete

REMAINING=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'schreibwerkstatt-*.db.gz' | wc -l | tr -d ' ')
echo "  Aufbewahrung ${BACKUP_RETENTION_DAYS} Tage – ${REMAINING} Backup(s) im Pool."
