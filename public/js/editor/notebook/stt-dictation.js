import { EVT } from '../../events.js';
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
// Segment-Retry: transiente Upstream-Fehler mehrfach mit exponentiellem Backoff
// wiederholen, bevor der Fehler-Toast kommt — ein GPU-Cold-Start (Modell-Reload
// nach Idle) oder kurzzeitige Backend-Last kostet so keinen Satz. Die Retries
// laufen INNERHALB der insertChain (siehe _sttSendSegment) → Sprechreihenfolge
// bleibt erhalten, spaetere Segmente warten nur mit dem Einfuegen.
const STT_MAX_RETRY = 3;
const STT_RETRY_DELAY_MS = 800; // Basis; Backoff = base * 2^attempt, gedeckelt
const STT_RETRY_MAX_DELAY_MS = 6000;
const STT_RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

// Bekannte Whisper-Halluzinationen bei stillen/unverstaendlichen Segmenten.
// EXACT trifft nur, wenn das ganze (normalisierte) Segment der Phrase gleicht;
// PATTERNS treffen eindeutige Untertitel-/Copyright-Marker, die in echtem
// Prosatext nicht vorkommen. Siehe `_isLikelyHallucination`.
const STT_HALLUCINATION_EXACT = new Set([
  'vielen dank',
  'vielen dank fürs zuschauen',
  'vielen dank fürs zuhören',
  'vielen dank für ihre aufmerksamkeit',
  'danke fürs zuschauen',
  'bis zum nächsten mal',
  'tschüss',
  'das war\'s',
  'untertitel',
  'untertitelung',
  'thank you',
  'thanks for watching',
]);
const STT_HALLUCINATION_PATTERNS = [
  /untertitel(ung)?\s+(des|der|im auftrag|von|aufgrund|erstellt)/i,
  /amara\.org/i,
  /\b(zdf|ard|wdr|swr|ndr|orf|srf)\b/i,
  /\bfunk\b[^.]*\b\d{4}\b/i,
  /^\s*copyright\b/i,
  /^\s*©/,
  /\buntertitel\b.*\b\d{4}\b/i,
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
  // Satzgrenzen folgen ausschliesslich der Punktierung des Modells: NUR wenn der
  // Vortext (bzw. der Doc-/Block-Anfang) auf einem Satzendezeichen steht, wird
  // der erste Buchstabe gross geschrieben. Eine blosse Sprechpause (Atemholen)
  // ist KEIN Satzende — wir ergaenzen weder einen eigenen Punkt noch eine
  // Grossschreibung, weil Whisper selbst punktiert und grossschreibt. `prevText`
  // ist der (Teil-)Text links vom Caret; das letzte Zeichen bestimmt die
  // Leerzeichen-Heuristik, der getrimmte Schwanz die Satzende-Erkennung
  // (`_endsSentence` erkennt Satzzeichen auch hinter schliessender Anfuehrung).
  _computeSpacedInsert(prevText, text) {
    let t = this._normalizeTranscript(text);
    if (!t) return '';
    const prev = String(prevText || '');
    const prevChar = prev ? prev[prev.length - 1] : '';
    if (!prevChar || this._endsSentence(prev)) t = this._capitalizeSentenceStart(t);
    if (!prevChar) return t;
    if (/\s/.test(prevChar)) return t; // schon Whitespace davor
    const startsPunct = /^[\s,.;:!?…)»"'’-]/.test(t);
    return startsPunct ? t : ' ' + t;
  },

  // Whisper „halluziniert" bei stillen/unverstaendlichen Segmenten bekannte
  // Boilerplate-Phrasen (Video-Untertitel-Floskeln, Dank-/Abschiedsformeln).
  // True, wenn das GANZE Segment einer solchen Phrase entspricht — dann wird es
  // verworfen statt eingefuegt. Bewusst Whole-Segment-Match bzw. eindeutige
  // Marker (ZDF/ARD/Amara/funk/Copyright), damit legitimer Prosatext, der eine
  // dieser Floskeln enthaelt, nicht faelschlich getilgt wird. Pure/testbar.
  _isLikelyHallucination(text) {
    const norm = String(text || '')
      .replace(/\s+/g, ' ')
      .replace(/[.!?…»«„“”"'’\s]+$/u, '')
      .trim()
      .toLowerCase();
    if (!norm) return false;
    if (STT_HALLUCINATION_EXACT.has(norm)) return true;
    return STT_HALLUCINATION_PATTERNS.some((re) => re.test(text));
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
    // Vorwaerts-Anker: der zuletzt von STT eingefuegte Knoten. Der Caret der
    // naechsten Einfuegung wird HINTER diesen gesetzt — nie die Live-Selection
    // gelesen, die der Browser nach laengeren Pausen (Fokusverlust) an den
    // Editoranfang zuruecksetzt und den Caret sonst „nach oben" springen liesse.
    // Bewegt sich ausschliesslich vorwaerts; pro Session zurueckgesetzt.
    this._sttLastNode = null;
    // Aufnahme beenden + den bewussten-Caret-Anker zuruecksetzen (neuer Kontext
    // = kein gueltiger Anker mehr; STT haengt wieder ans Editorende an, bis der
    // User erneut bewusst klickt).
    const stop = () => {
      this.$store.stt.caretUserSet = false;
      if (this.$store.stt.recording || this.$store.stt.pending) this._sttStop();
    };
    window.addEventListener(EVT.BOOK_CHANGED, stop, { signal });
    window.addEventListener(EVT.VIEW_RESET, stop, { signal });
    // Edit-Modus verlassen / Seite gewechselt -> Aufnahme beenden, Mic freigeben.
    this.$watch('editMode', (on) => { if (!on) stop(); });
    this.$watch(() => this.currentPage?.id, () => stop());
  },

  // ── Toggle / Start / Stop ────────────────────────────────────────────────

  async toggleSttDictation() {
    if (this.$store.stt.pending) return; // Re-Entry-Guard waehrend getUserMedia/Stop
    if (this.$store.stt.recording) { this._sttStop(); return; }
    await this._sttStart();
  },

  async _sttStart() {
    if (!this.$store.stt.enabled || this.$store.stt.recording || this.$store.stt.pending) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      this._showJobToast?.({ message: this.t('stt.error.unavailable'), severity: 'err', jobType: 'stt', bookId: null });
      return;
    }
    const mime = this._computeSttMime((m) => {
      try { return MediaRecorder.isTypeSupported(m); } catch { return false; }
    });
    this.$store.stt.pending = true;
    let stream;
    try {
      // Mono + DSP-Filter: kleinere Segmente (Diktat = ein Sprecher) und weniger
      // Whisper-Halluzinationen an der Quelle. Boolean-Constraints sind
      // best-effort — ein Geraet, das sie nicht kann, wirft hier nicht.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (e) {
      this.$store.stt.pending = false;
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
      this.$store.stt.pending = false;
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
      // AbortController dieser Session: bricht beim Stop alle laufenden
      // Transkriptions-Requests (inkl. Retry-Waits) ab — kein Transkript wird
      // nach dem Stop noch eingefuegt.
      abort: new AbortController(),
      // Einfuege-Reihenfolge: die Fetches laufen parallel (Durchsatz), die DOM-
      // Einfuegung jedes Segments wird aber ueber diese Promise-Kette in
      // Sende-Reihenfolge serialisiert — sonst koennte ein spaeter gesendetes,
      // aber schneller transkribiertes Segment (oder eines nach Retry) vor einem
      // frueheren im Text landen.
      insertChain: Promise.resolve(),
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
      threshold: this.$store.stt.vad.threshold,
      calibrating: true,
      calibStart: 0,
      noiseSum: 0,
      noiseCount: 0,
    };
    this._sttRt = rt;
    this._sttLastNode = null; // frischer Vorwaerts-Anker pro Aufnahme-Session

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
      if (!rt.stopping && this.$store.stt.recording) {
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
    this.$store.stt.recording = true;
    this.$store.stt.pending = false;
    // Einfüge-Anker bestimmen: hat der User bewusst per Klick einen Caret im
    // Edit-Feld gesetzt (sttCaretUserSet) und steht dieser noch im Editor, wird
    // dort eingefügt (nur sichtbar scrollen). Sonst — z. B. blosser Mic-Klick
    // ohne Caret-Platzierung — hängt das Diktat ans Editorende an.
    if (this.$store.stt.caretUserSet && this._sttCaretInEditor()) {
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
    if (!rt || !this.$store.stt.recording) return;
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
          rt.threshold = this._computeNoiseThreshold(rt.noiseSum / rt.noiseCount, this.$store.stt.vad.threshold);
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
      silenceMs: this.$store.stt.vad.silenceMs,
      maxSegmentS: this.$store.stt.vad.maxSegmentS,
    });
    if (decision.voiced) { rt.hasVoice = true; rt.lastVoiceTs = now; }

    // Absatz-Erkennung: erstes Sprechen nach einem silence-Cut -> Gesamtpause
    // messen (silenceMs vor dem Cut + Luecke bis jetzt). Ist sie deutlich
    // laenger als eine normale Sprechpause, wird die vorausgehende Grenze von
    // 'sentence' auf 'paragraph' hochgestuft (neuer Absatz statt nur ". ").
    if (decision.voiced && rt.silenceCutAt != null && rt.boundaryKindForNext === 'sentence') {
      const totalPause = (now - rt.silenceCutAt) + this.$store.stt.vad.silenceMs;
      if (totalPause >= this.$store.stt.vad.silenceMs * STT_PARAGRAPH_FACTOR) {
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
    this.$store.stt.transcribing++;
    this.$store.stt.busy = true;
    if (this._sttBusyTimer) { clearTimeout(this._sttBusyTimer); this._sttBusyTimer = null; }
  },
  _sttBusyOff() {
    this.$store.stt.transcribing = Math.max(0, this.$store.stt.transcribing - 1);
    if (this.$store.stt.transcribing > 0) return;
    if (this._sttBusyTimer) clearTimeout(this._sttBusyTimer);
    this._sttBusyTimer = setTimeout(() => { this.$store.stt.busy = false; this._sttBusyTimer = null; }, 600);
  },

  _sttStop() {
    const rt = this._sttRt;
    this.$store.stt.recording = false;
    this.$store.stt.pending = false;
    this.$store.stt.busy = false;
    this.$store.stt.transcribing = 0;
    if (this._sttBusyTimer) { clearTimeout(this._sttBusyTimer); this._sttBusyTimer = null; }
    if (!rt) return;
    rt.stopping = true;
    // Laufende Transkriptions-Requests + Retry-Waits abbrechen (kein Insert nach
    // dem Stop). Bewusst VOR rec.stop(): der finale onstop koennte sonst noch ein
    // Segment mit gueltigem Signal senden.
    try { rt.abort.abort(); } catch { /* noop */ }
    if (rt.vadTimer) { clearInterval(rt.vadTimer); rt.vadTimer = null; }
    try { if (rt.rec.state === 'recording') rt.rec.stop(); } catch { /* noop */ }
    try { rt.stream.getTracks().forEach(t => t.stop()); } catch { /* noop */ }
    try { rt.source.disconnect(); } catch { /* noop */ }
    try { rt.audioCtx.close(); } catch { /* noop */ }
    this._sttRt = null;
    this._sttLastNode = null;
  },

  // Range fuer die naechste Einfuegung. Bevorzugt den Vorwaerts-Anker
  // (`_sttLastNode`): Caret direkt HINTER dem zuletzt diktierten Knoten. So
  // bewegt sich die Einfuegestelle nur vorwaerts. Die Live-Selection ist
  // unzuverlaessig — der Browser kollabiert/resettet sie nach laengeren Pausen
  // an den Editoranfang, was den Caret „nach oben" springen liesse. Nur fuer
  // das ERSTE Segment (kein Anker) wird die Live-Selection (vom User bewusst
  // gesetzter Caret bzw. der Start-Anker ans Ende) honoriert, sonst Editorende.
  _sttResolveRange() {
    const editEl = this._getEditEl?.();
    if (!editEl) return null;
    if (this._sttLastNode && editEl.contains(this._sttLastNode)) {
      const range = document.createRange();
      range.setStartAfter(this._sttLastNode);
      range.collapse(true);
      return range;
    }
    const sel = document.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      if (editEl === r.commonAncestorContainer || editEl.contains(r.commonAncestorContainer)) return r;
    }
    const range = document.createRange();
    range.selectNodeContents(editEl);
    range.collapse(false);
    return range;
  },

  // ── Segment-Upload + Insert ───────────────────────────────────────────────

  // Transkribiert ein Segment und fuegt es ein. Der Fetch startet sofort (mehrere
  // Segmente transkribieren parallel), die EINFUEGUNG wird aber ueber
  // `rt.insertChain` in Sende-Reihenfolge serialisiert — so landet ein frueher
  // gesprochenes Segment auch dann vor einem spaeteren im Text, wenn dessen
  // Transkript (z. B. nach einem Retry) erst spaeter zurueckkommt. Der Guard
  // `this._sttRt === rt` verwirft Inserts, deren Session inzwischen beendet oder
  // gewechselt wurde (Stop, Seitenwechsel).
  _sttSendSegment(blob, mime, boundaryKind) {
    const rt = this._sttRt;
    if (!rt) return;
    this._sttBusyOn(); // Indikator „transkribiert" (mit Mindest-Standzeit)
    const fetchP = this._sttFetchTranscript(blob, mime, 0, rt.abort.signal)
      .finally(() => this._sttBusyOff());
    rt.insertChain = rt.insertChain
      .then(async () => {
        const text = await fetchP;
        if (text == null) return; // Fehler/Abbruch bereits behandelt (Toast/Stop)
        if (this._sttRt !== rt) return; // Session beendet -> nicht mehr einfuegen
        this._sttInsertText(text, boundaryKind);
      })
      .catch(() => { /* ein fehlgeschlagener Insert darf die Kette nicht brechen */ });
  },

  // Transkribiert ein Segment; gibt den Text zurueck oder null (Fehler bereits
  // behandelt). Transiente Fehler (Netzwerk-Throw, 408/5xx) werden bis zu
  // STT_MAX_RETRY-mal wiederholt, bevor der Fehler-Toast kommt — ein kurzer
  // Upstream-Haenger kostet so keinen Satz. 404 (Feature aus) und 4xx
  // (z. B. 413/415) werden NICHT wiederholt. `signal` (Session-AbortController)
  // beendet Request UND Retry-Wait sofort und still beim Stop — ein
  // abgebrochenes Segment liefert `null` ohne Fehler-Toast.
  async _sttFetchTranscript(blob, mime, attempt, signal) {
    if (signal?.aborted) return null; // Session beendet -> still verwerfen
    const params = new URLSearchParams();
    if (this.$store.nav.selectedBookId) params.set('bookId', this.$store.nav.selectedBookId);
    if (this.currentPage?.id) params.set('pageId', this.currentPage.id);
    const qs = params.toString() ? `?${params}` : '';
    let res;
    try {
      res = await fetch(`/stt/transcribe${qs}`, {
        method: 'POST',
        headers: { 'Content-Type': mime },
        body: blob,
        signal,
      });
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return null; // Stop -> kein Toast/Retry
      if (attempt < STT_MAX_RETRY) {
        await this._sttDelay(this._sttRetryDelay(attempt), signal);
        return this._sttFetchTranscript(blob, mime, attempt + 1, signal);
      }
      this._sttToastFailed();
      return null;
    }
    if (res.status === 404) { this._sttStop(); return null; } // Feature serverseitig aus
    // 401 = Session abgelaufen: der globale fetch-Wrapper (app.js) hat bereits
    // den Session-Banner ausgeloest. Hier nur die Aufnahme stoppen (logged-out =
    // kein Diktat) — KEIN Fehler-Toast (der Banner kommuniziert es) und keine
    // Toast-Flut pro Folgesegment. Analog zum 404-Zweig.
    if (res.status === 401) { this._sttStop(); return null; }
    if (!res.ok) {
      if (STT_RETRYABLE_STATUS.has(res.status) && attempt < STT_MAX_RETRY) {
        await this._sttDelay(this._sttRetryDelay(attempt), signal);
        return this._sttFetchTranscript(blob, mime, attempt + 1, signal);
      }
      this._sttToastFailed();
      return null;
    }
    // 200 mit kaputtem Body (Server-/Proxy-Fehler): nicht stumm verwerfen.
    // Bei Abort waehrend des Body-Reads aber still bleiben (Stop).
    try {
      return (await res.json())?.text || '';
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError') return null;
      this._sttToastFailed();
      return null;
    }
  },

  // Exponentieller Backoff fuer den Retry-Wait: base * 2^attempt, gedeckelt.
  // Gibt dem Backend bei Last/Cold-Start zunehmend Zeit, statt es zu hetzen.
  _sttRetryDelay(attempt) {
    return Math.min(STT_RETRY_DELAY_MS * (2 ** attempt), STT_RETRY_MAX_DELAY_MS);
  },

  // Verzoegerung fuer Retry-Waits; loest beim Abort der Session sofort auf, damit
  // ein laufender Retry-Wait das Stoppen nicht um STT_RETRY_DELAY_MS verzoegert
  // (der Aufrufer verwirft danach via `signal.aborted`-Guard).
  _sttDelay(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal?.addEventListener?.('abort', () => { clearTimeout(t); resolve(); }, { once: true });
    });
  },

  _sttToastFailed() {
    this._showJobToast?.({ message: this.t('stt.error.failed'), severity: 'err', jobType: 'stt', bookId: null });
  },

  _sttInsertText(text, boundaryKind) {
    const clean = this._normalizeTranscript(text);
    if (!clean) return; // leerer/Whitespace-Transkript -> nichts einfuegen
    if (this._isLikelyHallucination(clean)) return; // Whisper-Geisterphrase -> verwerfen
    this._trackSttChars?.(clean.length); // Diktat-Tracking: diktierte Zeichen buchen
    if (boundaryKind === 'paragraph') { this._sttInsertParagraph(clean); return; }
    const range = this._sttResolveRange();
    if (!range) return;
    const sel = document.getSelection();
    let prevChar = this._sttCharBefore(range);
    // Beginnt das Segment mit Satzzeichen und steht davor schon ein Leerzeichen,
    // dieses entfernen (kein „Wort , dann").
    if (range.collapsed && this._computeEatPrevSpace(prevChar, clean) && this._sttDeletePrevWhitespace(range)) {
      prevChar = this._sttCharBefore(range);
    }
    const prevText = this._sttTextBefore(range);
    const node = document.createTextNode(this._computeSpacedInsert(prevText, clean));
    range.deleteContents();
    range.insertNode(node);
    this._sttLastNode = node; // Vorwaerts-Anker auf den frisch eingefuegten Knoten
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
    const range = this._sttResolveRange();
    if (!range) return;
    const sel = document.getSelection();

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

    // Vorwaerts-Anker auf den Textknoten IM neuen Absatz, damit das naechste
    // Segment innerhalb dieses `<p>` weiterschreibt (nicht dahinter am Root).
    this._sttLastNode = p.firstChild || p;
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
