#!/bin/bash
# Deploy-Migrations: idempotente Einmal-Scripts auf Prod.
# Konvention: deploy/migrations/NNN-slug.sh (NNN = 3-stellig, fortlaufend).
# Marker: $INSTALL_DIR/.deploy-migrations-applied (eine Zeile pro Lauf: "NNN <ISO-Timestamp>").
# Migration-Script bekommt $INSTALL_DIR als $1. Exit 0 = ok, sonst Abbruch.

set -e

INSTALL_DIR="${1:-/opt/schreibwerkstatt}"
MIGRATIONS_DIR="$INSTALL_DIR/deploy/migrations"
MARKER="$INSTALL_DIR/.deploy-migrations-applied"

[ -d "$MIGRATIONS_DIR" ] || exit 0

touch "$MARKER"

shopt -s nullglob
for f in "$MIGRATIONS_DIR"/[0-9][0-9][0-9]-*.sh; do
  num="$(basename "$f" | cut -c1-3)"
  if grep -q "^$num " "$MARKER"; then
    continue
  fi
  echo "→ Migration $num: $(basename "$f")"
  if ! bash "$f" "$INSTALL_DIR"; then
    echo "✗ Migration $num fehlgeschlagen – Deploy abgebrochen"
    exit 1
  fi
  echo "$num $(date -Iseconds)" >> "$MARKER"
  echo "✓ Migration $num applied"
done
