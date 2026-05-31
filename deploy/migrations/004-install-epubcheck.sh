#!/bin/bash
# Installiert EPUBCheck (W3C-Referenzvalidator) fuer die EPUB-Validierung des
# Custom-EPUB-Exports (lib/epubcheck-validate.js ruft das 'epubcheck'-Binary auf).
# Idempotent: ueberspringt, wenn 'epubcheck' bereits im PATH ist.
#
# EPUBCheck ist ein Java-Tool. Anders als der veraPDF-IzPack-Installer (Java 8)
# laeuft EPUBCheck 5.x mit jedem modernen JRE (Ubuntu 24.04 default-jre = Java 21).
# Wir laden das Release-Zip von GitHub, entpacken nach /opt/epubcheck und legen
# einen Wrapper /usr/local/bin/epubcheck an, der die epubcheck.jar aufruft —
# damit ist 'epubcheck' ein echtes Executable (EPUBCHECK_BIN-Default), wie es
# der execFile-Aufruf im Wrapper erwartet (kein "java -jar …"-String).

set -e

EPUBCHECK_VERSION="${EPUBCHECK_VERSION:-5.2.1}"
INSTALL_BASE="/opt/epubcheck"
INSTALL_DIR_VER="$INSTALL_BASE/epubcheck-${EPUBCHECK_VERSION}"
JAR="$INSTALL_DIR_VER/epubcheck.jar"
SYMLINK="/usr/local/bin/epubcheck"

if command -v epubcheck >/dev/null 2>&1; then
  echo "epubcheck bereits installiert: $(command -v epubcheck)"
  exit 0
fi

if ! command -v sudo >/dev/null 2>&1; then
  SUDO=""
else
  SUDO="sudo"
fi

echo "→ Default-JRE + Tools installieren (Laufzeit)"
$SUDO apt-get update -qq
$SUDO apt-get install -y --no-install-recommends default-jre-headless curl unzip

TMP_ZIP="$(mktemp --suffix=.zip)"
trap 'rm -f "$TMP_ZIP"' EXIT

echo "→ EPUBCheck $EPUBCHECK_VERSION laden"
curl -fsSL "https://github.com/w3c/epubcheck/releases/download/v${EPUBCHECK_VERSION}/epubcheck-${EPUBCHECK_VERSION}.zip" -o "$TMP_ZIP"

echo "→ entpacken nach $INSTALL_BASE"
$SUDO mkdir -p "$INSTALL_BASE"
$SUDO unzip -oq "$TMP_ZIP" -d "$INSTALL_BASE"

if [ ! -f "$JAR" ]; then
  echo "✗ epubcheck.jar nicht gefunden unter $JAR"
  $SUDO ls -la "$INSTALL_DIR_VER" 2>/dev/null || $SUDO ls -la "$INSTALL_BASE" || true
  exit 1
fi

echo "→ Wrapper $SYMLINK erzeugen"
$SUDO tee "$SYMLINK" >/dev/null <<EOF
#!/bin/sh
exec java -jar "$JAR" "\$@"
EOF
$SUDO chmod +x "$SYMLINK"

echo "→ Smoke-Test"
# EPUBCheck kennt kein sauberes --version. Ohne Argumente bricht der Arg-Parser
# sofort mit "At least one argument expected" ab — noch BEVOR das Banner kommt.
# Der --help-Pfad druckt dagegen das "EPUBCheck vX.Y.Z"-Banner + Usage und
# beendet sich non-zero → || true und grep.
SMOKE="$(epubcheck --help 2>&1 || true)"
if ! echo "$SMOKE" | grep -qi "epubcheck"; then
  echo "✗ Smoke-Test fehlgeschlagen — kein EPUBCheck-Banner"
  echo "$SMOKE" | head -n5
  exit 1
fi

echo "✓ EPUBCheck $EPUBCHECK_VERSION installiert: $(command -v epubcheck)"
