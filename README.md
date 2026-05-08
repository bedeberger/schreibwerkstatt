# bookstack-lektorat

KI-gestütztes Lektorat-Tool für [BookStack](https://www.bookstackapp.com/). Eigenständiger Node.js-Service, der sich per BookStack-API anbindet.

## Features

- **Seitenlektorat** – Rechtschreib-, Grammatik- und Stilprüfung mit selektiver Korrekturübernahme.
- **Bearbeitungsmodus** – Seiten direkt bearbeiten und nach BookStack zurückspeichern. Auto-Save alle 30 s, lokaler Draft (localStorage), Offline-Modus mit Retry.
- **Fokusmodus** (F11) – Vollbild, Typewriter-Scroll, Absatz-Hervorhebung. Auto-Save, Schreibzeit-Tracking, Mobile-/IME-Support.
- **Synonym-Finder** – Wort markieren → Rechtsklick → Vorschläge aus [OpenThesaurus](https://www.openthesaurus.de/) + KI mit Satzkontext.
- **Seiten-Chat** – KI-Dialog zu einer Seite. Änderungsvorschläge übernehmbar.
- **Buch-Chat** – KI-Dialog über das ganze Buch mit Werkzeugen (Pronomen-Zählung, Figurenverteilung, Volltextsuche, Seitenabruf) auf vorberechnetem Index.
- **Buchbewertung / Kapitelbewertung** – Stärken, Schwächen, Empfehlungen.
- **Figurenübersicht** – Charakterextraktion mit Beziehungsgraph; Figurenkontext auch im Lektorat einblendbar.
- **Ereignisse / Schauplätze / Szenen** – Übersichten pro Kapitel.
- **Kontinuitätsprüfer** – Findet Widersprüche.
- **Stil-Heatmap** – Satzlänge, Adverbien, Füllwörter, Wiederholungen pro Kapitel.
- **Fehler-Heatmap** – Befunde aller Lektorats-Läufe nach Kapitel und Fehlertyp.
- **Lektorat-Verlauf** – Frühere Korrekturen als Inline-Highlights, selektiv nachträglich übernehmbar.
- **Buchstatistik** – Tägliche Snapshots (Wörter, Tokens) als Zeitliniendiagramm.
- **Fine-Tuning-Export** – JSONL-Trainingsdaten (Stil, Szenen, Dialoge, Q&A, Korrekturen). Anleitung: [docs/finetuning.md](docs/finetuning.md).
- **WordPress-Import** – One-Shot-Import einer WP-Site aus mysqldump-Datei in ein BookStack-Buch (Categories → Chapter, älteste Posts zuerst). Anleitung: [docs/wordpress-import.md](docs/wordpress-import.md).
- **Custom-PDF-Export** – Eigener Renderer (pdfkit) mit konfigurierbarem Layout, Schriften aus Google Fonts (runtime download, 30-Tage-Cache), Cover-Bild (sharp-konvertiert), Kapitelumbrüche, Inhaltsverzeichnis und PDF/A-2B-Konformität. Mehrere Profile pro Buch+User. Optional Server-Validierung via veraPDF (separat installieren, siehe unten).
- **Bucheinstellungen** – Sprache, Buchtyp, Erzählperspektive, Erzählzeit, Freitext-Kontext fliessen in alle Prompts.
- **Theme** – Hell/Dunkel/Auto.
- **Session-Banner** – Bei `401` ohne Hard-Redirect; ungespeicherte Inhalte bleiben erreichbar.

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
- **[Chart.js](https://www.chartjs.org/)** – Diagramme
