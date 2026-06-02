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

  // Fuegt vor dem Transkript ein Leerzeichen ein, wenn unmittelbar davor ein
  // Nicht-Whitespace steht und der neue Text nicht mit Satzzeichen beginnt —
  // damit Worte ueber Segmentgrenzen hinweg nicht zusammenkleben.
  //
  // startsNewSentence = das vorige Segment wurde an einer Sprechpause
  // abgeschnitten: dann ist die Segmentgrenze eine Satzgrenze. Fehlt am Vortext
  // ein Satzendezeichen, wird ein Punkt ergaenzt (". " statt nur " ").
  _computeSpacedInsert(prevChar, text, startsNewSentence) {
    const t = this._normalizeTranscript(text);
    if (!t) return '';
    if (!prevChar) return t;
    const startsPunct = /^[\s,.;:!?…)»"'’-]/.test(t);
    if (/\s/.test(prevChar)) return t; // schon Whitespace davor
    if (startsNewSentence && !startsPunct) {
      return /[.!?…]/.test(prevChar) ? ' ' + t : '. ' + t;
    }
    return startsPunct ? t : ' ' + t;
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
    const stop = () => { if (this.sttRecording || this.sttPending) this._sttStop(); };
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
      boundaryForNext: false,
    };
    this._sttRt = rt;

    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) rt.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = rt.chunks.length ? new Blob(rt.chunks, { type: rt.mime }) : null;
      rt.chunks = [];
      const startsNewSentence = !!rt.boundaryForNext;
      if (blob && blob.size > 0 && rt.hasVoice) this._sttSendSegment(blob, rt.mime, startsNewSentence);
      // Wurde dieses Segment an einer Sprechpause abgeschnitten, beginnt das
      // naechste einen neuen Satz.
      rt.boundaryForNext = (rt.lastCutReason === 'silence');
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
    try { rec.start(); } catch { /* noop */ }
    this.sttRecording = true;
    this.sttPending = false;
    // Mic-Klick = „ans Ende anfügen": Caret beim Start ans Editorende setzen,
    // damit Diktat unten anwächst, statt an einer evtl. veralteten Caret-Position
    // mitten im Text einzufügen. Folgesegmente hängen am vorrückenden Caret weiter.
    this._sttAnchorToEnd();
    rt.vadTimer = setInterval(() => this._sttVadTick(), 100);
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
    const decision = this._computeVadCut({
      rms,
      threshold: this.sttVad.threshold,
      now,
      segmentStart: rt.segmentStart,
      lastVoiceTs: rt.lastVoiceTs,
      hasVoice: rt.hasVoice,
      silenceMs: this.sttVad.silenceMs,
      maxSegmentS: this.sttVad.maxSegmentS,
    });
    if (decision.voiced) { rt.hasVoice = true; rt.lastVoiceTs = now; }
    if (decision.cut && rt.rec.state === 'recording') {
      rt.lastCutReason = decision.reason;
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

  async _sttSendSegment(blob, mime, startsNewSentence) {
    const bookId = this.selectedBookId ? `?bookId=${encodeURIComponent(this.selectedBookId)}` : '';
    this._sttBusyOn(); // Indikator „transkribiert" (mit Mindest-Standzeit)
    let res;
    try {
      res = await fetch(`/stt/transcribe${bookId}`, {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: blob,
      });
    } catch {
      // Einzelnes Segment-Fehlschlag stoppt die Session nicht (Edge-Case-Regel).
      this._showJobToast?.({ message: this.t('stt.error.failed'), severity: 'err', jobType: 'stt', bookId: null });
      this._sttBusyOff();
      return;
    }
    if (res.status === 404) { this._sttBusyOff(); this._sttStop(); return; } // Feature serverseitig aus
    if (!res.ok) {
      this._showJobToast?.({ message: this.t('stt.error.failed'), severity: 'err', jobType: 'stt', bookId: null });
      this._sttBusyOff();
      return;
    }
    let text = '';
    try { text = (await res.json())?.text || ''; } catch { this._sttBusyOff(); return; }
    this._sttBusyOff();
    this._sttInsertText(text, startsNewSentence);
  },

  _sttInsertText(text, startsNewSentence) {
    const clean = this._normalizeTranscript(text);
    if (!clean) return; // leerer/Whitespace-Transkript -> nichts einfuegen
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
    const node = document.createTextNode(this._computeSpacedInsert(prevChar, clean, startsNewSentence));
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

  // Zeichen unmittelbar vor dem Caret (fuer Leerzeichen-Heuristik). Der Caret
  // steht zwischen Segmenten meist an einer Knotengrenze (nach dem zuletzt
  // eingefuegten Textknoten), wo `startContainer` ein Elementknoten ist — darum
  // den gesamten Text links vom Caret per Range einsammeln und das letzte
  // Zeichen nehmen (deckt Text- und Elementknoten gleichermassen ab).
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
