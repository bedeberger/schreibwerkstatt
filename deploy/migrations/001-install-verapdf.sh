#!/bin/bash
# Installiert veraPDF-CLI fuer PDF/A-Validierung des Custom-PDF-Exports.
# Idempotent: ueberspringt, wenn 'verapdf' bereits im PATH ist.

set -e

VERAPDF_VERSION="${VERAPDF_VERSION:-1.26.2}"
VERAPDF_MINOR="${VERAPDF_VERSION%.*}"
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

echo "→ JRE + Tools installieren (Java 8 für IzPack-Installer mit pack200, Default-JRE zur Laufzeit)"
$SUDO apt-get update -qq
$SUDO apt-get install -y --no-install-recommends default-jre-headless curl unzip

# IzPack 5 nutzt pack200, das ab Java 14 entfernt wurde → ArrayIndexOutOfBoundsException.
# Installer-Schritt braucht Java 8 oder 11. Ubuntu 24.04 hat nur Java 8 (universe) + 17/21.
if ! $SUDO apt-get install -y --no-install-recommends openjdk-8-jre-headless; then
  echo "→ openjdk-8 nicht in Quellen, universe aktivieren"
  $SUDO apt-get install -y --no-install-recommends software-properties-common
  $SUDO add-apt-repository -y universe
  $SUDO apt-get update -qq
  $SUDO apt-get install -y --no-install-recommends openjdk-8-jre-headless
fi

JAVA_LEGACY_BIN="$(ls -1 /usr/lib/jvm/java-8-openjdk-*/jre/bin/java /usr/lib/jvm/java-8-openjdk-*/bin/java 2>/dev/null | head -n1)"
if [ -z "$JAVA_LEGACY_BIN" ]; then
  echo "✗ Java 8 nicht gefunden — IzPack 5 + Java 14+ wirft ArrayIndexOutOfBoundsException"
  exit 1
fi

TMP_ZIP="$(mktemp --suffix=.zip)"
trap 'rm -f "$TMP_ZIP"' EXIT

echo "→ veraPDF $VERAPDF_VERSION laden"
curl -fsSL "https://software.verapdf.org/rel/${VERAPDF_MINOR}/verapdf-greenfield-${VERAPDF_VERSION}-installer.zip" -o "$TMP_ZIP"

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

INSTALLER_JAR="$(ls "$GREENFIELD_DIR"/*installer*.jar 2>/dev/null | head -n1)"
if [ -z "$INSTALLER_JAR" ]; then
  echo "✗ Installer-JAR nicht gefunden in $GREENFIELD_DIR"
  ls -la "$GREENFIELD_DIR" || true
  exit 1
fi

echo "→ Installer ausfuehren: $(basename "$INSTALLER_JAR") (Java 8)"
$SUDO "$JAVA_LEGACY_BIN" -jar "$INSTALLER_JAR" "$AUTO_OPTS"

if [ ! -x "$INSTALL_TARGET/verapdf" ]; then
  echo "✗ verapdf-Binary nicht gefunden unter $INSTALL_TARGET/verapdf"
  exit 1
fi

echo "→ Symlink $SYMLINK"
$SUDO ln -sf "$INSTALL_TARGET/verapdf" "$SYMLINK"

echo "→ Smoke-Test"
verapdf --version >/dev/null

echo "✓ veraPDF $VERAPDF_VERSION installiert: $(command -v verapdf)"
