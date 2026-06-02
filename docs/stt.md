# STT-Diktat (Speech-to-Text, self-hosted)

Sprach-Diktat im **Notebook-Editor** (Einzelseiten-Edit-Modus). Self-hosted, vom Betreiber konfigurier- und abschaltbar. Zweite **Sync-Proxy-Ausnahme** zur Job-Queue-Regel (analog [docs/languagetool.md](languagetool.md)): kurzer Request/Response-Transkriptionscall, **kein** KI-Analysejob, kein Token-Budget, kein `callAI`. STT transkribiert 1:1 — keine generative KI.

## Datenfluss

```
Notebook-Toolbar Mic-Button (Root-Scope) → MediaRecorder + WebAudio-RMS-VAD
  → an Sprechpause: Segment-Blob → POST /stt/transcribe?bookId=…
    → Proxy forwarded an ${stt.host}/v1/audio/transcriptions (OpenAI-kompatibel)
      → { text } → verbatim am Cursor eingefügt (createTextNode/range)
        → normaler Notebook-Save-/Block-ID-Chokepoint (Autosave, data-bid, Stale-Write)
```

## Backend

- **[routes/stt.js](../routes/stt.js)** — `POST /stt/transcribe`. Audio als rohes Binary (`express.raw`, kein multer), 5 MB Cap. Guard: `stt.enabled` + `stt.host` → sonst `404 stt_disabled`. Mime-Whitelist (webm/ogg/m4a/wav/mp3) → korrekte Datei-Extension fuer den ffmpeg-basierten Whisper-Endpunkt; unbekannt → `415`. Forward via `FormData`/`Blob`, optional `Authorization: Bearer`. Timeout 15 s → `408`, Upstream-Fehler → `502`. Audio nie persistiert, nie geloggt (nur Metadaten).
- **Sprache:** Buch-Locale gewinnt (`getBookLocale`, SSoT wie LanguageTool); `de-CH` → `de` gekuerzt. `stt.language` nur Fallback ohne Buchscope.
- **[routes/admin-settings.js](../routes/admin-settings.js)** — `POST /admin/settings/test-stt` (Health-Probe `GET /v1/models`).
- **[routes/proxies.js](../routes/proxies.js)** `/config` — liefert `stt: { enabled, provider, vad: { silenceMs, threshold, maxSegmentS } }`. **Kein** Host/Key/Model/Language (Secret-Leck-Schutz; Sprache loest der Proxy serverseitig auf).
- **[lib/app-settings.js](../lib/app-settings.js)** — Keys: `stt.enabled`, `stt.host`, `stt.model`, `stt.language` (Fallback), `stt.api_key` (`ENCRYPTED_KEYS`), `stt.vad.silence_ms` (200–5000), `stt.vad.threshold` (0–1), `stt.vad.max_segment_s` (5–120). VALIDATORS-Ranges deckungsgleich mit den `numInput`-Limits im Admin-UI.

## Frontend

- **[public/js/editor/notebook/stt-dictation.js](../public/js/editor/notebook/stt-dictation.js)** — `sttDictationMethods`, in den **Root** gespreaded (die `.page-editor-toolbar` laeuft im Root-Scope `lektorat`, nicht in `editorToolbarCard`). Pure-Compute (`_computeRms`/`_computeVadCut`/`_computeSttMime`/`_computeSpacedInsert`) testbar ohne Browser. Segmentierung via MediaRecorder-**Stop/Start-Zyklus** (stop() liefert standalone-dekodierbares Segment; blosses Slicen ergaebe headerlose Fragmente).
- **Einfüge-Anker (bewusster Caret vs. Editorende):** `_sttStart` entscheidet beim Aufnahmestart — hat der User bewusst per Klick einen Caret im Edit-Feld gesetzt (`sttCaretUserSet`, in [figur-lookup.js](../public/js/editor/figur-lookup.js)#`_onEditClick`) **und** steht dieser noch im Editor (`_sttCaretInEditor`), wird dort eingefuegt (nur Scroll dorthin); sonst — blosser Mic-Klick ohne Caret-Platzierung — `_sttAnchorToEnd()` (Caret ans Editorende + Scroll). Folgesegmente haengen am vorrueckenden Caret weiter an. `sttCaretUserSet` wird in `startEdit` (Auto-Fokus-Caret zaehlt nicht) und bei `book:changed`/`view:reset`/Seitenwechsel auf `false` zurueckgesetzt.
- **Mitscrollen:** Nach jedem Segment-Insert (programmatisch, der Browser zieht den Scroll dabei NICHT automatisch nach) vermisst `_sttInsertText` den eingefuegten Textknoten und ruft `_scrollEditCaretIntoView(rect)` ([notebook/edit.js](../public/js/editor/notebook/edit.js), via Trampoline). Generischer Caret-Follow-Helper: das contenteditable ist sein eigener Scroll-Container (`max-height`/`overflow-y:auto`), darum `scrollTop`-Nudge statt `scrollIntoView`; nur wenn der Caret ueber/unter den Rand rutscht. Auch von `_markEditDirty` aufgerufen (Tippen/Paste/Toolbar — Sicherheitsnetz; No-op solange der Caret sichtbar ist).
- **Satzgrenze an Sprechpausen:** Wird ein Segment per VAD an einer Stille abgeschnitten (`_computeVadCut` reason `silence`, nicht `max`), gilt die Segmentgrenze als Satzgrenze. `_computeSpacedInsert(prevChar, text, startsNewSentence)` setzt dann einen Punkt + Leerzeichen vor das naechste Transkript, falls der Vortext noch kein Satzendezeichen hat (sonst nur Leerzeichen). Der Cut-Grund reist via `rt.lastCutReason` → `rt.boundaryForNext` zum naechsten `onstop` und von dort als `startsNewSentence`-Flag durch `_sttSendSegment` → `_sttInsertText`. Das Leerzeichen-vor-Wort-Problem ueber Segmentgrenzen loest `_sttCharBefore` (liest das Zeichen links vom Caret per Range — deckt auch Element-Knoten-Carets nach dem zuletzt eingefuegten Textknoten ab).
- **Input-Plausibilisierung:** `_normalizeTranscript` (pure) trimmt jedes Segment, kollabiert interne Whitespace-Folgen (Whisper liefert manchmal Doppel-Leerzeichen/Umbrueche) und tilgt Leerzeichen vor Satzzeichen. Zusaetzlich entfernt `_sttInsertText` via `_computeEatPrevSpace` (pure Entscheidung) + `_sttDeletePrevWhitespace` (DOM) ein bereits vorhandenes Leerzeichen am Caret, wenn das neue Segment mit Satzzeichen beginnt — verhindert „Wort , dann". Greift nur bei kollabiertem Caret.
- **Live-Status-Indikator** ([editor-body-edit.html](../public/partials/editor-body-edit.html), `.stt-dock .stt-status` in [page-view.css](../public/css/page/page-view.css)): Status-Pill links vom Mic mit Punkt-Indikator, **zwei ruhige Zustaende** (bewusst KEIN per-Tick-Pegel-State — der strobte mit jeder Silbe): `stt.status.hearing` (Aufnahme laeuft, roter Punkt mit langsamem Atem-Puls) und `stt.status.transcribing` (Segment-Upload, Akzent-Puls). Der „transkribiert"-Zustand laeuft ueber `sttBusy` mit **Mindest-Standzeit 600 ms** (`_sttBusyOn`/`_sttBusyOff`), damit kurze Segmente nicht aufblitzen. Reduced-Motion: kein Puls. Stoppen = erneuter Klick auf den Mic (`toggleSttDictation`).
- **State** ([app-state.js](../public/js/app/app-state.js)): `sttEnabled`, `sttVad`, `sttRecording`, `sttPending` (Re-Entry-Guard), `sttTranscribing` (Zaehler laufender Transkriptions-Requests, in `_sttSendSegment`), `sttBusy` (abgeleiteter Anzeige-Flag mit Mindest-Standzeit). Runtime-Handle `_sttBusyTimer`. Sprache **nicht** im Frontend.
- **Config-Load + init-Hook** ([app.js](../public/js/app.js)): `this.sttEnabled = !!cfg.stt?.enabled`; `_initSttDictation(signal)` abonniert `book:changed`/`view:reset` und watcht `editMode`/`currentPage.id` → Aufnahme stoppen + Mic freigeben.
- **Button** ([editor-body-edit.html](../public/partials/editor-body-edit.html)): `x-if="sttEnabled"`, schwebender Mic-Button `.stt-dock-btn` **unten rechts im Editorfeld** (`.stt-dock`, `position: sticky`, analog zum LanguageTool-Badge oben rechts — bewusst nicht in der Toolbar, sonst verwechselbar). Icon `#mic`, Recording-State (roter Puls) via CSS in [page-view.css](../public/css/page/page-view.css) (`.stt-dock-btn.is-recording[aria-pressed="true"]`). Sticky haelt den Mic am sichtbaren Feldrand, waehrend Seite/Karte scrollt.
- **Admin-UI** ([admin-settings.html](../public/partials/admin-settings.html)): Tab `stt` (enabled, Host, Model, API-Key-Masking, Fallback-Sprache-`combobox`, VAD-`numInput`s, Test-Button). Save/Diff/Encrypted-Coercion generisch ueber das bestehende `admin-settings.js`-Geruest.

## Pflicht-Invarianten

- **Nur Notebook-Editor.** Focus-Editor + Bucheditor unberuehrt (Phase 2).
- Eingefuegter Text laeuft durch den normalen Notebook-Save-Pfad — STT ist nur eine weitere DOM-Mutation am contenteditable, danach greift Autosave/`data-bid`/Stale-Write unveraendert.
- Transkript als **reiner Text** (`createTextNode`/`range.insertNode`) — keine HTML-Interpretation, kein `x-html`-Sink.
- Host/API-Key bleiben server-seitig; `/config` liefert sie nie.
- Kein Audio persistiert. Leerer/Whitespace-Transkript → nichts einfuegen. Einzelner Segment-Fehler stoppt die Session nicht.
- Abschaltbar ueber `stt.enabled=false` (Default) → Button nicht im DOM, Proxy `404`.

## Tests

- Unit: [tests/unit/stt-vad.test.mjs](../tests/unit/stt-vad.test.mjs) (VAD/RMS/Mime/Spacing pure), [tests/unit/stt-config-delivery.test.js](../tests/unit/stt-config-delivery.test.js) (Secret-Leck-Schutz).
- Integration: [tests/integration/stt-proxy.test.js](../tests/integration/stt-proxy.test.js) (disabled/415/forward/502/408, Buch-Locale, Secret server-seitig).
- E2E: [tests/e2e/stt-dictation.spec.js](../tests/e2e/stt-dictation.spec.js) (Button-Sichtbarkeit, VAD-Segment→Insert+Autosave, Stop→Mic frei, Permission-Denial).

## Betreiber (self-hosted Backend)

OpenAI-kompatibler Whisper-Endpunkt mit `/v1/audio/transcriptions`: Speaches / faster-whisper-server / whisper.cpp im Server-Mode. Host + Model im Admin-Tab „Diktat" eintragen, testen, aktivieren.
