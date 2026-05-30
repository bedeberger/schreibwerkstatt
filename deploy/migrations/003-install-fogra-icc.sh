#!/bin/bash
# Laedt das Output-Intent-ICC PSO Uncoated v3 (FOGRA52) fuer den PDF/X-3-Export
# (lib/pdfx-convert.js bettet es als Druckbedingung ein). Default-Pfad:
# assets/icc/PSOuncoated_v3_FOGRA52.icc — die .icc-Binaerdatei ist bewusst NICHT
# im Repo eingecheckt (siehe assets/icc/README.md), darum dieser Deploy-Download.
# Quelle: offizielle ICC-Registry (color.org). Idempotent: ueberspringt, wenn das
# Profil bereits als valides ICC (acsp-Magic an Offset 36) vorliegt.

set -e

INSTALL_DIR="${1:-/opt/schreibwerkstatt}"
ICC_DIR="$INSTALL_DIR/assets/icc"
ICC_PATH="$ICC_DIR/PSOuncoated_v3_FOGRA52.icc"
ICC_URL="https://www.color.org/registry/profiles/PSOuncoated_v3_FOGRA52.icc"

# acsp-Magic an Byte 36-39 prueft, dass eine vorhandene Datei wirklich ein ICC ist.
is_valid_icc() {
  [ -f "$1" ] && [ "$(dd if="$1" bs=1 skip=36 count=4 2>/dev/null)" = "acsp" ]
}

if is_valid_icc "$ICC_PATH"; then
  echo "FOGRA52-ICC bereits vorhanden: $ICC_PATH"
  exit 0
fi

mkdir -p "$ICC_DIR"

echo "→ FOGRA52-ICC laden von $ICC_URL"
if ! curl -fsSL -A "Mozilla/5.0" -o "$ICC_PATH.tmp" "$ICC_URL"; then
  echo "✗ Download fehlgeschlagen"
  rm -f "$ICC_PATH.tmp"
  exit 1
fi

if ! is_valid_icc "$ICC_PATH.tmp"; then
  echo "✗ Heruntergeladene Datei ist kein valides ICC (acsp-Magic fehlt)"
  rm -f "$ICC_PATH.tmp"
  exit 1
fi

mv "$ICC_PATH.tmp" "$ICC_PATH"
chown github-runner:github-runner "$ICC_PATH" 2>/dev/null || true

echo "✓ FOGRA52-ICC installiert: $ICC_PATH ($(wc -c < "$ICC_PATH") Bytes)"
