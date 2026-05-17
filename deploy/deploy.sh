#!/bin/bash
# CD-Deploy – läuft vom GitHub Actions Runner auf dem LXC
# Erster Install: bash install.sh
# Updates: wird automatisch von GitHub Actions aufgerufen

set -e

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

INSTALL_DIR="/opt/schreibwerkstatt"
SERVICE="schreibwerkstatt"
OLD_INSTALL_DIR="/opt/lektorat"
OLD_SERVICE="lektorat"

echo "=== Deploy schreibwerkstatt ==="

# Einmalige Migration, falls dieser Runner noch unter dem alten Pfad läuft
if [ -d "$OLD_INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  echo "Migriere $OLD_INSTALL_DIR → $INSTALL_DIR ..."
  systemctl is-active --quiet "$OLD_SERVICE" && systemctl stop "$OLD_SERVICE" || true
  systemctl is-enabled --quiet "$OLD_SERVICE" 2>/dev/null && systemctl disable "$OLD_SERVICE" || true
  rm -f "/etc/systemd/system/${OLD_SERVICE}.service"
  mv "$OLD_INSTALL_DIR" "$INSTALL_DIR"
  [ -f "$INSTALL_DIR/lektorat.db" ]     && mv "$INSTALL_DIR/lektorat.db"     "$INSTALL_DIR/schreibwerkstatt.db"
  [ -f "$INSTALL_DIR/lektorat.db-wal" ] && mv "$INSTALL_DIR/lektorat.db-wal" "$INSTALL_DIR/schreibwerkstatt.db-wal"
  [ -f "$INSTALL_DIR/lektorat.db-shm" ] && mv "$INSTALL_DIR/lektorat.db-shm" "$INSTALL_DIR/schreibwerkstatt.db-shm"
  for f in "$INSTALL_DIR"/lektorat*.log*; do
    [ -e "$f" ] || continue
    mv "$f" "${f/lektorat/schreibwerkstatt}"
  done
  systemctl daemon-reload
fi

# DB-Backup vor Deploy (sicher online via sqlite3 .backup, hält letzte 10)
DB_FILE="$INSTALL_DIR/schreibwerkstatt.db"
BACKUP_DIR="$INSTALL_DIR/backups"
if [ -f "$DB_FILE" ]; then
  mkdir -p "$BACKUP_DIR"
  TS=$(date '+%Y%m%d-%H%M%S')
  BACKUP_FILE="$BACKUP_DIR/schreibwerkstatt-$TS.db"
  if sqlite3 "$DB_FILE" ".backup '$BACKUP_FILE'"; then
    gzip "$BACKUP_FILE"
    echo "✓ DB-Backup: ${BACKUP_FILE}.gz"
    ls -1t "$BACKUP_DIR"/schreibwerkstatt-*.db.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
  else
    echo "✗ DB-Backup fehlgeschlagen – Deploy abgebrochen"
    exit 1
  fi
fi

# Dateien synchronisieren (.env und node_modules bleiben unangetastet).
# --delete: entfernt aus dem Repo geloeschte Dateien auch auf Prod. Ohne diesen
# Flag bleiben Stale-Module liegen und Node-Resolution kann sie statt der
# neuen Variante laden (z.B. lib/foo.js maskiert lib/foo/index.js).
rsync -a --delete \
  --exclude='.env' --exclude='node_modules' --exclude='.git' \
  --exclude='schreibwerkstatt.db' --exclude='schreibwerkstatt.db-wal' --exclude='schreibwerkstatt.db-shm' \
  --exclude='schreibwerkstatt.log*' --exclude='backups' --exclude='ai_parse_fails' \
  ./ "$INSTALL_DIR/"

# Ownership auf github-runner setzen
chown -R github-runner:github-runner "$INSTALL_DIR"

# Abhängigkeiten aktualisieren
cd "$INSTALL_DIR"
npm install --omit=dev --quiet

# Service-Unit immer aktualisieren (User, Pfade etc. können sich ändern)
if [ -f "$INSTALL_DIR/deploy/schreibwerkstatt.service" ]; then
  cp "$INSTALL_DIR/deploy/schreibwerkstatt.service" /etc/systemd/system/
  systemctl daemon-reload
fi

# Service starten oder neu starten
if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then
  systemctl restart "$SERVICE"
else
  systemctl enable "$SERVICE"
  systemctl start "$SERVICE"
fi

sleep 1
if systemctl is-active --quiet "$SERVICE"; then
  echo "✓ $(date '+%Y-%m-%d %H:%M:%S') – deployed & running"
else
  echo "✗ Service konnte nicht gestartet werden:"
  journalctl -u "$SERVICE" -n 20 --no-pager
  exit 1
fi
