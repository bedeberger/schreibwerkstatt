'use strict';
// STT-Diktat (nur Notebook-Editor). Mic-Button in der Notebook-Toolbar nimmt
// kontinuierlich auf; browserseitiges VAD (WebAudio-RMS) schneidet an
// Sprechpausen ab. Jedes abgeschlossene Segment geht an /stt/transcribe; der
// zurueckkommende Text wird verbatim am Cursor eingefuegt, waehrend schon das
// naechste Segment laeuft.
//
// Diese Methoden werden in den Root (`Alpine.data('lektorat')`) gespreaded —
// die Notebook-Icon-Bar laeuft im Root-Scope (wie notebookUndo/Entity-Toggle).
//
// Sprache loest der Proxy aus der Buch-Locale auf; das Frontend schickt nur
// `bookId`. Pure-Compute-Teile (`_computeXxx`) sind ohne Browser testbar.
//
// Segmentierung via MediaRecorder-Stop/Start-Zyklus: stop() liefert ein
// standalone-dekodierbares Segment (eigener Container-Header) — ein blosses
// Slicen der dataavailable-Chunks ergaebe headerlose, nicht dekodierbare
// Fragmente.

const STT_MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
];

// Rausch-Kalibrierung: Fenster, in dem vor dem ersten Sprechen der
// Geraeuschboden gesammelt wird (blockiert die Spracherkennung nicht).
const STT_CALIB_MS = 350;
// Absatz-Erkennung: ist die Gesamt-Sprechpause >= silenceMs * Faktor, gilt die
// Segmentgrenze als Absatzgrenze (neuer `<p>`) statt nur als Satzgrenze.
const STT_PARAGRAPH_FACTOR = 2.5;
// Segment-Retry: transiente Upstream-Fehler einmal wiederholen, bevor der
// Fehler-Toast kommt (kein verlorener Satz bei kurzem Haenger).
const STT_MAX_RETRY = 1;
const STT_RETRY_DELAY_MS = 600;
const STT_RETRYABLE_STATUS = new Set([408, 500, 502, 503]);

export const sttDictationMethods = {
  // ── Pure Compute (testbar ohne Browser) ────────────────────────────────

  // RMS aus einem Time-Domain-Sample (Uint8Array, zentriert um 128).
  _computeRms(timeDomain) {
    if (!timeDomain || !timeDomain.length) return 0;
    let sum = 0;
    for (let i = 0; i < timeDomain.length; i++) {
      const v = (timeDomain[i] - 128) / 128;
      sum += v * v;
    }
    return Math.sqrt(sum / timeDomain.length);
  },

  // Segment-Schnitt-Entscheidung. Schneidet, wenn nach erkannter Sprache eine
  // Stille von >= silenceMs anhaelt, oder wenn das Segment maxSegmentS
  // ueberschreitet (Schutz gegen Dauer-Sprechen ohne Pause).
  _computeVadCut({ rms, threshold, now, segmentStart, lastVoiceTs, hasVoice, silenceMs, maxSegmentS }) {
    const voiced = rms >= threshold;
    if (hasVoice && (now - segmentStart) >= maxSegmentS * 1000) {
      return { cut: true, reason: 'max', voiced };
    }
    if (hasVoice && !voiced && (now - lastVoiceTs) >= silenceMs) {
      return { cut: true, reason: 'silence', voiced };
    }
    return { cut: false, voiced };
  },

  // Beste vom Browser unterstuetzte MediaRecorder-Mime. isSupported ist die
  // injizierte MediaRecorder.isTypeSupported-Funktion (testbar).
  _computeSttMime(isSupported) {
    for (const c of STT_MIME_CANDIDATES) {
      if (isSupported(c)) return c;
    }
    return '';
  },

  // Normalisiert ein Transkript-Segment fuer die Einfuegung: trimmt, kollabiert
  // interne Whitespace-Folgen (Whisper liefert gelegentlich Doppel-Leerzeichen
  // oder Zeilenumbrueche) und tilgt ein Leerzeichen DIREKT vor Satzzeichen
  // („Wort , dann" -> „Wort, dann").
  _normalizeTranscript(text) {
    return String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?…])/g, '$1')
      .trim();
  },

  // Schreibt den ersten Buchstaben gross (ggf. nach einem oeffnenden Zeichen wie
  // Anfuehrung/Klammer). No-op, wenn der Text mit Ziffer/Satzzeichen beginnt
  // oder schon gross ist. Pure/testbar.
  _capitalizeSentenceStart(text) {
    return String(text || '').replace(
      /^([\s"'»«„“‚‘(\[]*)(\p{L})/u,
      (_, pre, ch) => pre + ch.toUpperCase(),
    );
  },

  // True, wenn der vorausgehende Text auf einem Satzendezeichen endet — auch
  // wenn danach noch schliessende Anfuehrungs-/Klammerzeichen stehen
  // („…her.«", „…?"", „…!)"). So erkennen wir vom Modell gesetzte Satzzeichen
  // (Whisper punktiert selbst) und ergaenzen keinen eigenen Punkt. Pure/testbar.
  _endsSentence(prevText) {
    const s = String(prevText || '').replace(/[\s"'’”“»«)\]]+$/u, '');
    return /[.!?…]$/.test(s);
  },

  // Fuegt vor dem Transkript ein Leerzeichen ein, wenn unmittelbar davor ein
  // Nicht-Whitespace steht und der neue Text nicht mit Satzzeichen beginnt —
  // damit Worte ueber Segmentgrenzen hinweg nicht zusammenkleben.
  //
  // `prevText` ist der (Teil-)Text links vom Caret; das letzte Zeichen bestimmt
  // die Leerzeichen-Heuristik, der getrimmte Schwanz die Satzende-Erkennung.
  // startsNewSentence = das vorige Segment wurde an einer Sprechpause
  // abgeschnitten: dann ist die Segmentgrenze eine Satzgrenze. Liefert das
  // Modell selbst ein Satzendezeichen (auch hinter einer schliessenden
  // Anfuehrung wie „…her.«"), ergaenzen wir KEINEN eigenen Punkt — nur das
  // trennende Leerzeichen. Nur wenn der Vortext gar kein Satzendezeichen hat,
  // wird einer gesetzt (". " statt nur " "). Beginnt ein neuer Satz, wird der
  // erste Buchstabe gross geschrieben.
  _computeSpacedInsert(prevText, text, startsNewSentence) {
    let t = this._normalizeTranscript(text);
    if (!t) return '';
    const prev = String(prevText || '');
    const prevChar = prev ? prev[prev.length - 1] : '';
    const prevEndsSentence = this._endsSentence(prev);
    const newSentence = startsNewSentence || !prevChar || prevEndsSentence;
    if (newSentence) t = this._capitalizeSentenceStart(t);
    if (!prevChar) return t;
    const startsPunct = /^[\s,.;:!?…)»"'’-]/.test(t);
    if (/\s/.test(prevChar)) return t; // schon Whitespace davor
    if (startsNewSentence && !startsPunct) {
      return prevEndsSentence ? ' ' + t : '. ' + t;
    }
    return startsPunct ? t : ' ' + t;
  },

  // Effektiver VAD-Threshold aus gemessenem Geraeuschboden: leicht ueber dem
  // Rauschen, nie unter dem Admin-Wert und auf das 5-Fache gedeckelt (verhindert
  // Ueber-Unterdrueckung, falls waehrend der Kalibrierung doch gesprochen wurde).
  // Pure/testbar.
  _computeNoiseThreshold(noiseFloor, base) {
    const b = Number(base) || 0;
    const cand = (Number(noiseFloor) || 0) * 1.8 + 0.004;
    return Math.min(Math.max(b, cand), Math.max(b * 5, 0.08));
  },

  // Plausibilisierung am Caret: liefert true, wenn ein Whitespace direkt vor
  // dem Caret getilgt werden soll, weil das neue Segment mit Satzzeichen
  // beginnt (sonst entstuende „Wort , dann"). Pure/testbar.
  _computeEatPrevSpace(prevChar, text) {
    const t = String(text || '').trim();
    if (!t) return false;
    return /\s/.test(prevChar) && /^[,.;:!?…]/.test(t);
  },

  // ── Lifecycle ───────────────────────────────────────────────────────────

  _initSttDictation(signal) {
    // Runtime-Handles (MediaRecorder/AudioContext/Stream/Interval) — bewusst
    // kein deklarierter Karten-State, sondern ein Runtime-Container analog den
    // async-Re-Entry-Guards. Pro Aufnahme-Session neu befuellt, bei Stop genullt.
    this._sttRt = null;
    this._sttBusyTimer = null; // Mindest-Standzeit-Timer fuer den „Transkribiert"-Status
    // Aufnahme beenden + den bewussten-Caret-Anker zuruecksetzen (neuer Kontext
    // = kein gueltiger Anker mehr; STT haengt wieder ans Editorende an, bis der
    // User erneut bewusst klickt).
    const stop = () => {
      this.sttCaretUserSet = false;
      if (this.sttRecording || this.sttPending) this._sttStop();
    };
    window.addEventListener('book:changed', stop, { signal });
    window.addEventListener('view:reset', stop, { signal });
    // Edit-Modus verlassen / Seite gewechselt -> Aufnahme beenden, Mic freigeben.
    this.$watch('editMode', (on) => { if (!on) stop(); });
    this.$watch(() => this.currentPage?.id, () => stop());
  },

  // ── Toggle / Start / Stop ────────────────────────────────────────────────

  async toggleSttDictation() {
    if (this.sttPending) return; // Re-Entry-Guard waehrend getUserMedia/Stop
    if (this.sttRecording) { this._sttStop(); return; }
    await this._sttStart();
  },

  async _sttStart() {
    if (!this.sttEnabled || this.sttRecording || this.sttPending) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this._showJobToast?.({ message: this.t('stt.error.unavailable'), severity: 'err', jobType: 'stt', bookId: null });
      return;
    }
    const mime = this._computeSttMime((m) => {
      try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
    });
    this.sttPending = true;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      this.sttPending = false;
      const key = e?.name === 'NotAllowedError' || e?.name === 'SecurityError'
        ? 'stt.error.permission' : 'stt.error.unavailable';
      this._showJobToast?.({ message: this.t(key), severity: 'err', jobType: 'stt', bookId: null });
      return;
    }

    let rec;
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch {
      stream.getTracks().forEach(t => t.stop());
      this.sttPending = false;
      this._showJobToast?.({ message: this.t('stt.error.unavailable'), severity: 'err', jobType: 'stt', bookId: null });
      return;
    }

    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const timeDomain = new Uint8Array(analyser.fftSize);

    const rt = {
      stream, rec, audioCtx, source, analyser, timeDomain,
      chunks: [],
      vadTimer: null,
      segmentStart: 0,
      lastVoiceTs: 0,
      hasVoice: false,
      mime: rec.mimeType || mime || 'audio/webm',
      stopping: false,
      // Cut-Grund des zuletzt geschnittenen Segments; bestimmt, ob das naechste
      // Segment einen neuen Satz beginnt (silence = Sprechpause = Satzgrenze).
      lastCutReason: null,
      // Grenz-Art VOR dem aktuell aufgenommenen Segment: 'none' | 'sentence' |
      // 'paragraph'. silence-Cut => mind. 'sentence'; eine deutlich laengere
      // Gesamtpause stuft beim naechsten Sprechen auf 'paragraph' hoch.
      boundaryKindForNext: 'none',
      silenceCutAt: null, // Zeitpunkt des letzten silence-Cuts (fuer Pausenmessung)
      // VAD-Threshold dieser Session: startet beim Admin-Wert, wird durch die
      // Rausch-Kalibrierung ggf. angehoben.
      threshold: this.sttVad.threshold,
      calibrating: true,
      calibStart: 0,
      noiseSum: 0,
      noiseCount: 0,
    };
    this._sttRt = rt;

    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) rt.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = rt.chunks.length ? new Blob(rt.chunks, { type: rt.mime }) : null;
      rt.chunks = [];
      // Grenz-Art VOR diesem Segment (ggf. waehrend der Aufnahme auf 'paragraph'
      // hochgestuft) bestimmt, wie das Transkript angefuegt wird.
      const boundaryKind = rt.boundaryKindForNext;
      if (blob && blob.size > 0 && rt.hasVoice) this._sttSendSegment(blob, rt.mime, boundaryKind);
      // Grenze fuer das naechste Segment: silence-Cut => mind. neuer Satz;
      // max-Cut (Dauer-Sprechen) => keine Grenze (mitten im Satz).
      rt.boundaryKindForNext = (rt.lastCutReason === 'silence') ? 'sentence' : 'none';
      rt.lastCutReason = null;
      // Naechstes Segment, falls noch aktiv.
      if (!rt.stopping && this.sttRecording) {
        rt.hasVoice = false;
        rt.segmentStart = this._sttNow();
        rt.lastVoiceTs = rt.segmentStart;
        try { rec.start(); } catch { /* noop */ }
      }
    };

    rt.segmentStart = this._sttNow();
    rt.lastVoiceTs = rt.segmentStart;
    rt.calibStart = rt.segmentStart;
    try { rec.start(); } catch { /* noop */ }
    this.sttRecording = true;
    this.sttPending = false;
    // Einfüge-Anker bestimmen: hat der User bewusst per Klick einen Caret im
    // Edit-Feld gesetzt (sttCaretUserSet) und steht dieser noch im Editor, wird
    // dort eingefügt (nur sichtbar scrollen). Sonst — z. B. blosser Mic-Klick
    // ohne Caret-Platzierung — hängt das Diktat ans Editorende an.
    if (this.sttCaretUserSet && this._sttCaretInEditor()) {
      this._scrollEditCaretIntoView?.();
    } else {
      this._sttAnchorToEnd();
    }
    rt.vadTimer = setInterval(() => this._sttVadTick(), 100);
  },

  // True, wenn die aktuelle Selection (Caret) innerhalb des Edit-Felds liegt.
  _sttCaretInEditor() {
    const editEl = this._getEditEl?.();
    const sel = typeof document !== 'undefined' ? document.getSelection() : null;
    if (!editEl || !sel || !sel.rangeCount) return false;
    const c = sel.getRangeAt(0).commonAncestorContainer;
    return editEl === c || editEl.contains(c);
  },

  // Setzt den Caret ans Ende des Editorinhalts und scrollt dorthin — Anker für
  // die erste Diktat-Einfügung (siehe _sttStart).
  _sttAnchorToEnd() {
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    try {
      const range = document.createRange();
      range.selectNodeContents(editEl);
      range.collapse(false);
      const sel = document.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      this._scrollEditCaretIntoView?.();
    } catch { /* noop */ }
  },

  _sttNow() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  },

  _sttVadTick() {
    const rt = this._sttRt;
    if (!rt || !this.sttRecording) return;
    rt.analyser.getByteTimeDomainData(rt.timeDomain);
    const rms = this._computeRms(rt.timeDomain);
    const now = this._sttNow();
    const voiced = rms >= rt.threshold;

    // Rausch-Kalibrierung: vor dem ersten Sprechen die ruhigen Frames sammeln
    // und den Threshold ueber den Geraeuschboden legen. Blockiert die
    // Spracherkennung NICHT (es gilt bis zur Finalisierung der Admin-Wert);
    // wird sofort gesprochen oder fehlen ruhige Frames, bleibt es beim Wert.
    if (rt.calibrating) {
      if (!voiced) { rt.noiseSum += rms; rt.noiseCount++; }
      if (voiced || (now - rt.calibStart) >= STT_CALIB_MS) {
        if (rt.noiseCount >= 2) {
          rt.threshold = this._computeNoiseThreshold(rt.noiseSum / rt.noiseCount, this.sttVad.threshold);
        }
        rt.calibrating = false;
      }
    }

    const decision = this._computeVadCut({
      rms,
      threshold: rt.threshold,
      now,
      segmentStart: rt.segmentStart,
      lastVoiceTs: rt.lastVoiceTs,
      hasVoice: rt.hasVoice,
      silenceMs: this.sttVad.silenceMs,
      maxSegmentS: this.sttVad.maxSegmentS,
    });
    if (decision.voiced) { rt.hasVoice = true; rt.lastVoiceTs = now; }

    // Absatz-Erkennung: erstes Sprechen nach einem silence-Cut -> Gesamtpause
    // messen (silenceMs vor dem Cut + Luecke bis jetzt). Ist sie deutlich
    // laenger als eine normale Sprechpause, wird die vorausgehende Grenze von
    // 'sentence' auf 'paragraph' hochgestuft (neuer Absatz statt nur ". ").
    if (decision.voiced && rt.silenceCutAt != null && rt.boundaryKindForNext === 'sentence') {
      const totalPause = (now - rt.silenceCutAt) + this.sttVad.silenceMs;
      if (totalPause >= this.sttVad.silenceMs * STT_PARAGRAPH_FACTOR) {
        rt.boundaryKindForNext = 'paragraph';
      }
      rt.silenceCutAt = null;
    }

    if (decision.cut && rt.rec.state === 'recording') {
      rt.lastCutReason = decision.reason;
      // Pausenanfang fuer die Absatz-Messung des naechsten Segments merken.
      rt.silenceCutAt = decision.reason === 'silence' ? now : null;
      // stop() triggert onstop -> Segment senden + naechstes Segment starten.
      try { rt.rec.stop(); } catch { /* noop */ }
    }
  },

  // „Transkribiert"-Status mit Mindest-Standzeit: An sofort beim Start eines
  // Segment-Uploads, Aus erst, wenn KEIN Request mehr laeuft — und dann
  // verzoegert (600 ms), damit kurze Segmente den Status nicht aufblitzen
  // lassen.
  _sttBusyOn() {
    this.sttTranscribing++;
    this.sttBusy = true;
    if (this._sttBusyTimer) { clearTimeout(this._sttBusyTimer); this._sttBusyTimer = null; }
  },
  _sttBusyOff() {
    this.sttTranscribing = Math.max(0, this.sttTranscribing - 1);
    if (this.sttTranscribing > 0) return;
    if (this._sttBusyTimer) clearTimeout(this._sttBusyTimer);
    this._sttBusyTimer = setTimeout(() => { this.sttBusy = false; this._sttBusyTimer = null; }, 600);
  },

  _sttStop() {
    const rt = this._sttRt;
    this.sttRecording = false;
    this.sttPending = false;
    this.sttBusy = false;
    this.sttTranscribing = 0;
    if (this._sttBusyTimer) { clearTimeout(this._sttBusyTimer); this._sttBusyTimer = null; }
    if (!rt) return;
    rt.stopping = true;
    if (rt.vadTimer) { clearInterval(rt.vadTimer); rt.vadTimer = null; }
    try { if (rt.rec.state === 'recording') rt.rec.stop(); } catch { /* noop */ }
    try { rt.stream.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    try { rt.source.disconnect(); } catch { /* noop */ }
    try { rt.audioCtx.close(); } catch { /* noop */ }
    this._sttRt = null;
  },

  // ── Segment-Upload + Insert ───────────────────────────────────────────────

  async _sttSendSegment(blob, mime, boundaryKind) {
    this._sttBusyOn(); // Indikator „transkribiert" (mit Mindest-Standzeit)
    let text = null;
    try {
      text = await this._sttFetchTranscript(blob, mime, 0);
    } finally {
      this._sttBusyOff();
    }
    if (text == null) return; // Fehler bereits behandelt (Toast/Stop)
    this._sttInsertText(text, boundaryKind);
  },

  // Transkribiert ein Segment; gibt den Text zurueck oder null (Fehler bereits
  // behandelt). Transiente Fehler (Netzwerk-Throw, 408/5xx) werden bis zu
  // STT_MAX_RETRY-mal wiederholt, bevor der Fehler-Toast kommt — ein kurzer
  // Upstream-Haenger kostet so keinen Satz. 404 (Feature aus) und 4xx
  // (z. B. 413/415) werden NICHT wiederholt.
  async _sttFetchTranscript(blob, mime, attempt) {
    const bookId = this.selectedBookId ? `?bookId=${encodeURIComponent(this.selectedBookId)}` : '';
    let res;
    try {
      res = await fetch(`/stt/transcribe${bookId}`, {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: blob,
      });
    } catch {
      if (attempt < STT_MAX_RETRY) {
        await this._sttDelay(STT_RETRY_DELAY_MS);
        return this._sttFetchTranscript(blob, mime, attempt + 1);
      }
      this._sttToastFailed();
      return null;
    }
    if (res.status === 404) { this._sttStop(); return null; } // Feature serverseitig aus
    if (!res.ok) {
      if (STT_RETRYABLE_STATUS.has(res.status) && attempt < STT_MAX_RETRY) {
        await this._sttDelay(STT_RETRY_DELAY_MS);
        return this._sttFetchTranscript(blob, mime, attempt + 1);
      }
      this._sttToastFailed();
      return null;
    }
    try { return (await res.json())?.text || ''; } catch { return null; }
  },

  _sttDelay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); },

  _sttToastFailed() {
    this._showJobToast?.({ message: this.t('stt.error.failed'), severity: 'err', jobType: 'stt', bookId: null });
  },

  _sttInsertText(text, boundaryKind) {
    const clean = this._normalizeTranscript(text);
    if (!clean) return; // leerer/Whitespace-Transkript -> nichts einfuegen
    if (boundaryKind === 'paragraph') { this._sttInsertParagraph(clean); return; }
    const startsNewSentence = boundaryKind === 'sentence';
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    const sel = document.getSelection();
    let range = null;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (editEl.contains(r.commonAncestorContainer) || editEl === r.commonAncestorContainer) {
        range = r;
      }
    }
    if (!range) {
      // Cursor nicht im Editor -> ans Ende anhaengen.
      range = document.createRange();
      range.selectNodeContents(editEl);
      range.collapse(false);
    }
    let prevChar = this._sttCharBefore(range);
    // Beginnt das Segment mit Satzzeichen und steht davor schon ein Leerzeichen,
    // dieses entfernen (kein „Wort , dann").
    if (range.collapsed && this._computeEatPrevSpace(prevChar, clean) && this._sttDeletePrevWhitespace(range)) {
      prevChar = this._sttCharBefore(range);
    }
    const prevText = this._sttTextBefore(range);
    const node = document.createTextNode(this._computeSpacedInsert(prevText, clean, startsNewSentence));
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    this._markEditDirty?.();
    // Programmatischer Insert: der Browser zieht den Scroll nicht automatisch
    // nach — den eingefügten Knoten selbst vermessen und ins Sichtfeld holen.
    let caretRect = null;
    try { const rr = document.createRange(); rr.selectNode(node); caretRect = rr.getBoundingClientRect(); } catch { /* noop */ }
    this._scrollEditCaretIntoView?.(caretRect);
  },

  // Fuegt das Transkript als NEUEN Absatz (`<p>`) ein — getriggert, wenn die
  // Sprechpause deutlich laenger war (Absatz-Erkennung im VAD). Der neue Absatz
  // wird hinter den Block gesetzt, in dem der Caret steht (sonst ans Editorende);
  // der vorausgehende Block bekommt ein Satzendezeichen, falls es fehlt. Erster
  // Buchstabe gross (neuer Absatz = neuer Satz). data-bid vergibt der Write-
  // Chokepoint beim Speichern (idempotent) — hier kein manuelles Setzen noetig.
  _sttInsertParagraph(clean) {
    const editEl = this._getEditEl?.();
    if (!editEl) return;
    const sel = document.getSelection();
    let range = null;
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (editEl.contains(r.commonAncestorContainer) || editEl === r.commonAncestorContainer) range = r;
    }
    if (!range) { range = document.createRange(); range.selectNodeContents(editEl); range.collapse(false); }

    // Direkten Kind-Block von editEl ermitteln, in dem der Caret steht.
    let block = range.startContainer;
    while (block && block !== editEl && block.parentNode !== editEl) block = block.parentNode;
    if (block === editEl) block = editEl.lastElementChild; // Caret direkt am Root

    const p = document.createElement('p');
    p.textContent = this._capitalizeSentenceStart(clean);
    if (block && block.parentNode === editEl) {
      this._sttEnsureTerminalPunct(block);
      block.after(p);
    } else {
      editEl.appendChild(p);
    }

    const r2 = document.createRange();
    r2.selectNodeContents(p);
    r2.collapse(false);
    sel?.removeAllRanges();
    sel?.addRange(r2);
    this._markEditDirty?.();
    let rect = null;
    try { rect = p.getBoundingClientRect(); } catch { /* noop */ }
    this._scrollEditCaretIntoView?.(rect);
  },

  // Haengt ein '.' an den letzten Textknoten eines Blocks an, wenn dieser nicht
  // bereits auf einem Satz-/Doppelpunkt endet — damit beim Absatzwechsel der
  // vorausgehende Satz sauber schliesst.
  _sttEnsureTerminalPunct(block) {
    try {
      if (!block || block.nodeType !== 1) return;
      // Schliessende Anfuehrungs-/Klammerzeichen mit abstreifen, damit ein vom
      // Modell gesetztes Satzzeichen im Dialog („…her.«") erkannt wird und wir
      // keinen zweiten Punkt anhaengen.
      const txt = (block.textContent || '').replace(/[\s"'’”“»«)\]]+$/u, '');
      if (!txt || /[.!?…:;]$/.test(txt)) return;
      const lastTextNode = (node) => {
        for (let i = node.childNodes.length - 1; i >= 0; i--) {
          const c = node.childNodes[i];
          if (c.nodeType === 3 && c.textContent.trim()) return c;
          if (c.nodeType === 1) { const r = lastTextNode(c); if (r) return r; }
        }
        return null;
      };
      const tn = lastTextNode(block);
      if (tn) tn.textContent = tn.textContent.replace(/\s+$/, '') + '.';
      else block.appendChild(document.createTextNode('.'));
    } catch { /* noop */ }
  },

  // Zeichen unmittelbar vor dem Caret (fuer Leerzeichen-Heuristik). Der Caret
  // steht zwischen Segmenten meist an einer Knotengrenze (nach dem zuletzt
  // eingefuegten Textknoten), wo `startContainer` ein Elementknoten ist — darum
  // den gesamten Text links vom Caret per Range einsammeln und das letzte
  // Zeichen nehmen (deckt Text- und Elementknoten gleichermassen ab).
  // Letzte n Zeichen links vom Caret (Default 12) — genug Kontext, um ein
  // Satzendezeichen auch hinter einer schliessenden Anfuehrung zu erkennen
  // (siehe `_endsSentence`). Sammelt den Text per Range ueber Knotengrenzen.
  _sttTextBefore(range, n = 12) {
    try {
      const editEl = this._getEditEl?.();
      if (!editEl) return '';
      const probe = range.cloneRange();
      probe.collapse(true);
      const left = document.createRange();
      left.selectNodeContents(editEl);
      left.setEnd(probe.startContainer, probe.startOffset);
      return left.toString().slice(-n);
    } catch { /* noop */ }
    return '';
  },

  _sttCharBefore(range) {
    try {
      const probe = range.cloneRange();
      probe.collapse(true);
      const node = probe.startContainer;
      if (node.nodeType === 3 && probe.startOffset > 0) {
        return node.textContent[probe.startOffset - 1] || '';
      }
      const editEl = this._getEditEl?.();
      if (editEl) {
        const left = document.createRange();
        left.selectNodeContents(editEl);
        left.setEnd(probe.startContainer, probe.startOffset);
        const txt = left.toString();
        if (txt.length) return txt[txt.length - 1];
      }
    } catch { /* noop */ }
    return '';
  },

  // Loescht ein einzelnes Whitespace-Zeichen direkt vor dem (kollabierten)
  // Caret und setzt `range` an die Tilgungsstelle. Liefert true bei Erfolg.
  // Deckt Textknoten-Caret und Element-Knoten-Grenze (vorausgehender Textknoten)
  // ab. Idempotent-sicher: tilgt nur, wenn dort wirklich Whitespace steht.
  _sttDeletePrevWhitespace(range) {
    try {
      if (!range.collapsed) return false;
      let node = range.startContainer;
      let offset = range.startOffset;
      if (node.nodeType === 1 && offset > 0) {
        let child = node.childNodes[offset - 1];
        while (child && child.nodeType === 1 && child.lastChild) child = child.lastChild;
        if (child && child.nodeType === 3) { node = child; offset = child.textContent.length; }
      }
      if (node.nodeType === 3 && offset > 0 && /\s/.test(node.textContent[offset - 1])) {
        node.deleteData(offset - 1, 1);
        range.setStart(node, offset - 1);
        range.collapse(true);
        return true;
      }
    } catch { /* noop */ }
    return false;
  },
};
