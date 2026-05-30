#!/bin/bash
# Installiert Ghostscript fuer die PDF/X-Konvertierung des Custom-PDF-Exports
# (lib/pdfx-convert.js ruft das 'gs'-Binary auf).
# Idempotent: ueberspringt, wenn 'gs' bereits im PATH ist.

set -e

if command -v gs >/dev/null 2>&1; then
  echo "ghostscript bereits installiert: $(gs --version 2>/dev/null) ($(command -v gs))"
  exit 0
fi

if ! command -v sudo >/dev/null 2>&1; then
  SUDO=""
else
  SUDO="sudo"
fi

echo "→ Ghostscript installieren"
$SUDO apt-get update -qq
$SUDO apt-get install -y --no-install-recommends ghostscript

if ! command -v gs >/dev/null 2>&1; then
  echo "✗ gs-Binary nach Installation nicht im PATH"
  exit 1
fi

echo "→ Smoke-Test"
gs --version >/dev/null

echo "✓ Ghostscript installiert: $(gs --version) ($(command -v gs))"
