#!/bin/bash
# Installiert veraPDF-CLI fuer PDF/A-Validierung des Custom-PDF-Exports.
# Idempotent: ueberspringt, wenn 'verapdf' bereits im PATH ist.

set -e

VERAPDF_VERSION="${VERAPDF_VERSION:-1.26.2}"
INSTALL_BASE="/opt/verapdf"
INSTALL_TARGET="/opt/verapdf-installation"
SYMLINK="/usr/local/bin/verapdf"

if command -v verapdf >/dev/null 2>&1; then
  echo "verapdf bereits installiert: $(command -v verapdf)"
  exit 0
fi

if ! command -v sudo >/dev/null 2>&1; then
  SUDO=""
else
  SUDO="sudo"
fi

echo "→ JRE + Tools installieren"
$SUDO apt-get update -qq
$SUDO apt-get install -y --no-install-recommends default-jre-headless curl unzip

TMP_ZIP="$(mktemp --suffix=.zip)"
trap 'rm -f "$TMP_ZIP"' EXIT

echo "→ veraPDF $VERAPDF_VERSION laden"
curl -fsSL "https://software.verapdf.org/releases/verapdf-greenfield-${VERAPDF_VERSION}.zip" -o "$TMP_ZIP"

echo "→ entpacken nach $INSTALL_BASE"
$SUDO mkdir -p "$INSTALL_BASE"
$SUDO unzip -oq "$TMP_ZIP" -d "$INSTALL_BASE"

GREENFIELD_DIR="$INSTALL_BASE/verapdf-greenfield-${VERAPDF_VERSION}"
if [ ! -d "$GREENFIELD_DIR" ]; then
  echo "✗ Greenfield-Verzeichnis fehlt: $GREENFIELD_DIR"
  exit 1
fi

AUTO_OPTS="$GREENFIELD_DIR/auto-install-options.xml"
if [ ! -f "$AUTO_OPTS" ]; then
  echo "→ auto-install-options.xml erzeugen"
  $SUDO tee "$AUTO_OPTS" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<AutomatedInstallation langpack="eng">
  <com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
  <com.izforge.izpack.panels.target.TargetPanel id="install_dir">
    <installpath>$INSTALL_TARGET</installpath>
  </com.izforge.izpack.panels.target.TargetPanel>
  <com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
    <pack index="0" name="veraPDF GUI" selected="true"/>
    <pack index="1" name="veraPDF Mac and *nix Scripts" selected="true"/>
    <pack index="2" name="veraPDF Validation model" selected="false"/>
    <pack index="3" name="veraPDF Documentation" selected="false"/>
    <pack index="4" name="veraPDF Sample Plugins" selected="false"/>
  </com.izforge.izpack.panels.packs.PacksPanel>
  <com.izforge.izpack.panels.install.InstallPanel id="install"/>
  <com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
EOF
fi

echo "→ Installer ausfuehren"
cd "$GREENFIELD_DIR"
$SUDO java -cp "installer-${VERAPDF_VERSION}.jar" org.verapdf.apps.Installer -options "$AUTO_OPTS"

if [ ! -x "$INSTALL_TARGET/verapdf" ]; then
  echo "✗ verapdf-Binary nicht gefunden unter $INSTALL_TARGET/verapdf"
  exit 1
fi

echo "→ Symlink $SYMLINK"
$SUDO ln -sf "$INSTALL_TARGET/verapdf" "$SYMLINK"

echo "→ Smoke-Test"
verapdf --version >/dev/null

echo "✓ veraPDF $VERAPDF_VERSION installiert: $(command -v verapdf)"
