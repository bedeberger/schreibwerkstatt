#!/bin/bash
# CD-Deploy – läuft vom GitHub Actions Runner auf dem LXC
# Erster Install: bash install.sh
# Updates: wird automatisch von GitHub Actions aufgerufen

set -e

export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

INSTALL_DIR="/opt/schreibwerkstatt"
SERVICE="schreibwerkstatt"

echo "=== Deploy schreibwerkstatt ==="

# DB-Backup vor Deploy via dediziertes Backup-Script.
# Skript aus Runner-Checkout nutzen (nicht $INSTALL_DIR/deploy/backup.sh) — rsync
# kommt erst danach, neu hinzugefuegte Skripte liegen sonst noch nicht im Ziel.
# Config (Pfad, Retention) via .env – siehe deploy/backup.sh.
if [ -f "$INSTALL_DIR/schreibwerkstatt.db" ]; then
  if ! bash ./deploy/backup.sh "$INSTALL_DIR/.env"; then
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
  --exclude='schreibwerkstatt.log*' --exclude='backup' --exclude='backups' --exclude='ai_parse_fails' \
  ./ "$INSTALL_DIR/"

# Ownership auf github-runner setzen
chown -R github-runner:github-runner "$INSTALL_DIR"

# Deploy-Migrations: einmalige Scripts unter deploy/migrations/ (z.B. Dateisystem-
# Cleanup, chown-Fixes, sqlite3-Touches). Marker-Datei .deploy-migrations-applied
# in $INSTALL_DIR verhindert Doppellauf. Konvention + Beispiele siehe README.md.
bash "$INSTALL_DIR/deploy/apply-migrations.sh" "$INSTALL_DIR"

# Abhängigkeiten aktualisieren
cd "$INSTALL_DIR"
npm install --omit=dev --quiet

# Service-Unit startet via `node server.js` (nicht `npm start`) → das prestart-Hook
# läuft auf Prod nie. Darum den Shell-Cache-Hash hier explizit aus dem deployten
# Asset-Stand regenerieren. Idempotent: rsync lieferte exakt die CI-getesteten
# Files, der Hash ist also identisch zum committeten Manifest.
node scripts/sw-manifest.js

# Service-Unit immer aktualisieren (User, Pfade etc. können sich ändern)
if [ -f "$INSTALL_DIR/deploy/schreibwerkstatt.service" ]; then
  cp "$INSTALL_DIR/deploy/schreibwerkstatt.service" /etc/systemd/system/
  systemctl daemon-reload
fi

# Backup-Service + Timer installieren / aktualisieren
if [ -f "$INSTALL_DIR/deploy/schreibwerkstatt-backup.service" ]; then
  cp "$INSTALL_DIR/deploy/schreibwerkstatt-backup.service" /etc/systemd/system/
  cp "$INSTALL_DIR/deploy/schreibwerkstatt-backup.timer"   /etc/systemd/system/
  chmod +x "$INSTALL_DIR/deploy/backup.sh"
  systemctl daemon-reload
  systemctl enable --now schreibwerkstatt-backup.timer >/dev/null
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
