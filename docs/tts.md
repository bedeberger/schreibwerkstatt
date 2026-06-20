# TTS / Proof-Listening (Text-to-Speech, self-hosted)

Vorlesen des eigenen Texts im **Notebook-Editor** (Einzelseiten-Edit-Modus) — das Gegenstück zum [STT-Diktat](stt.md). Den eigenen Text gehört aufzudecken Stolperstellen, die das Auge überliest. Self-hosted, vom Betreiber konfigurier- und abschaltbar. **Dritte Sync-Proxy-Ausnahme** zur Job-Queue-Regel (neben [stt.md](stt.md) und [languagetool.md](languagetool.md)): kurzer Request/Response-Synthesecall, **kein** KI-Analysejob, kein Token-Budget, kein `callAI`. TTS liest verbatim vor — keine generative KI.

## Datenfluss

```
Notebook-Edit-Feld: Vorlese-Dock (Root-Scope) → Text satzweise segmentieren (Intl.Segmenter)
  → pro Satz POST /tts/speak?bookId=…  { text }
    → Proxy forwarded an ${tts.host}/v1/audio/speech (OpenAI-kompatibel, { model, voice, input, speed, response_format })
      (voice locale-aware aus der Buch-Locale aufgeloest)
      → Audio-Bytes (mp3/…) → blob:-Object-URL → new Audio(...).play()
        → aktueller Satz via ::highlight(tts-sentence) markiert + ins Sichtfeld gescrollt
```

Reines Lesen: **keine DOM-Mutation**, kein Save-Pfad, kein `data-bid`, kein Stale-Write. Der Highlight läuft über die CSS Custom Highlight API (wie Bucheditor-Find/Replace + LanguageTool-Squiggles) — er färbt nur, er verändert den Editor-Inhalt nicht.

## Backend

- **[routes/tts.js](../routes/tts.js)** — `POST /tts/speak`. JSON-Body `{ text }` (8 KB Cap, ein Satz/Absatz pro Request). Guard: `tts.enabled` + `tts.host` → sonst `404 tts_disabled`. Forward via JSON an `${host}/v1/audio/speech` mit `model`/`voice`/`input`/`speed`/`response_format` aus den App-Settings, optional `Authorization: Bearer`. Antwort-Bytes 1:1 durchgereicht (Content-Type aus `response_format` gemappt, `Cache-Control: no-store`). Timeout 20 s → `408`, Upstream-Fehler → `502`. Audio nie persistiert. `/tts/` steht in `API_PREFIXES` ([server.js](../server.js)) → abgelaufene Session liefert `401 JSON` (greift den globalen Session-Banner) statt Login-HTML-Redirect.
- **[routes/admin-settings.js](../routes/admin-settings.js)** — `POST /admin/settings/test-tts` (Health-Probe `GET /v1/models`).
- **[routes/proxies.js](../routes/proxies.js)** `/config` — liefert nur `tts: { enabled }`. **Kein** Host/Key/Model/Voice/Speed/Format (Secret-Leck-Schutz).
- **Stimme locale-aware:** Der Proxy löst die Stimme aus der **Buch-Locale** auf (`getBookLocale(bookId, userEmail)`, Region abgeschnitten: `de-CH` → `de`) — SSoT wie bei STT die Sprache. Ist `tts.voice.<lang>` (z. B. `tts.voice.de`) gesetzt, gewinnt sie; sonst greift die Standard-Stimme `tts.voice`. Ohne Buchscope (kein `bookId`) immer Default. Andere Locales als de/en fallen mangels Key automatisch auf den Default.
- **[lib/app-settings.js](../lib/app-settings.js)** — Keys: `tts.enabled`, `tts.host`, `tts.model`, `tts.voice` (Standard/Fallback), `tts.voice.de` / `tts.voice.en` (locale-spezifisch, optional), `tts.format` (Enum mp3/opus/aac/flac/wav/pcm), `tts.speed` (0.25–4), `tts.api_key` (`ENCRYPTED_KEYS`).
- **[server.js](../server.js)** — CSP `media-src 'self' blob:` (sonst blockt die Default-CSP das `blob:`-Audio).

## Frontend

- **[public/js/editor/notebook/tts-proof.js](../public/js/editor/notebook/tts-proof.js)** — `ttsProofMethods`, in den **Root** gespreaded (der Dock läuft im Root-Scope `lektorat`). Pure-Compute (`_computeTtsSentences`) testbar ohne Browser.
- **Segmentierung:** `_ttsCollectSegments` läuft über die Block-Kinder des Edit-Felds, zerlegt pro Block via `Intl.Segmenter` (Locale aus `uiLocale`) in Sätze und hält je Satz Block-Referenz + Zeichen-Offsets. Die DOM-Range wird erst beim Highlight gebaut (`_ttsBuildRange`, Tree-Walk) — überlebt minimale Reflows.
- **Prefetch-Kette (parallel synthetisieren, seriell abspielen):** `_ttsRun` highlightet Satz `i`, lädt `i` (+`TTS_PREFETCH_AHEAD`) vor (`_ttsPrefetch` cached Object-URL-Promises), spielt ab, rückt vor. Gegenstück zur STT-`insertChain` (dort seriell einfügen, hier seriell abspielen).
- **Steuerung:** `toggleTtsProof` (Haupttaste: starten / pausieren ↔ fortsetzen — Pause operiert am Media-Element, ohne das Play-Promise aufzulösen), `skipTtsProof` (nächster Satz, nur im laufenden Zustand), `stopTtsProof`. Alle Guards prüfen `this._ttsRt === rt` — eine beendete/gewechselte Session bricht still ab.
- **Fehler/Retry:** `_ttsFetchAudio` wiederholt transiente Upstream-Fehler (Netzwerk-Throw, 408/5xx) bis `TTS_MAX_RETRY`. `404` (Feature aus) / `401` (Session abgelaufen) stoppen die Session. Fehler-Toast nur **einmal pro Session** (`_ttsFailToasted`, kein Flood bei flächigem Host-Ausfall). `signal` (Session-AbortController) beendet Request + Retry-Wait sofort und still beim Stop.
- **Status/Scroll:** Status-Pille `tts.status.reading` (Satz `i/n`) / `tts.status.paused` / `tts.status.loading`. Scroll via generischem `_scrollEditCaretIntoView(rect)` aus [notebook/edit.js](../public/js/editor/notebook/edit.js) (Editor ist sein eigener Scroll-Container).
- **State** ([app-state.js](../public/js/app/app-state.js)): `ttsEnabled`, `ttsPlaying` (Session aktiv inkl. pausiert), `ttsPaused`, `ttsLoading`, `ttsIndex`/`ttsTotal`. Session-Runtime in `_ttsRt` (`segs`, `i`, `cache`, `urls`, `audio`, `paused`, `abort`, `resolveCurrent`).
- **Config-Load + init-Hook** ([app.js](../public/js/app.js)): `this.ttsEnabled = !!cfg.tts?.enabled`; `_initTtsProof(signal)` abonniert `book:changed`/`view:reset` und watcht `editMode`/`currentPage.id` → Wiedergabe stoppen + Audio/Object-URLs freigeben.
- **Dock** ([editor-body-edit.html](../public/partials/editor-body-edit.html)): `x-if="ttsEnabled"`, schwebend unten **links** im Editorfeld (`.tts-dock`, der STT-Mic sitzt unten rechts — bewusst getrennt). Haupttaste-Icon Kopfhörer→Pause→Play, Sekundär-Taster Skip (`chevron-last`) + Stop (`square`). CSS in [page-view.css](../public/css/page/page-view.css) (`@keyframes ttsReadPulse`, `::highlight(tts-sentence)`).
- **Admin-UI** ([admin-settings.html](../public/partials/admin-settings.html)): Tab `tts` (enabled, Host, Model, Standard-Stimme + Stimme Deutsch/English, Format-`combobox`, Speed-`numInput`, API-Key-Masking, Test-Button). Save/Diff/Encrypted-Coercion generisch über das bestehende `admin-settings.js`-Gerüst.

## Pflicht-Invarianten

- **Nur Notebook-Editor.** Focus-Editor + Bucheditor unberührt (Phase 2). Engine ist editor-agnostisch gebaut (Block-Walk + CSS Custom Highlight) → Nachziehen billig.
- **Keine DOM-Mutation, kein Save-Pfad** — Proof-Listening liest nur, der Highlight ist reines CSS Custom Highlight.
- Host/API-Key bleiben server-seitig; `/config` liefert nur `enabled`.
- Kein Audio persistiert. Leerer Text → Toast `tts.error.empty`, kein Start. Einzelner Satz-Fehler stoppt die Session nicht (übersprungen).
- **Kein Insert/Abspielen nach Stop** — `_ttsStop` setzt `_ttsRt=null` (Guard), abortet Requests, pausiert Audio, revokiert alle Object-URLs.
- Abschaltbar über `tts.enabled=false` (Default) → Dock nicht im DOM, Proxy `404`.

## Tests

- Unit: [tests/unit/tts-proof.test.mjs](../tests/unit/tts-proof.test.mjs) (Satz-Segmentierung, pure), [tests/unit/tts-config-delivery.test.js](../tests/unit/tts-config-delivery.test.js) (Secret-Leck-Schutz).
- Integration: [tests/integration/tts-proxy.test.js](../tests/integration/tts-proxy.test.js) (disabled/no-text/forward+voice+speed/502/408, `/v1`-Strip, Secret server-seitig).

## Betreiber (self-hosted Backend)

OpenAI-kompatibler Speech-Endpunkt mit `/v1/audio/speech`: openedai-speech (XTTS-v2 + Piper) / Kokoro-FastAPI. Host + Model + Voice im Admin-Tab „Vorlesen" eintragen, testen, aktivieren.

**Fertiges docker-compose-Setup (GPU, DE + EN): [docs/tts-host/](tts-host/)** — openedai-speech mit XTTS-v2/Piper, Beispiel-`voice_to_speaker.yaml`, Schritt-für-Schritt-Anleitung. Läuft auf Port 8000 parallel zum [STT-Host](stt-host/) (8001).
