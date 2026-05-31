# schreibwerkstatt.app

Schreiben, Lektorat und Buchanalyse mit KI. Eigenständiger Node.js-Service, Multi-User mit Rollen-ACL pro Buch. Inhalte (Bücher/Kapitel/Seiten) liegen lokal in SQLite — keine externe Storage-Abhängigkeit.

## Features

### Schreiben & Editor
- **Bearbeitungsmodus** – Seiten direkt bearbeiten. Auto-Save alle 30 s, lokaler Draft (localStorage), Offline-Modus mit Retry, Konflikterkennung gegen Server-Version.
- **Fokusmodus** (Cmd/Ctrl+Shift+E) – Vollbild, Typewriter-Scroll, Absatz-Hervorhebung. Auto-Save, Schreibzeit-Tracking, Live-Zeichen-/Wortzähler, Mobile-/IME-Support.
- **Bucheditor** – Ganzes Buch als scrollbarer Stream mit Kapitel-Trennern und Outline. Inline-Edit pro Seite, Save-All sequenziell. Buchweite Suche & Ersetzen (Case/Whole-Word, Treffer-Navigation, Replace-All).
- **Volltextsuche** – FTS5-Index über alle Seiten, Filterung nach Kapitel/Buch.
- **Buchorganizer** – Kapitel & Seiten per Drag&Drop ordnen, anlegen, umbenennen, löschen.
- **Seiten-Verlauf** – Revisionen pro Seite mit Vergleich + Restore.

### KI-Lektorat & Chat
- **Seitenlektorat** – Rechtschreib-, Grammatik- und Stilprüfung mit selektiver Korrekturübernahme.
- **Synonym-Finder** – Wort markieren → Rechtsklick → Vorschläge aus [OpenThesaurus](https://www.openthesaurus.de/) + KI mit Satzkontext.
- **Seiten-Chat** – KI-Dialog zu einer Seite. Änderungsvorschläge übernehmbar.
- **Buch-Chat** – KI-Dialog über das ganze Buch mit Werkzeugen (Pronomen-Zählung, Figurenverteilung, Volltextsuche, Seitenabruf) auf vorberechnetem Index.
- **Buchbewertung / Kapitelbewertung** – Stärken, Schwächen, Empfehlungen.
- **Lektorat-Verlauf** – Frühere Korrekturen als Inline-Highlights, selektiv nachträglich übernehmbar.

### Analyse & Übersichten
- **Buch-Übersicht** – Dashboard pro Buch: Zeichen-Trend, Schreib-Heatmap, Lektorat-Abdeckung, Top-Fehlertypen, Kapitel-Qualität, Figuren-/Orts-Präsenz.
- **Figurenübersicht** – Charakterextraktion mit Beziehungsgraph (Vollbild); Figurenkontext im Lektorat einblendbar.
- **Figuren-Werkstatt** – jsMind-Mindmap-Editor mit KI-Brainstorm pro Knoten + Konsistenz-Check. [docs/figur-werkstatt.md](docs/figur-werkstatt.md).
- **Ereignisse / Schauplätze / Szenen** – Übersichten pro Kapitel.
- **Kontinuitätsprüfer** – Findet Widersprüche.
- **Stil-Heatmap / Fehler-Heatmap** – Satzlänge, Adverbien, Füllwörter, Fehlertypen pro Kapitel.
- **Buchstatistik** – Tägliche Snapshots (Zeichen, Wörter, Tokens) als Zeitliniendiagramm.
- **Ideen-Sammlung** – Notiz-Sammelbox pro Buch oder Seite.
- **Musikbibliothek** – Pro Buch kuratierte Tracks (Titel, Interpret, Genre, Stimmung, Kontext-Typ) als Schreib-Inspiration; KI-gestützter Stimmungs-Match.

### Multi-User & Kollaboration
- **Rollen-ACL pro Buch** – owner / editor / lektor / viewer. Apply-only-Pfad für Lektoren (Korrekturen anwenden ohne freie Edit-Rechte).
- **Presence** – Mit-Anwesende pro Seite/Buch sichtbar (Avatar-Pip im Sidebar-Tree, Banner im Editor).
- **Page-Locks** – Soft-Lock beim Edit, automatische Heartbeats, Banner bei fremdem Lock.
- **Registrierung mit Approval** – Selbst-Registrierung mit Admin-Approval; Anti-Enumeration; optional Captcha.
- **Admin-Konsole** – Web-UI für User, Bücher, Settings, Kategorien, Usage.

### Export & Tooling
- **Command-Palette** (Cmd/Ctrl+K bzw. `/`) – Fuzzy-Suche über Karten, Aktionen, Seiten, Kapitel, Figuren, Orte, Szenen. Prefix-Modi: `>` `#` `!` `@` `$` `%`.
- **Fine-Tuning-Export** – JSONL-Trainingsdaten (Stil, Szenen, Dialoge, Q&A, Korrekturen). [docs/finetuning.md](docs/finetuning.md).
- **Buch-Export** – PDF, HTML, Markdown, Plaintext, EPUB mit Timestamp-Filename.
- **Custom-PDF-Export** – Eigener pdfkit-Renderer mit druckfertiger PDF/A-2B-Konformität, freier Schriftwahl aus Google Fonts (30-Tage-Cache), Cover, TOC, Profile pro Buch+User. Optional Server-Validierung via veraPDF.
- **Bucheinstellungen** – Sprache, Buchtyp, Erzählperspektive, Erzählzeit, Freitext-Kontext fliessen in alle Prompts.
- **Theme** – Hell/Dunkel/Auto, Sprachumschaltung Deutsch/Englisch.

## Voraussetzungen

- Node.js v20–24 (Node 26 noch nicht unterstützt: better-sqlite3 11.x baut nicht gegen das V8 in Node 26 — Bump auf 12.x ausstehend). Empfohlen: `.nvmrc` (Node 24).
- Öffentliche HTTPS-URL (Reverse-Proxy mit TLS) für Produktion.
- Login-Pfad: **Admin-Bootstrap** (Email+Passwort via ENV) und/oder **Google OAuth2** (Callback `https://<domain>/auth/callback`). Mindestens einer muss konfiguriert sein.

## Quick Start

```bash
git clone https://github.com/<user>/schreibwerkstatt.git
cd schreibwerkstatt
cp .env.example .env   # SESSION_SECRET (32+ Hex) ist Pflicht
npm ci --omit=dev
node server.js         # Port 3737
```

KI-Provider, Google-OAuth, App-URL, Modell-Limits, Mailer, Cron, veraPDF konfiguriert die **Admin-Konsole** (Tabelle `app_settings`, kein Restart nötig).

Produktiv: systemd-Service via [deploy/schreibwerkstatt.service](deploy/schreibwerkstatt.service), Erst-Install `bash deploy/install.sh`, CD `bash deploy/deploy.sh`.

### Deploy-Migrations

Einmalige Prod-Anpassungen (Dateisystem-Cleanup, chown-Fixes, sqlite3-Touches) gehören als idempotente Shell-Scripts unter [deploy/migrations/](deploy/migrations/) — Konvention `NNN-slug.sh` (3-stellige fortlaufende Nummer). [deploy/apply-migrations.sh](deploy/apply-migrations.sh) läuft nach jedem Deploy (nach rsync + chown, vor `npm install`), führt nur Scripts aus, deren `NNN` nicht in `$INSTALL_DIR/.deploy-migrations-applied` steht, und appendet bei Erfolg. Script erhält `$INSTALL_DIR` als `$1`. Fehler bricht Deploy ab. Migration trotzdem idempotent schreiben (Marker könnte verloren gehen).

### Reverse-Proxy

SSE braucht ungepufferte Verbindungen:

```nginx
proxy_buffering    off;
proxy_cache        off;
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

### Optional: veraPDF (PDF/A-Validierung)

Ohne veraPDF läuft die Validierung im Skip-Modus, das PDF wird trotzdem geliefert. Für strikte Validierung:

```bash
apt-get install -y default-jre-headless curl unzip   # oder: apk add openjdk17-jre-headless curl unzip

VERAPDF_VERSION=1.26.2
curl -sSL "https://software.verapdf.org/releases/verapdf-greenfield-${VERAPDF_VERSION}.zip" -o /tmp/verapdf.zip
mkdir -p /opt/verapdf && unzip -q /tmp/verapdf.zip -d /opt/verapdf
cd /opt/verapdf/verapdf-greenfield-${VERAPDF_VERSION}
java -cp installer-${VERAPDF_VERSION}.jar org.verapdf.apps.Installer -options auto-install-options.xml
# /opt/verapdf-installation in PATH oder VERAPDF_BIN setzen
```

### Optional: EPUBCheck (EPUB-Validierung)

Auf Prod erledigt das die Deploy-Migration [deploy/migrations/004-install-epubcheck.sh](deploy/migrations/004-install-epubcheck.sh) automatisch (läuft bei jedem Deploy, idempotent). Ohne EPUBCheck läuft die EPUB-Validierung im Skip-Modus, das EPUB wird trotzdem geliefert. Manuell (W3C-Referenzvalidator, Java):

```bash
# Einfachster Weg: paketverwalteter Wrapper (liefert ein 'epubcheck'-Executable in PATH)
apt-get install -y epubcheck            # oder: apk add epubcheck / brew install epubcheck

# Alternativ ein eigenes Wrapper-Skript anlegen und via EPUBCHECK_BIN referenzieren —
# EPUBCHECK_BIN muss ein aufrufbares Executable sein (kein "java -jar …"-String):
#   #!/bin/sh
#   exec java -jar /opt/epubcheck/epubcheck.jar "$@"
# Deaktivieren ohne Deinstallation: app_settings epub.validate.disabled = true
```

### Update

```bash
git pull && npm ci --omit=dev && systemctl restart schreibwerkstatt
```

## Admin-Konsole

Unter `/admin` für User mit `global_role = 'admin'`:
- **Users** — Rollen, Sperren, Provider-Override pro User.
- **Books** — alle Bücher mit ACL-Einsicht/Übertragung.
- **Registrierungs-Anfragen** — Approval-Queue für `/register`-Selbstanmeldungen.
- **Settings** — KI-Provider + Keys, Google OAuth, App-URL, Modell-Limits, Mailer, Cron, veraPDF-Flavour.
- **Kategorien** — globaler Pool, Zuordnung pro Buch via ACL.
- **Usage** — Token-Verbrauch pro User/Provider/Job-Typ.

`ADMIN_EMAIL` in `.env` wird beim Start als globale Admin-Rolle gespiegelt (idempotent). Passwort lebt ausschliesslich in der ENV (timing-safe Vergleich, Rate-Limit pro IP).

## Backup

Tägliches Online-Backup der SQLite-DB via systemd-Timer (`schreibwerkstatt-backup.timer`, Default 03:00). `sqlite3 .backup` (lock-frei, WAL-konsistent), gzip-komprimiert, Retention nach `mtime`. Pre-Deploy zusätzlicher Snapshot.

Konfig via `.env`: `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_DB_FILE`. Script + Units: [deploy/backup.sh](deploy/backup.sh), [deploy/schreibwerkstatt-backup.service](deploy/schreibwerkstatt-backup.service), [deploy/schreibwerkstatt-backup.timer](deploy/schreibwerkstatt-backup.timer).

Backup-Ordner offsite spiegeln (rsync nach NAS/S3) — sonst Single-Point-of-Failure.

## Prompts anpassen

`prompt-config.json` im Projektroot (Pflichtdatei). Konfigurierbar: `locales` (`de-CH`/`de-DE`/`en-US`/`en-GB` mit Regeln, Rollen, Stoppwortlisten), `buchtypen` (Genre pro Sprache mit Label + Kontext), `erklaerungRule` (globale Fehlerfilter-Regel), `defaultLocale`. Per-Buch in der UI: Buchtyp + Freitext-Kontext. Änderungen beim nächsten Serverstart aktiv.

## Lokale Entwicklung

`LOCAL_DEV_MODE=true` in `.env` überspringt OAuth, legt Dev-Session an (`dev@local`).

> Niemals in Produktion – Auth-Guard wird komplett deaktiviert.

## Credits

### Plattformen & Modelle

- **[Anthropic Claude](https://www.anthropic.com/)** – KI-Modell (Anthropic Usage Policies; Outputs frei nutzbar)
- **[Ollama](https://ollama.com/)** (MIT) / **[llama.cpp](https://github.com/ggerganov/llama.cpp)** (MIT) / **[LM Studio](https://lmstudio.ai/)** – lokale LLMs
- **[OpenThesaurus](https://www.openthesaurus.de/)** – Synonyme (LGPL/CC-BY-SA; Nutzung via öffentliche API, keine Redistribution)
- **[veraPDF](https://verapdf.org/)** – PDF/A-Validierung (GPL-3.0; externer Prozess)

### Frontend-Libraries (vendored in [public/vendor/](public/vendor/))

- **[Alpine.js](https://alpinejs.dev/)** (MIT), **[vis-network](https://visjs.github.io/vis-network/)** (Apache-2.0 + MIT), **[Chart.js](https://www.chartjs.org/)** (MIT), **[SortableJS](https://github.com/SortableJS/Sortable)** (MIT), **[jsMind](https://github.com/hizzgdev/jsmind)** (BSD-3-Clause).

Originallizenztexte: [public/vendor/LICENSES/](public/vendor/LICENSES/).

### Fonts

- **[Inter](https://rsms.me/inter/)** © Rasmus Andersson – SIL Open Font License 1.1
- **[Source Serif 4](https://github.com/adobe-fonts/source-serif)** © Adobe – SIL Open Font License 1.1

Schriftdateien in [public/fonts/](public/fonts/), Lizenz [public/fonts/OFL.txt](public/fonts/OFL.txt). Custom-PDF-Export bettet zur Laufzeit Google-Fonts-Familien ein (jeweils SIL OFL 1.1 oder Apache-2.0).

### Server-Dependencies

Vollständige Liste in [package.json](package.json) – durchgehend OSI-genehmigte permissive Lizenzen (MIT/Apache-2.0/BSD/ISC). Auswahl: Express, better-sqlite3, pdfkit, sharp, linkedom, jsonrepair, winston, helmet, openid-client, node-cron, xmlbuilder2, epub-gen-memory, @turbodocx/html-to-docx.

## Lizenz

**GNU Affero General Public License v3.0** (AGPL-3.0) – siehe [LICENSE](LICENSE). Wer den Dienst über ein Netzwerk anbietet, muss den modifizierten Quellcode den Nutzern verfügbar machen (§ 13 AGPL).

Drittsoftware-Lizenzen: [public/vendor/LICENSES/](public/vendor/LICENSES/), Schriften [public/fonts/OFL.txt](public/fonts/OFL.txt).
