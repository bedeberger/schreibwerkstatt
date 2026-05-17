# schreibwerkstatt

Schreiben, Lektorat und Buchanalyse mit KI. Eigenständiger Node.js-Service, Multi-User mit Rollen-ACL pro Buch. Inhalte (Bücher/Kapitel/Seiten) leben lokal in SQLite — keine externe Storage-Abhängigkeit.

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
- **Admin-Konsole** – Web-UI für User, Bücher, Settings, Kategorien, Usage. Kein direktes File-Editing nötig.

### Export & Tooling
- **Command-Palette** (Cmd/Ctrl+K bzw. `/`) – Fuzzy-Suche über Karten, Aktionen, Seiten, Kapitel, Figuren, Orte, Szenen. Prefix-Modi: `>` `#` `!` `@` `$` `%`.
- **Fine-Tuning-Export** – JSONL-Trainingsdaten (Stil, Szenen, Dialoge, Q&A, Korrekturen). [docs/finetuning.md](docs/finetuning.md).
- **Buch-Export** – PDF, HTML, Markdown, Plaintext, EPUB mit Timestamp-Filename.
- **Custom-PDF-Export** – Eigener pdfkit-Renderer mit druckfertiger PDF/A-2B-Konformität, freier Schriftwahl aus Google Fonts (30-Tage-Cache), Cover, TOC, Profile pro Buch+User. Optional Server-Validierung via veraPDF.
- **Bucheinstellungen** – Sprache, Buchtyp, Erzählperspektive, Erzählzeit, Freitext-Kontext fliessen in alle Prompts.
- **Theme** – Hell/Dunkel/Auto, Sprachumschaltung Deutsch/Englisch.

## Voraussetzungen

- Node.js v20+.
- Öffentliche HTTPS-URL (Reverse-Proxy mit TLS) für Produktion.
- Login-Pfad: **Admin-Bootstrap** (Email+Passwort via ENV) und/oder **Google OAuth2** (Callback `https://<domain>/auth/callback`). Mindestens einer muss konfiguriert sein. Google-Credentials werden in der Admin-Konsole gepflegt, kein Restart nötig.

## Quick Start (LXC / Bare Metal)

```bash
git clone https://github.com/<user>/schreibwerkstatt.git
cd schreibwerkstatt
cp .env.example .env
# Nur SESSION_SECRET ist Pflicht (32+ Hex-Zeichen). Optional: ADMIN_EMAIL +
# ADMIN_PASSWORD für den ersten Login ohne Google.
npm ci --omit=dev
node server.js    # Port 3737
```

Konfiguration (KI-Provider, Google-OAuth, App-URL, Modell-Limits, Mailer, Cron, veraPDF) läuft über die **Admin-Konsole**. Alle Werte landen in `app_settings` (SQLite); Änderungen greifen ohne Restart.

Legacy: liegt ein bekannter alter Key in der ENV (`ANTHROPIC_API_KEY`, `MODEL_TOKEN`, `GOOGLE_CLIENT_ID`, `APP_URL`, …), wird er beim Server-Start einmalig in `app_settings` gespiegelt (`ENV_MAP` in [lib/app-settings.js](lib/app-settings.js)). Danach ist die DB Wahrheit.

Produktiv: systemd-Service via [deploy/schreibwerkstatt.service](deploy/schreibwerkstatt.service) (User/WorkingDirectory anpassen, dann `systemctl enable --now schreibwerkstatt`). Erst-Install: `bash deploy/install.sh`. CD via [deploy/deploy.sh](deploy/deploy.sh).

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
apk add --no-cache openjdk17-jre-headless curl unzip   # Alpine
# oder: apt-get install -y default-jre-headless curl unzip   # Debian/Ubuntu

VERAPDF_VERSION=1.26.2
curl -sSL "https://software.verapdf.org/releases/verapdf-greenfield-${VERAPDF_VERSION}.zip" -o /tmp/verapdf.zip
mkdir -p /opt/verapdf && unzip -q /tmp/verapdf.zip -d /opt/verapdf
cd /opt/verapdf/verapdf-greenfield-${VERAPDF_VERSION}
java -cp installer-${VERAPDF_VERSION}.jar org.verapdf.apps.Installer -options auto-install-options.xml
# /opt/verapdf-installation in PATH aufnehmen oder VERAPDF_BIN setzen
```

### Update

```bash
git pull && npm ci --omit=dev && systemctl restart lektorat
```

## Admin-Konsole

Erreichbar unter `/admin` für User mit `global_role = 'admin'`. Karten:
- **Users** — Rollen, Sperren, Provider-Override pro User.
- **Books** — alle Bücher mit ACL-Einsicht/Übertragung.
- **Registrierungs-Anfragen** — Approval-Queue für `/register`-Selbstanmeldungen.
- **Settings** — KI-Provider + Keys, Google OAuth, App-URL, Modell-Limits, Mailer, Cron, veraPDF-Flavour. Wirkt sofort (kein Restart).
- **Kategorien & Tags** — globaler Pool, Zuordnung pro Buch via ACL.
- **Usage** — Token-Verbrauch pro User/Provider/Job-Typ.

Admin wird über `ADMIN_EMAIL` in `.env` als globale Admin-Rolle gespiegelt (idempotent beim Start). Passwort lebt ausschliesslich in der ENV (timing-safe-equal-Vergleich, Rate-Limit pro IP).

## Backup

Tägliches Online-Backup der SQLite-DB läuft automatisch via systemd-Timer (`schreibwerkstatt-backup.timer`, Default 03:00 lokale Zeit). Nutzt `sqlite3 .backup` (lock-frei, WAL-konsistent), gzip-komprimiert, plus Retention nach `mtime`. Vor jedem Deploy zusätzlich ein Snapshot.

Konfigurierbar via `.env`:

```env
BACKUP_DIR=/opt/schreibwerkstatt/backup
BACKUP_RETENTION_DAYS=30
BACKUP_DB_FILE=/opt/schreibwerkstatt/schreibwerkstatt.db
```

Script: [deploy/backup.sh](deploy/backup.sh). Units: [deploy/schreibwerkstatt-backup.service](deploy/schreibwerkstatt-backup.service), [deploy/schreibwerkstatt-backup.timer](deploy/schreibwerkstatt-backup.timer). Manuell: `systemctl start schreibwerkstatt-backup.service`. Status: `systemctl list-timers schreibwerkstatt-backup`.

Empfehlung: Backup-Ordner zusätzlich offsite spiegeln (rsync nach NAS/S3) – sonst gleicher Datenträger = gleicher Single-Point-of-Failure.

## Prompts anpassen

`prompt-config.json` im Projektroot. Pflichtdatei – Server startet sonst nicht. Änderungen aktiv beim nächsten Serverstart.

Konfigurierbar:
- `locales` – Locale-Map (`de-CH`, `de-DE`, `en-US`, `en-GB`) mit Regeln, Rollen, Stoppwortlisten.
- `buchtypen` – Genre-Typen pro Sprache (`de`, `en`) mit Label und Kontext-Text.
- `erklaerungRule` – globale Fehlerfilter-Regel.
- `defaultLocale` – Fallback ohne Buch-Konfiguration.

Per-Buch in der UI (Bucheinstellungen): Buchtyp und Freitext-Kontext.

## Lokale Entwicklung

`LOCAL_DEV_MODE=true` in `.env` überspringt OAuth, legt Dev-Session an (`dev@local`).

> Niemals in Produktion – Auth-Guard wird komplett deaktiviert.

## Credits

### Plattformen & Modelle

- **[Anthropic Claude](https://www.anthropic.com/)** – KI-Modell (Anthropic Usage Policies; Outputs frei nutzbar)
- **[Ollama](https://ollama.com/)** (MIT) / **[llama.cpp](https://github.com/ggerganov/llama.cpp)** (MIT) / **[LM Studio](https://lmstudio.ai/)** – lokale LLMs (`API_PROVIDER=ollama` oder `llama`)
- **[OpenThesaurus](https://www.openthesaurus.de/)** – Synonyme (Daten unter LGPL/CC-BY-SA; Nutzung via öffentliche API zur Laufzeit, keine Redistribution)
- **[veraPDF](https://verapdf.org/)** – PDF/A-Validierung (GPL-3.0; aufgerufen als externer Prozess)

### Frontend-Libraries (vendored in [public/vendor/](public/vendor/))

- **[Alpine.js](https://alpinejs.dev/)** – Frontend-Framework (MIT)
- **[vis-network](https://visjs.github.io/vis-network/)** – Beziehungsgraph (Apache-2.0 + MIT)
- **[Chart.js](https://www.chartjs.org/)** – Diagramme (MIT)
- **[SortableJS](https://github.com/SortableJS/Sortable)** – Drag&Drop für Buchorganizer (MIT)
- **[jsMind](https://github.com/hizzgdev/jsmind)** – Mindmap-Editor / Figuren-Werkstatt (BSD-3-Clause)

Die Originallizenztexte der vendored Libraries liegen in [public/vendor/LICENSES/](public/vendor/LICENSES/).

### Fonts

- **[Inter](https://rsms.me/inter/)** © Rasmus Andersson – SIL Open Font License 1.1
- **[Source Serif 4](https://github.com/adobe-fonts/source-serif)** © Adobe – SIL Open Font License 1.1

Lokal ausgelieferte Schriftdateien liegen in [public/fonts/](public/fonts/); die zugehörige OFL-Lizenz unter [public/fonts/OFL.txt](public/fonts/OFL.txt).

Der Custom-PDF-Export lädt zur Laufzeit Familien aus **[Google Fonts](https://fonts.google.com/)** (jeweils SIL OFL 1.1 oder Apache-2.0) und bettet sie in die erzeugten PDFs ein. Beide Lizenzen erlauben Embedding ohne Royalty.

### Server-Dependencies

Vollständige Liste in [package.json](package.json) – durchgehend OSI-genehmigte permissive Lizenzen (MIT/Apache-2.0/BSD/ISC). Auswahl: Express, better-sqlite3, pdfkit, sharp, linkedom, jsonrepair, winston, helmet, openid-client, node-cron, xmlbuilder2, epub-gen-memory, @turbodocx/html-to-docx.

## Lizenz

Dieses Projekt steht unter der **GNU Affero General Public License v3.0** (AGPL-3.0) – siehe [LICENSE](LICENSE). Wer den Dienst über ein Netzwerk anbietet, muss den modifizierten Quellcode den Nutzern verfügbar machen (§ 13 AGPL).

Lizenzhinweise zu Drittsoftware:
- Vendored Frontend-Libraries: [public/vendor/LICENSES/](public/vendor/LICENSES/)
- Mitgelieferte Schriften (Inter, Source Serif 4): [public/fonts/OFL.txt](public/fonts/OFL.txt)
