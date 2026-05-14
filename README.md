# bookstack-lektorat

KI-gestütztes Lektorat-Tool für [BookStack](https://www.bookstackapp.com/). Eigenständiger Node.js-Service, der sich per BookStack-API anbindet.

## Features

- **Seitenlektorat** – Rechtschreib-, Grammatik- und Stilprüfung mit selektiver Korrekturübernahme.
- **Bearbeitungsmodus** – Seiten direkt bearbeiten und nach BookStack zurückspeichern. Auto-Save alle 30 s, lokaler Draft (localStorage), Offline-Modus mit Retry.
- **Fokusmodus** (Cmd/Ctrl+Shift+E) – Vollbild, Typewriter-Scroll, Absatz-Hervorhebung. Auto-Save, Schreibzeit-Tracking, Live-Zeichen-/Wortzähler, Mobile-/IME-Support.
- **Bucheditor** – Ganzes Buch als scrollbarer Stream mit Kapitel-Trennern und Inhaltsverzeichnis-Outline. Inline-Edit pro Seite, dirty/saving/conflict-Status je Block, Save-All sequenziell, Konflikterkennung (Server-Version vs. eigene). Buchweite Suche & Ersetzen (Case/Whole-Word, Treffer-Navigation, Replace-All) über alle Seiten hinweg.
- **Synonym-Finder** – Wort markieren → Rechtsklick → Vorschläge aus [OpenThesaurus](https://www.openthesaurus.de/) + KI mit Satzkontext.
- **Seiten-Chat** – KI-Dialog zu einer Seite. Änderungsvorschläge übernehmbar.
- **Buch-Chat** – KI-Dialog über das ganze Buch mit Werkzeugen (Pronomen-Zählung, Figurenverteilung, Volltextsuche, Seitenabruf) auf vorberechnetem Index.
- **Buch-Übersicht** – Dashboard pro Buch: Snapshot, Zeichen-Trend (30 Tage), Schreib-pro-Tag-Heatmap, Lektorat-Abdeckung, Top-Fehlertypen, Kapitel-Qualität, Figuren-/Orts-Präsenz, letzte Seiten, Status „abgeschlossen".
- **Buchorganizer** – Kapitel & Seiten per Drag&Drop ordnen, neue Kapitel/Seiten anlegen, umbenennen, löschen. Sidebar-Tree zeigt Seitenanzahl pro Kapitel.
- **Buchbewertung / Kapitelbewertung** – Stärken, Schwächen, Empfehlungen.
- **Figurenübersicht** – Charakterextraktion mit Beziehungsgraph (Vollbild-Modus); Figurenkontext auch im Lektorat einblendbar.
- **Figuren-Werkstatt** – Vorwärts-Entwicklung von Figuren als jsMind-Mindmap (Steckbrief, Stimme, Subtext, eigene Aspekte). Import bestehender Buchfiguren mit vorgefülltem Baum, KI-Brainstorm pro Knoten (3–7 Sub-Ideen, vor doppelt mit anderen Buchfiguren geschützt) und Konsistenz-Check gegen Buchwelt mit Severity-Skala. Lauf-Historie pro Figur. Anleitung: [docs/figur-werkstatt.md](docs/figur-werkstatt.md).
- **Ereignisse / Schauplätze / Szenen** – Übersichten pro Kapitel.
- **Kontinuitätsprüfer** – Findet Widersprüche.
- **Stil-Heatmap** – Satzlänge, Adverbien, Füllwörter, Wiederholungen pro Kapitel.
- **Fehler-Heatmap** – Befunde aller Lektorats-Läufe nach Kapitel und Fehlertyp.
- **Lektorat-Verlauf** – Frühere Korrekturen als Inline-Highlights, selektiv nachträglich übernehmbar. Lektoratszeit pro Lauf wird mitgemessen.
- **Buchstatistik** – Tägliche Snapshots (Zeichen, Wörter, Tokens) als Zeitliniendiagramm.
- **Ideen-Sammlung** – Notiz-Sammelbox pro Buch oder Seite.
- **Command-Palette** (Cmd/Ctrl+K bzw. `/`) – Fuzzy-Suche über Karten, Aktionen, Seiten, Kapitel, Figuren, Orte, Szenen. Prefix-Modi: `>` Befehle, `#` Seiten, `!` Kapitel, `@` Figuren, `$` Orte, `%` Szenen.
- **Fine-Tuning-Export** – JSONL-Trainingsdaten (Stil, Szenen, Dialoge, Q&A, Korrekturen). Anleitung: [docs/finetuning.md](docs/finetuning.md).
- **WordPress-Import** – One-Shot-Import einer WP-Site aus mysqldump-Datei in ein BookStack-Buch (Categories → Chapter, älteste Posts zuerst nach Jahrgang). Anleitung: [docs/wordpress-import.md](docs/wordpress-import.md).
- **Buch-Export** – BookStack-Native-Formate (PDF, HTML, Markdown, Plaintext, EPUB) mit Timestamp-Filename.
- **Custom-PDF-Export** – Eigener Renderer (pdfkit) mit druckfertiger PDF/A-2B-Konformität. Konfigurierbares Layout (Seitenformat, Ränder, Kapitelumbrüche), freie Schriftwahl aus Google Fonts (runtime download, 30-Tage-Cache), Cover-Bild, Inhaltsverzeichnis, mehrere Profile pro Buch+User. Optional Server-Validierung via veraPDF (separat installieren, siehe unten).
- **Bucheinstellungen** – Sprache, Buchtyp, Erzählperspektive, Erzählzeit, Freitext-Kontext fliessen in alle Prompts.
- **Theme** – Hell/Dunkel/Auto, Sprachumschaltung Deutsch/Englisch.

## Voraussetzungen

- Öffentliche HTTPS-URL (Reverse-Proxy mit TLS).
- Google OAuth2 Credentials, Callback `https://<domain>/auth/callback`.

## Quick Start (LXC / Bare Metal)

Node.js v20+:

```bash
git clone https://github.com/<user>/bookstack-lektorat.git
cd bookstack-lektorat
cp .env.example .env
# Pflichtfelder setzen, alle Variablen sind in .env.example dokumentiert
npm ci --omit=dev
node server.js    # Port 3737
```

Produktiv: systemd-Service via [lektorat.service](lektorat.service) (User/WorkingDirectory anpassen, dann `systemctl enable --now lektorat`).

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

## BookStack-Token

Nach erstem Login:

1. BookStack: **Profil → API-Tokens → Token erstellen**
2. Token-ID und Secret in das Formular eintragen.

Jeder Nutzer hinterlegt seinen eigenen Token.

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

## BookStack-Templates

[`themes/custom/`](themes/custom/) enthält ein BookStack-Theme mit angepasstem PDF-Export (B5, Playfair Display / EB Garamond, Inhaltsverzeichnis, laufende Kopfzeilen) und einem Block-Format „Gedicht" (TinyMCE + Lexical).

Installation: [docs/bookstack-templates.md](docs/bookstack-templates.md).

## Credits

- **[BookStack](https://www.bookstackapp.com/)** – Wiki-Plattform
- **[Anthropic Claude](https://www.anthropic.com/)** – KI-Modell
- **[Ollama](https://ollama.com/)** / **[llama.cpp](https://github.com/ggerganov/llama.cpp)** / **[LM Studio](https://lmstudio.ai/)** – lokale LLMs (`API_PROVIDER=ollama` oder `llama`)
- **[OpenThesaurus](https://www.openthesaurus.de/)** – Synonyme
- **[Alpine.js](https://alpinejs.dev/)** – Frontend-Framework
- **[vis-network](https://visjs.github.io/vis-network/)** – Beziehungsgraph
- **[jsMind](https://github.com/hizzgdev/jsmind)** – Mindmap-Editor (Figuren-Werkstatt)
- **[Chart.js](https://www.chartjs.org/)** – Diagramme
