#!/bin/bash
# Schreibwerkstatt – Installer
# Läuft auf dem LXC wo writing.david-berger.ch läuft
# Usage: bash install.sh

set -e

INSTALL_DIR="/opt/schreibwerkstatt"
SERVICE="schreibwerkstatt"
OLD_INSTALL_DIR="/opt/lektorat"
OLD_SERVICE="lektorat"
PORT=3737

echo ""
echo "=== Schreibwerkstatt Installer ==="
echo ""

# Einmalige Migration vom alten Pfad/Service-Namen
if [ -d "$OLD_INSTALL_DIR" ] && [ ! -d "$INSTALL_DIR" ]; then
  echo "Migriere $OLD_INSTALL_DIR → $INSTALL_DIR ..."
  if systemctl is-active --quiet "$OLD_SERVICE"; then
    systemctl stop "$OLD_SERVICE"
  fi
  if systemctl is-enabled --quiet "$OLD_SERVICE" 2>/dev/null; then
    systemctl disable "$OLD_SERVICE"
  fi
  rm -f "/etc/systemd/system/${OLD_SERVICE}.service"
  mv "$OLD_INSTALL_DIR" "$INSTALL_DIR"
  # DB/Log umbenennen, falls noch alte Filenames im Datenverzeichnis liegen
  [ -f "$INSTALL_DIR/lektorat.db" ]     && mv "$INSTALL_DIR/lektorat.db"     "$INSTALL_DIR/schreibwerkstatt.db"
  [ -f "$INSTALL_DIR/lektorat.db-wal" ] && mv "$INSTALL_DIR/lektorat.db-wal" "$INSTALL_DIR/schreibwerkstatt.db-wal"
  [ -f "$INSTALL_DIR/lektorat.db-shm" ] && mv "$INSTALL_DIR/lektorat.db-shm" "$INSTALL_DIR/schreibwerkstatt.db-shm"
  for f in "$INSTALL_DIR"/lektorat*.log*; do
    [ -e "$f" ] || continue
    mv "$f" "${f/lektorat/schreibwerkstatt}"
  done
  systemctl daemon-reload
fi

# Node.js prüfen
if ! command -v node &>/dev/null; then
  echo "Node.js nicht gefunden. Installiere Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
else
  NODE_VER=$(node -v)
  echo "Node.js gefunden: $NODE_VER"
fi

# Zielverzeichnis anlegen
echo "Installiere nach $INSTALL_DIR..."
mkdir -p "$INSTALL_DIR"
cp -r . "$INSTALL_DIR/"

# npm install
cd "$INSTALL_DIR"
echo "Installiere npm-Abhängigkeiten..."
npm install --omit=dev --quiet

# Systemd Service installieren
echo "Installiere systemd service..."
cp deploy/schreibwerkstatt.service "/etc/systemd/system/${SERVICE}.service"

# Backup-Service + täglicher Timer (Config via .env; siehe deploy/backup.sh)
echo "Installiere Backup-Timer..."
cp deploy/schreibwerkstatt-backup.service /etc/systemd/system/
cp deploy/schreibwerkstatt-backup.timer   /etc/systemd/system/
chmod +x "$INSTALL_DIR/deploy/backup.sh"

systemctl daemon-reload
systemctl enable "$SERVICE"
systemctl enable --now schreibwerkstatt-backup.timer
systemctl restart "$SERVICE"

# Status prüfen
sleep 1
if systemctl is-active --quiet "$SERVICE"; then
  echo ""
  echo "✓ Schreibwerkstatt läuft auf http://$(hostname -I | awk '{print $1}'):${PORT}"
  echo ""
  echo "Nützliche Befehle:"
  echo "  systemctl status $SERVICE"
  echo "  journalctl -u $SERVICE -f"
  echo "  systemctl restart $SERVICE"
else
  echo ""
  echo "✗ Service konnte nicht gestartet werden. Logs:"
  journalctl -u "$SERVICE" -n 20 --no-pager
  exit 1
fi
