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

  // Fuegt vor dem Transkript ein Leerzeichen ein, wenn unmittelbar davor ein
  // Nicht-Whitespace steht und der neue Text nicht mit Satzzeichen beginnt —
  // damit Worte ueber Segmentgrenzen hinweg nicht zusammenkleben.
  _computeSpacedInsert(prevChar, text) {
    const t = String(text || '').trim();
    if (!t) return '';
    const needsSpace = prevChar && !/\s/.test(prevChar) && !/^[\s,.;:!?…)»"'’-]/.test(t);
    return needsSpace ? ' ' + t : t;
  },

  // ── Lifecycle ───────────────────────────────────────────────────────────

  _initSttDictation(signal) {
    // Runtime-Handles (MediaRecorder/AudioContext/Stream/Interval) — bewusst
    // kein deklarierter Karten-State, sondern ein Runtime-Container analog den
    // async-Re-Entry-Guards. Pro Aufnahme-Session neu befuellt, bei Stop genullt.
    this._sttRt = null;
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
    };
    this._sttRt = rt;

    rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) rt.chunks.push(e.data); };
    rec.onstop = () => {
      const blob = rt.chunks.length ? new Blob(rt.chunks, { type: rt.mime }) : null;
      rt.chunks = [];
      if (blob && blob.size > 0 && rt.hasVoice) this._sttSendSegment(blob, rt.mime);
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
    rt.vadTimer = setInterval(() => this._sttVadTick(), 100);
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
      // stop() triggert onstop -> Segment senden + naechstes Segment starten.
      try { rt.rec.stop(); } catch { /* noop */ }
    }
  },

  _sttStop() {
    const rt = this._sttRt;
    this.sttRecording = false;
    this.sttPending = false;
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

  async _sttSendSegment(blob, mime) {
    const bookId = this.selectedBookId ? `?bookId=${encodeURIComponent(this.selectedBookId)}` : '';
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
      return;
    }
    if (res.status === 404) { this._sttStop(); return; } // Feature serverseitig aus
    if (!res.ok) {
      this._showJobToast?.({ message: this.t('stt.error.failed'), severity: 'err', jobType: 'stt', bookId: null });
      return;
    }
    let text = '';
    try { text = (await res.json())?.text || ''; } catch { return; }
    this._sttInsertText(text);
  },

  _sttInsertText(text) {
    const clean = String(text || '').trim();
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
    const prevChar = this._sttCharBefore(range);
    const node = document.createTextNode(this._computeSpacedInsert(prevChar, clean));
    range.deleteContents();
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(range);
    this._markEditDirty?.();
  },

  // Zeichen unmittelbar vor dem Caret (fuer Leerzeichen-Heuristik).
  _sttCharBefore(range) {
    try {
      const probe = range.cloneRange();
      probe.collapse(true);
      const node = probe.startContainer;
      if (node.nodeType === 3 && probe.startOffset > 0) {
        return node.textContent[probe.startOffset - 1] || '';
      }
    } catch { /* noop */ }
    return '';
  },
};
