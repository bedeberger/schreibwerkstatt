'use strict';
// Pure Satz-Segmentierung + Chunking fuer das Vorlesen (TTS / Proof-Listening).
// SSoT, geteilt zwischen dem Notebook-Proof-Listening (Alpine-Root,
// editor/notebook/tts-proof.js) und dem Share-Reader-Vorlese-Dock (Vanilla,
// share-reader/tts.js). Keine DOM-/Browser-Abhaengigkeit ausser Intl.Segmenter
// (mit Regex-Fallback) — ohne Browser testbar.
//
// Warum die zwei Chunk-Korrektive: sehr kurze Eingaben lassen XTTS-v2 am
// Satzende einen erfundenen Restlaut anhaengen (Kurz-Input-Halluzination) →
// Kurz-Satz-Buendelung. Sehr lange Saetze ergaeben einen Request mit
// zweistelliger Synthese-Latenz (naehert sich dem 20s-Server-Timeout) + einen
// monoton heruntergelesenen Audio-Block → Lang-Satz-Splitting an Klausel-Grenzen.

// Mindest-Zeichenzahl pro Synthese-Chunk (Kurz-Satz-Buendelung).
export const TTS_MIN_CHUNK_CHARS = 60;
// Hoechst-Zeichenzahl pro Synthese-Chunk (Lang-Satz-Splitting).
export const TTS_MAX_CHUNK_CHARS = 220;

// Satzgrenzen via Intl.Segmenter (handhabt Abkuerzungen wie „z. B." korrekt),
// Fallback Regex split nach .!?. Liefert [start,end]-Offset-Paare in `text`.
export function computeTtsSentences(text, locale = 'de') {
  if (!text || !text.trim()) return [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    try {
      const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
      const out = [];
      for (const s of seg.segment(text)) {
        if (s.segment.trim()) out.push([s.index, s.index + s.segment.length]);
      }
      return out;
    } catch { /* fallthrough */ }
  }
  const out = [];
  const re = /[^.!?]+[.!?]*\s*/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

// Kurze Satz-Ranges (in `text`) zu Chunks >= minLen buendeln. Ein anwachsender
// Chunk schluckt Folgesaetze, bis seine getrimmte Laenge die Schwelle erreicht;
// ein zu kurzer Rest am Ende wird in den Vorgaenger gezogen. `maxLen` deckelt das
// Anwachsen, damit die Buendelung die Split-Stuecke nicht wieder ueber die Grenze
// zusammenzieht (Default Infinity = kein Deckel).
export function coalesceTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = Infinity) {
  if (!Array.isArray(ranges) || ranges.length <= 1) return ranges || [];
  const len = ([s, e]) => text.slice(s, e).trim().length;
  const fits = (s, e) => text.slice(s, e).trim().length <= maxLen;
  const merged = [];
  let cur = null;
  for (const [s, e] of ranges) {
    if (!cur) { cur = [s, e]; continue; }
    if (len(cur) < minLen && fits(cur[0], e)) { cur[1] = e; } // zu kurz + passt -> anhaengen
    else { merged.push(cur); cur = [s, e]; }                  // lang genug / wuerde sprengen -> abschliessen
  }
  if (cur) {
    const prev = merged[merged.length - 1];
    if (len(cur) < minLen && prev && fits(prev[0], cur[1])) prev[1] = cur[1];
    else merged.push(cur);
  }
  return merged;
}

// Eine zu lange Satz-Range an Klausel-/Wortgrenzen in Teilstuecke <= maxLen
// zerlegen. Bevorzugt nach dem LETZTEN Klausel-Zeichen im Fenster (; : , oder
// freistehender Gedankenstrich - – —), sonst am letzten Leerzeichen, im Notfall
// hart bei maxLen. Intra-Wort-Bindestriche („Midlife-Krise") bleiben unangetastet.
export function splitLongRange([s, e], text, maxLen = TTS_MAX_CHUNK_CHARS) {
  const out = [];
  let start = s;
  while (e - start > maxLen) {
    const win = text.slice(start, start + maxLen);
    let cut = -1;
    const clause = /[;:,](?=\s|$)|\s[-–—]\s/g;
    let m;
    while ((m = clause.exec(win)) !== null) cut = m.index + m[0].length;
    if (cut <= 0) {
      const sp = win.lastIndexOf(' ');
      cut = sp > 0 ? sp + 1 : maxLen; // kein Trennpunkt -> harter Schnitt
    }
    out.push([start, start + cut]);
    start += cut;
  }
  if (start < e) out.push([start, e]);
  return out;
}

// Satz-Ranges eines Blocks in synthese-taugliche Chunks bringen: erst zu lange
// Saetze splitten, dann zu kurze buendeln (mit maxLen-Deckel).
export function chunkTtsRanges(ranges, text, minLen = TTS_MIN_CHUNK_CHARS, maxLen = TTS_MAX_CHUNK_CHARS) {
  if (!Array.isArray(ranges) || !ranges.length) return ranges || [];
  const split = [];
  for (const r of ranges) {
    if (text.slice(r[0], r[1]).trim().length > maxLen) split.push(...splitLongRange(r, text, maxLen));
    else split.push(r);
  }
  return coalesceTtsRanges(split, text, minLen, maxLen);
}

// Schweizer Guillemets (« ») spricht XTTS als Lautfolge aus statt sie als
// Anfuehrung zu ignorieren. Vor der Synthese auf gerade Anfuehrungszeichen
// normalisieren — rein fuer die Sprachausgabe; angezeigter Text +
// Highlight-Offsets bleiben unveraendert.
export function normalizeForSpeech(text) {
  return text.replace(/[«»]/g, '"').replace(/[‹›]/g, "'");
}
