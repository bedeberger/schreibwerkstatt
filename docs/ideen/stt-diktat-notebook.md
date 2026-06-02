# Sprach-Diktat im Notebook-Editor (Self-hosted STT)

- **Status:** Ready <!-- Draft → Ready erst wenn „Offene Fragen" leer -->
- **Aufwand:** M
- **Severity:** medium

## Context

Autor:innen wollen längere Textpassagen sprechen statt tippen — gerade im **Notebook-Editor** (Einzelseiten-Edit-Modus), wo Fliesstext entsteht. Browser-eigene Spracherkennung (Web Speech API) ist nicht self-hosted, schickt Audio an Google/Apple und ist nicht GDPR-tauglich für eine self-hosted-Instanz. Die App hält bereits alle KI-Credentials server-seitig und betreibt mit LanguageTool einen self-hosted Sync-Proxy — Speech-to-Text (STT) reiht sich genau dort ein: ein kurzer Request/Response-Transkriptionscall, **kein** langlaufender KI-Analysejob, **kein** Token-Budget. Self-hosted, vom Betreiber konfigurier- und abschaltbar.

Passt zur App-Philosophie: STT schreibt **nicht generativ** in den Text — es transkribiert ausschliesslich die gesprochene Eingabe der Autor:in (1:1 Diktat, keine KI-Erfindung von Inhalt).

## Scope MVP

- **Nur Notebook-Editor.** Focus-Editor und Bucheditor bleiben unberührt (Phase 2).
- Mikrofon-Button in der Notebook-Toolbar, **nur sichtbar wenn** `sttEnabled` (Admin hat STT aktiviert + Host gesetzt).
- **VAD-Segment-Streaming**: kontinuierliche `MediaRecorder`-Aufnahme; browserseitige Sprechpausen-Erkennung (WebAudio-RMS-Schwelle) schneidet an Satz-/Halbsatz-Grenzen ab. Jedes abgeschlossene Segment geht an den Proxy; der zurückkommende Text wird **am Cursor** eingefügt, während schon das nächste Segment aufgenommen wird. **VAD-Schwellen sind über `app_settings` (`stt.vad.*`) konfigurierbar** und kommen über `/config` ins Frontend.
- **Sprache aus Buch-Locale:** Transkriptionssprache = `getBookLocale(bookId)` (SSoT, konsistent mit LanguageTool); `stt.language` nur Fallback ohne Buchscope.
- Backend: Sync-Proxy `POST /stt/transcribe` → leitet das Audiosegment an einen **OpenAI-kompatiblen Whisper-Endpunkt** (`${host}/v1/audio/transcriptions`) weiter. Credentials/Host verlassen den Server nie.
- **Whisper-kompatibles Audio:** Browser nimmt im besten verfügbaren `MediaRecorder`-Format auf (Präferenz `audio/webm;codecs=opus`, Fallback `audio/mp4`/`audio/ogg`); der Proxy reicht das Segment mit korrekter Datei-Extension + Content-Type weiter, sodass der ffmpeg-basierte Whisper-Endpunkt es dekodiert.
- Admin-Konfiguration über neuen Tab im Admin-Settings-Partial: enabled-Toggle, Host, Model, API-Key (encrypted), Fallback-Sprache, VAD-Schwellen. Test-Button (Health-Probe).
- Aktivieren/Deaktivieren rein über `stt.enabled` — aus ⇒ Button verschwindet, Proxy antwortet `404 { error: 'stt_disabled' }`.

## Out-of-Scope

- **Echtes WebSocket-Token-Streaming** (WhisperLive/Wyoming). OpenAI-kompatible Endpunkte sind Batch; das VAD-Segment-Streaming liefert die Live-Anmutung ohne Streaming-Protokoll. Echtes Streaming = Phase 2 als zweiter Provider-Typ.
- STT im **Focus-Editor** und **Bucheditor** (Phase 2 — dann jeweils eigener Toolbar-Hook + Pflicht-Invarianten-Check der jeweiligen Doku).
- STT auf Form-Feldern (Titel, Notizen).
- Sprach-Befehle/Kommandos ("neuer Absatz", "Komma") — MVP fügt reinen Transkript-Text ein. Interpunktion liefert das Whisper-Modell selbst.
- Mehrere STT-Provider-Typen gleichzeitig (nur OpenAI-kompatibel).
- Server-seitige Speicherung von Audio (Audio ist flüchtig, wird nur durchgereicht).

## Done when

- Admin kann unter Settings einen OpenAI-kompatiblen Whisper-Host eintragen, testen (Test-Button zeigt ok/latenz) und STT aktivieren.
- Bei `stt.enabled=false` ist der Mic-Button im Notebook-Editor nicht vorhanden und `/stt/transcribe` liefert 404.
- Bei aktivem STT: Mic-Button starten → sprechen → an Sprechpausen erscheint Transkript-Text am Cursor → erneut klicken stoppt die Aufnahme.
- Eingefügter Text durchläuft den normalen Notebook-Save-/Block-ID-Chokepoint (Autosave, `data-bid`, Stale-Write-Schutz) unverändert.
- Kein Audio wird server-seitig persistiert; Host/API-Key gelangen nie ins Frontend (`/config` liefert nur `enabled`/`provider`/`language`).
- Mic-Permission-Verweigerung wird sauber abgefangen (i18n-Hinweis, kein Crash).

## Hard-Rule-Audit

- **Editor-Spezifikation:** betroffen. **Nur Notebook-Editor** (`public/js/editor/notebook/`, `.page-content-view--editing`). Im Diff explizit auf Notebook beschränkt; Focus/Bucheditor unberührt. Pflicht-Invarianten Notebook-Editor (Autosave Idle 60s/Max 120s, Draft-Pipeline, Stale-Write, `data-bid`) bleiben gültig — STT-Insert ist nur eine weitere Quelle für DOM-Mutation am contenteditable, danach greift der bestehende Save-Pfad.
- **KI-Calls nur via Job-Queue:** Ausnahme analog LanguageTool — STT ist kurzer Sync-Proxy, kein KI-Analysejob, kein Token-Budget, kein `callAI`. Im Proxy-Header dokumentieren (wie `routes/languagetool.js`).
- **`callAI` gibt nur JSON zurück:** n/a — STT nutzt nicht `callAI`/`lib/ai.js`, sondern einen eigenen Fetch an `/v1/audio/transcriptions`.
- **Prompts nur unter `public/js/prompts/`:** n/a — STT hat keinen Prompt.
- **Styles nur in `public/css/`:** betroffen. Mic-Button-State (idle/recording/pending) als CSS-Klassen in der bestehenden Toolbar-CSS-Datei (`public/css/editor/`), kein Inline-Style. Recording-Puls via CSS-Animation. Bei neuer Datei: `index.html`-Link + `SHELL_CACHE`-Bump + DESIGN.md-Inventar.
- **UI-Strings nur in i18n:** betroffen. Neue Keys `stt.*` (Button-Tooltip, Recording-Status, Permission-Fehler, Disabled-Hinweis) + Admin-Keys `admin.settings.stt.*` in **beiden** Locales. Server-Fehler (`stt_disabled` etc.) als i18n-Marker, wo User-sichtbar.
- **Content-Store-Facade:** n/a — STT schreibt keinen Buchinhalt direkt; eingefügter Text läuft über den normalen Page-Save-Pfad (Content-Store).
- **DB-Integrität / Migration:** n/a — keine neue Tabelle. Config lebt in `app_settings` (Key-Value), kein neues Schema.
- **`x-html` nur escaped:** betroffen, falls Recording-Status/Transkript-Preview via `x-html`. Transkript-Text **immer** durch `escHtml()` vor Interpolation — bzw. via DOM-`createTextNode`/`range.insertNode` einfügen (keine HTML-Interpretation des Whisper-Outputs).
- **LanguageTool auf Prosafeldern:** n/a für den Mic-Button selbst; der eingefügte Text wird vom bestehenden Notebook-Spellcheck-Dispatcher ohnehin geprüft.
- **Combobox statt `<select>` / numInput:** betroffen im Admin-UI — Fallback-Sprache via `combobox`, kein nacktes `<select>`; VAD-Schwellen (silence_ms/threshold/max_segment_s) via `numInput` (kein `<input type=number>`). Ranges deckungsgleich mit den `VALIDATORS` in `lib/app-settings.js`.
- **DB-Timestamps ISO+Z:** n/a — keine `*_at`-Spalten.
- **Logging-Context `book`:** betroffen. `/stt/transcribe` bekommt `bookId` im Body → nach `toIntId` `setContext({ book })` (wie LanguageTool-Proxy).
- **SHELL_CACHE bumpen:** ja, bei JS/CSS-Änderungen.

## Abhängigkeiten

- `lib/app-settings.js` (DEFAULTS/VALIDATORS/ENCRYPTED_KEYS) — neue `stt.*`-Keys.
- `db/schema.js` `getBookLocale(bookId, userEmail)` — Sprach-SSoT (wie LanguageTool-Proxy).
- `routes/proxies.js` `/config` — liefert `stt`-Block (ohne Secrets).
- `routes/admin-settings.js` — Test-Endpunkt; `public/partials/admin-settings.html` + `public/js/admin/admin-settings.js` — Admin-Tab.
- Notebook-Toolbar: `public/js/editor/notebook/toolbar.js` (Insert-/Caret-Mechanik) + `public/js/cards/editor-toolbar-card.js`.
- App-State/Config-Load: `public/js/app/app-state.js`, `public/js/app.js`.
- Self-hosted Backend (Betreiber): Speaches / faster-whisper-server / whisper.cpp im Server-Mode mit `/v1/audio/transcriptions`.

## Backend

**`routes/stt.js`** (neuer Sync-Proxy-Router, Muster: `routes/languagetool.js`)

- `POST /stt/transcribe` — Multipart/Form-Data (Audio-Blob).
  - Guard: `appSettings.get('stt.enabled') === true` **und** `stt.host` gesetzt; sonst `404 { error: 'stt_disabled' }`.
  - `bookId` (optional) aus dem Request → `toIntId` → `setContext({ book })`.
  - **Sprache:** `bookId` vorhanden → `getBookLocale(bookId, userEmail)` gewinnt (SSoT, exakt wie `routes/languagetool.js:50-59`); sonst `stt.language` als Fallback.
  - **Audio-Format/Whisper-Kompatibilität:** Datei-Extension + Content-Type aus dem hochgeladenen Mime ableiten (`audio/webm`→`.webm`, `audio/mp4`→`.m4a`, `audio/ogg`→`.ogg`, `audio/wav`→`.wav`) und beim Forward 1:1 mitgeben — der OpenAI-kompatible Whisper-Endpunkt dekodiert via ffmpeg/libav. Mime-Whitelist gegen Fremdformate; unbekannt → `415 { error: 'stt_unsupported_audio' }`.
  - Audio-Cap (Segment-Grösse begrenzt, z. B. ≤ 5 MB — kurze Segmente bei VAD).
  - Forward an `${stt.host}/v1/audio/transcriptions` als Multipart (`file` mit korrekter Extension, `model`, `language`), optional `Authorization: Bearer ${stt.api_key}`.
  - Upstream-Timeout (z. B. 15 s) via `AbortController`; Abbruch → `408 { error: 'stt_timeout' }`, Upstream-Fehler → `502 { error: 'stt_upstream' }`.
  - Antwort: `{ text }` (verbatim Whisper-Transkript), kein Audio-Echo.
- Mount in `server.js` hinter dem Auth-Guard (wie alle Nicht-`/auth`-Routen).

**`routes/admin-settings.js`**

- `POST /admin/settings/test-stt` — Health-Probe: `GET ${stt.host}/v1/models` mit optionalem Bearer; `{ ok, status, latency_ms, enabled }` (Muster `test-provider` openai-compat-Branch).

**`routes/proxies.js`** (`/config`)

- Block ergänzen: `stt: { enabled: stt.enabled && !!stt.host, provider: 'openai-compat', vad: { silenceMs, threshold, maxSegmentS } }`. **Keine** Host/Key/Model/Language-Felder — Sprache löst der Server pro Request aus der Buch-Locale auf, nicht das Frontend. Die VAD-Schwellen müssen ins Frontend (VAD läuft im Browser).

**`lib/app-settings.js`**

- `DEFAULTS`: `stt.enabled=false`, `stt.host=''`, `stt.model=''` (z. B. `Systran/faster-whisper-large-v3`), `stt.language='de'` (Fallback ohne Buchscope), `stt.vad.silence_ms=800`, `stt.vad.threshold=0.015`, `stt.vad.max_segment_s=30`.
- `ENCRYPTED_KEYS`: `stt.api_key`.
- `VALIDATORS`: `stt.vad.silence_ms` (int, 200–5000), `stt.vad.threshold` (number, 0–1), `stt.vad.max_segment_s` (int, 5–120). `stt.language`/`stt.host`/`stt.model` als freie Strings (kein Validator — „leer = aus" valider Zustand).
- ENV_MAP: optional Bootstrap-Keys (z. B. `STT_HOST`), falls gewünscht — sonst rein DB-konfiguriert.

## Frontend

**Mic-Toggle-Icon in der Notebook-Icon-Bar (kein neues Karten-Recipe — kein Hauptkarten-Toggle):**

- Button in der persistenten Icon-Bar `.page-editor-toolbar` ([public/partials/editor-notebook.html:195](public/partials/editor-notebook.html#L195)), als letzter Eintrag hinter `action-sep` — **gleiches Markup wie der Entity-Toggle daneben** (Zeile 261): `<button type="button" class="graph-tool-btn" :aria-pressed="sttRecording" :data-tip="sttRecording ? t('stt.stop') : t('stt.dictate')" :aria-label="…" @click="toggleSttDictation()">` mit `<svg class="icon"><use href="/icons.svg?v=NNN#mic"/></svg>`.
- **Sichtbarkeit:** `x-show="sttEnabled"` direkt am Button (`.page-editor-toolbar` läuft im **Root-Scope** `lektorat`, nicht in `editorToolbarCard` — `sttEnabled` ist Root-State, kein `$app.`-Prefix nötig). Bei `stt.enabled=false` ist der Button nicht im DOM-Flow.
- **Scope-Korrektur:** Weil die Icon-Bar Root-Methoden ruft (`notebookUndo`, `toggleEntitiesEnabledForCurrentBook`), werden die Diktat-Methoden in den **Root** gespreaded (wie die übrigen `public/js/editor/`-Module), **nicht** in `editor-toolbar-card`.
- Neues Modul `public/js/editor/notebook/stt-dictation.js` → `export const sttDictationMethods = { … }`, im Root-`Alpine.data('lektorat')`-Aufbau gespreaded; Pure-Compute-Teile als `_computeXxx` testbar halten:
  - `toggleSttDictation()`: idle → `getUserMedia({ audio })` + `MediaRecorder` + WebAudio-`AnalyserNode` (RMS-VAD) starten; recording → stoppen.
  - VAD-Logik: sinkt RMS unter `sttVad.threshold` für `sttVad.silenceMs` → Segment finalisieren → an `/stt/transcribe` POSTen → Text bei Erfolg am Cursor einfügen. `sttVad.maxSegmentS` erzwingt Cut bei Dauer-Sprechen. Schwellen aus `/config`, keine Hardcodes.
  - `MediaRecorder`-Mime via `MediaRecorder.isTypeSupported` (Präferenz `audio/webm;codecs=opus`, Fallback `audio/mp4`/`audio/ogg`); Blob mit Mime + passender Extension hochladen.
  - Insert über die bestehende Caret-/`range`-Mechanik (`range.insertNode(document.createTextNode(text))`), danach Save-Pipeline-Trigger wie bei manueller Eingabe (`_markEditDirty()`/`input`-Event).
  - Stop gibt Mic frei (`track.stop()`), räumt AudioContext ab (Leak-Freiheit — analog Focus-Editor-Cleanup-Tests). `book:changed`/`view:reset`/Edit-Modus-Verlassen stoppen die Aufnahme.
- State in `app-state.js` (Root): `sttEnabled`, `sttVad` (`{ silenceMs, threshold, maxSegmentS }`, beide aus `/config`), `sttRecording`, `sttPending` (kurzlebiger UI-State, als Re-Entry-Guard dokumentiert). Sprache wird **nicht** im Frontend gehalten — der Proxy löst sie aus der Buch-Locale.
- Config-Load in `app.js`: `this.sttEnabled = !!cfg.stt?.enabled`; `this.sttVad = cfg.stt?.vad || { … defaults }`.
- **Icon-Sprite:** `mic`-Symbol (Lucide) in [public/icons.svg](public/icons.svg) ergänzen; Sprite-Cache-Bust `?v=689` → `?v=690` in allen ~24 referenzierenden Dateien hochziehen.

**Admin-UI:** neuer Tab/Block in `public/partials/admin-settings.html` (Muster openai-compat-Block: enabled-Checkbox, Host-URL, Model-Text, API-Key-Password mit Masking, Fallback-Sprache-combobox, VAD-Felder via `numInput` (silence_ms/threshold/max_segment_s), Test-Button → `adminSettingsTest('stt')`). Save/Diff/Encrypted-Coercion läuft über das bestehende `admin-settings.js`-Gerüst.

## CSS

- Button erbt das bestehende `.graph-tool-btn`-Pattern (gleiche Icon-Bar, kein neuer Button-Typ). Nur der **Recording-State** braucht eigene CSS: Puls/Akzent via Keyframe in der Datei der `.page-editor-toolbar`-Styles (`public/css/editor/`), getriggert über `[aria-pressed="true"]`. Kein `x-transition`. Keine neue CSS-Datei nötig (also kein zusätzlicher `index.html`-Link); `SHELL_CACHE`-Bump trotzdem Pflicht. Mobile-Verhalten erbt die Icon-Bar.

## i18n

- `stt.dictate` (Button-Tooltip „Diktat starten/stoppen"), `stt.recording`, `stt.listening`, `stt.transcribing`, `stt.error.permission`, `stt.error.unavailable`, `stt.error.failed`.
- `admin.settings.stt.title`, `.enabled`, `.host`, `.model`, `.apiKey`, `.language`, `.vadSilenceMs`, `.vadThreshold`, `.vadMaxSegmentS`, `.test`, `.testOk`, `.testFail`.
- Beide Locales (de = Fallback, en = Übersetzung) im selben Commit. Server-`stt_disabled` ist intern (kein User-Text) — Frontend behandelt 404 als „Feature aus".

## DB

n/a — Config rein in `app_settings` (Key-Value, keine neue Tabelle). Kein Audio persistiert. Keine Migration, kein ERD-Update.

## Security

- Auth-Scope: `/stt/transcribe` hinter Session-Guard (wie alle Nicht-`/auth`-Routen).
- Host/API-Key bleiben server-seitig (`ENCRYPTED_KEYS`); `/config` liefert sie nicht aus.
- Audio wird nur durchgereicht, nie gespeichert, nicht geloggt (nur Metadaten: Segmentgrösse, Latenz, Upstream-Status — kein Transkript-Inhalt in Logs).
- Transkript-Text als reiner Text in den DOM (`createTextNode`/`range.insertNode`) — keine HTML-Interpretation, kein `x-html`-Sink ohne `escHtml`.
- Segment-Grössen-Cap gegen Memory-/Bandbreiten-Missbrauch. Optional Rate-Limit (Betreiber-Sache, self-hosted — analog README).
- Mic-Permission: Browser-Consent zwingend; kein Auto-Start.

## Telemetrie

n/a für MVP. Optional Phase 2: Counter „STT-Segmente/-Sekunden" für `/metrics` (analog merge_telemetry) — bewusst weggelassen, kein Audio-/Inhaltsleak.

## Reversibilität

- Komplett abschaltbar über `stt.enabled=false` (Default) — Button verschwindet, Proxy 404. Kein Daten-Rückbau nötig (keine STT-Tabellen, kein persistiertes Audio).
- Ausbau = Router-Mount + Toolbar-Modul + Admin-Block + `stt.*`-Keys entfernen; keine Migration rückabzuwickeln.

## Tests

- **Unit:** VAD-Segmentierungs-Logik als pure `_computeXxx` (RMS-Schwelle, Segment-Boundary-Entscheidung) ohne Browser. Config-Delivery (`/config` enthält `stt.enabled`, **nicht** Host/Key). app-settings DEFAULTS/ENCRYPTED_KEYS für `stt.*`.
- **Integration:** `/stt/transcribe` gegen Mock-Whisper-Endpunkt — disabled→404, enabled→Forward+`{text}`, Upstream-Fehler→502, Timeout→408. Secret bleibt server-seitig.
- **E2E (Notebook):** Button nur bei `sttEnabled` sichtbar; Mock-`getUserMedia`/`MediaRecorder` → Segment → eingefügter Text landet am Cursor und triggert Autosave; Stop gibt Mic frei (Leak-/Cleanup-Check analog Focus-Editor-Tests). Permission-Denial → i18n-Fehler, kein Crash.

## Edge-Cases

- **Mic-Permission verweigert / kein Gerät:** i18n-Hinweis, Button zurück in idle, kein Crash.
- **Upstream langsam/down:** Segment-Fehler isoliert behandeln (eine fehlgeschlagene Transkription stoppt nicht die ganze Session); User-Hinweis bei wiederholtem Fehler.
- **Sehr langes Sprechen ohne Pause:** Max-Segmentlänge erzwingt einen Cut (gegen unbegrenzte Audio-Akkumulation/Grössen-Cap).
- **Cursor verlässt das contenteditable / User wechselt Seite während Recording:** Aufnahme stoppen, Mic freigeben (Karten-`destroy`/`book:changed`/`view:reset`-Events abonnieren).
- **Stale-Write während Diktat:** eingefügter Text läuft durch den bestehenden Notebook-Stale-Write-/Block-Merge-Pfad — kein Sonderfall.
- **Leerer/Whitespace-Transkript** (Stille-Segment): nichts einfügen.
- **Konflikt mit aktivem LanguageTool-Spellcheck:** kein Sonderfall — eingefügter Text wird wie Tipp-Eingabe vom Dispatcher geprüft.

## Kritische Dateien

- **Modify:**
  - `lib/app-settings.js` (DEFAULTS, ENCRYPTED_KEYS, ggf. VALIDATORS/ENV_MAP)
  - `routes/proxies.js` (`/config` → `stt`-Block)
  - `routes/admin-settings.js` (`/test-stt`)
  - `server.js` (Mount `routes/stt.js`)
  - `public/partials/admin-settings.html` (STT-Tab)
  - `public/js/admin/admin-settings.js` (falls Tab-/Test-Verdrahtung nötig)
  - `public/partials/editor-notebook.html` (Mic-Toggle-Button in `.page-editor-toolbar`)
  - `public/icons.svg` (`mic`-Symbol) + `?v=689`→`?v=690`-Bump in den referenzierenden Dateien
  - `public/js/app.js` (Spread `sttDictationMethods` in den Root + Config-Load)
  - `public/js/editor/notebook/toolbar.js` (Insert-/Caret-Helfer ggf. wiederverwenden/exportieren)
  - `public/js/app/app-state.js` (`sttEnabled`/`sttVad`/`sttRecording`/`sttPending`)
  - `public/js/app.js` (Config-Load)
  - `public/js/i18n/de.json`, `public/js/i18n/en.json`
  - `public/css/editor/<toolbar>.css` (Mic-Button-States)
  - `public/sw.js` (`SHELL_CACHE`-Bump)
  - `DESIGN.md` (Mic-Button-Pattern, falls neu)
  - `CLAUDE.md` (LanguageTool-Doku-Zeile um STT als zweite Sync-Proxy-Ausnahme ergänzen) + ggf. neue Spickzettel-Doku
- **Create:**
  - `routes/stt.js`
  - `public/js/editor/notebook/stt-dictation.js` (`sttDictationMethods`, Root-Spread)
  - `tests/unit/stt-vad.test.mjs`, `tests/integration/stt-proxy.test.js`, `tests/e2e/stt-dictation.spec.js`
  - ggf. `docs/stt.md` (Spickzettel)

## Offene Fragen

_Keine — entschieden:_

- **VAD-Schwellen:** konfigurierbar als `stt.vad.silence_ms` / `stt.vad.threshold` / `stt.vad.max_segment_s` in `app_settings`, ans Frontend via `/config`.
- **Sprache:** aus Buch-Locale (`getBookLocale`, SSoT wie LanguageTool); `stt.language` nur Fallback ohne Buchscope.
- **Audio-Format:** `MediaRecorder` wählt das beste unterstützte Format (`audio/webm;codecs=opus` bevorzugt); Proxy reicht es mit korrekter Extension/Content-Type an den ffmpeg-basierten Whisper-Endpunkt weiter. Mime-Whitelist, unbekannt → 415.
