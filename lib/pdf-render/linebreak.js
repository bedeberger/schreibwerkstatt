'use strict';
// Zeilenumbruch des eigenen Layouters: Runs → Tokens → Zeilen mit vorgemessenen
// Breiten. Gezeichnet und paginiert wird in justify.js; dieses Modul entscheidet
// nur, welches Wort auf welche Zeile kommt.
//
// Geteilt von Fliesstext, Überschriften, Listen, Gedichten/Code, Initialen-
// Absatz (dropcap.js) und Fussnotenapparat (footnotes.js) — EIN Umbruch, damit
// Silbentrennung, Notenmarker und Überlänge-Behandlung überall gleich wirken.

const { _runFontKey } = require('./fonts');
const { measureText } = require('./measure');

const SHY = '­';
const SHY_RE = new RegExp(SHY, 'g');

// Schliessende Interpunktion, die nie allein umbrechen und nie einen justierten
// Wortabstand vor sich bekommen darf.
const CLINGING_PUNCT = /^[.,;:!?…·)\]}»›”’%‰]+$/;

// Notbruch-Stellen für überlange Wörter ohne Trennstelle (URLs, Pfade,
// Komposita mit Bindestrich): NACH diesen Zeichen darf umbrochen werden, ohne
// dass ein Trennstrich dazukommt.
const EMERGENCY_BREAK_CHARS = new Set(['/', '-', '.', '?', '&', '=', '_', '–', '—']);

// Hochstellung (Notenziffern des Anmerkungsapparats). Zwei Groessen statt einer
// echten OpenType-Variante: `sups` haben die wenigsten Google-Fonts, und eine
// fehlende Glyphe waere im PDF eine Leerstelle mitten im Satz. Skalierte Ziffern
// funktionieren in jeder Schrift.
//
// 0.62 / 0.34 sind die ueblichen Werte fuer Werksatz: klein genug, um nicht als
// Fliesstext gelesen zu werden, gross genug zum Lesen; die Grundlinie hebt sich
// um gut ein Drittel der Schriftgroesse, sodass die Ziffer unter der Oberlaenge
// bleibt und die Zeilenhoehe nicht sprengt.
const SUP_SCALE = 0.62;
const SUP_RISE = 0.34;

/** Schriftgroesse eines Runs — hochgestellte kleiner als der Fliesstext. */
function _sizeFor(style, sizePt) {
  return style && style.sup ? sizePt * SUP_SCALE : sizePt;
}

/** Font-Key eines Tokens. `plainFont` (Überschriften): die Rolle hat keine
 *  registrierten Varianten, dann trägt jeder Run den Basis-Schnitt. */
function _fontKeyOf(style, o) {
  if (o && o.plainFont) return o.fontKeyBase || 'body';
  return _runFontKey(style || {}, (o && o.fontKeyBase) || 'body');
}

function _styleSig(s) {
  if (!s) return '||||';
  return `${s.bold ? 1 : 0}|${s.italic ? 1 : 0}|${s.underline ? 1 : 0}|${s.sup ? 1 : 0}|${s.link || ''}`;
}

// Runs → flache Item-Liste: Wörter, Leerzeichen (je mit Herkunfts-Style, damit
// Unterstrich/Link innerhalb eines mehrwortigen Runs durchgezogen wird) und
// harte Umbrüche (\n aus <br>). Mehrfach-Whitespace kollabiert, führende/
// abschliessende Leerzeichen fallen weg.
function _tokenize(runs) {
  const raw = [];
  for (const r of runs) {
    if (r.text === '\n') { raw.push({ br: true }); continue; }
    for (const part of String(r.text || '').split(/(\s+)/)) {
      if (part === '') continue;
      if (/^\s+$/.test(part)) raw.push({ space: true, style: r });
      else raw.push({ word: part, style: r });
    }
  }
  const out = [];
  for (const it of raw) {
    if (it.space) {
      const last = out[out.length - 1];
      if (!last || last.space || last.br) continue; // führende/doppelte Spaces droppen
    }
    out.push(it);
  }
  while (out.length && out[out.length - 1].space) out.pop();
  // ── Klebe-Regeln ───────────────────────────────────────────────────────────
  // Zwei Fälle, in denen zwei benachbarte Wort-Tokens NICHT durch einen
  // Zeilenumbruch getrennt werden dürfen. Ergebnis ist jeweils ein
  // VERBUND-Token (`parts`), das jeden Teil mit seinem EIGENEN Style behält —
  // die Teile werden nur gemeinsam umbrochen, nicht gemeinsam formatiert.
  //
  //   1. Schliessende Interpunktion (typisch der Punkt nach </em>/<strong>/</a>)
  //      stammt aus einem eigenen Run. Ungeklebt landet sie als einzelner Punkt
  //      auf der neuen Zeile bzw. bekommt im Blocksatz eine Lücke davor. Ein
  //      dazwischenliegendes (mitformatiertes) Leerzeichen wird verworfen.
  //
  //   2. Eine hochgestellte Notenziffer (`sup`, siehe lib/endnotes.js), der
  //      unmittelbar — ohne Leerzeichen — ein Wort vorausging. Ungeklebt rutscht
  //      die Ziffer allein auf die Folgezeile; ist das ein SEITENumbruch, steht
  //      sie auf einer anderen Seite als ihre Note. Ein vom Autor gesetztes
  //      Leerzeichen vor dem Marker bleibt dagegen respektiert (dann kein Kleben).
  const glued = [];
  for (const it of out) {
    if (it.word && CLINGING_PUNCT.test(it.word)) {
      if (glued.length && glued[glued.length - 1].space) glued.pop();
      const prev = glued[glued.length - 1];
      if (prev && (prev.word || prev.parts)) { glued[glued.length - 1] = _glue(prev, it); continue; }
    }
    if (it.word && it.style && it.style.sup) {
      const prev = glued[glued.length - 1];
      if (prev && (prev.word || prev.parts)) { glued[glued.length - 1] = _glue(prev, it); continue; }
    }
    glued.push(it);
  }
  return glued;
}

/** Noten-IDs, die eine fertig umbrochene Zeile traegt, in Reihenfolge.
 *  Verbund-Tokens werden aufgefaltet — sonst entgeht genau der geklebte Marker. */
function noteIdsOfLine(line) {
  const out = [];
  for (const it of line.items || []) {
    for (const p of it.parts || [it]) {
      const id = p.style && p.style.noteId;
      if (Number.isInteger(id) && !out.includes(id)) out.push(id);
    }
  }
  return out;
}

/** Teile eines Tokens als Liste — ein einfaches Wort ist ein Ein-Teil-Verbund. */
function _parts(it) {
  return it.parts ? it.parts : [{ text: it.word, style: it.style }];
}

/** Zwei Tokens zu einem unteilbaren Verbund zusammenfassen. `style` bleibt der
 *  des ERSTEN Teils, damit Aufrufer, die nur `it.style` lesen (Silbentrennung),
 *  etwas Sinnvolles bekommen; gerendert wird jeder Teil mit seinem eigenen. */
function _glue(prev, next) {
  const parts = [..._parts(prev), ..._parts(next)];
  return { parts, word: parts.map(p => p.text).join(''), style: parts[0].style };
}

// Wörter, die nicht nach Sprachregeln getrennt werden: Links und alles, was wie
// eine Adresse aussieht. Die bekommen direkt den Notbruch.
function _isUrlLike(word, style) {
  return !!(style && style.link) || /[/@]|:\/\/|^www\./i.test(word);
}

// Versucht, ein zu langes Wort per Silbentrennung so zu teilen, dass ein
// Präfix + Bindestrich noch in `maxWidth` passt. Gibt { head, tail } zurück
// (head inkl. '-') oder null, wenn keine Trennstelle passt.
function _tryHyphenate(doc, word, style, maxWidth, o) {
  if (!o.hyphenate || maxWidth <= 0 || _isUrlLike(word, style)) return null;
  const hy = o.hyphenate(word);
  if (!hy || hy.indexOf(SHY) < 0) return null;
  const fontKey = _fontKeyOf(style, o);
  const size = _sizeFor(style, o.sizePt);
  let best = null;
  for (let i = 0; i < hy.length; i++) {
    if (hy[i] !== SHY) continue;
    const head = hy.slice(0, i).replace(SHY_RE, '') + '-';
    const w = measureText(doc, head, fontKey, size);
    if (w <= maxWidth) best = { i, head };
    else break; // Präfixe werden nur länger → abbrechen
  }
  if (!best) return null;
  const tail = hy.slice(best.i + 1).replace(SHY_RE, '');
  if (!tail) return null;
  return { head: best.head, tail };
}

// Notbruch eines Worts, das allein breiter ist als die Zeile: erst an der
// letzten passenden Notbruch-Stelle (nach '/', '-', '.', '?', '&' …), sonst hart
// nach Zeichen. Liefert { head, tail } mit nicht-leerem head (Fortschritt ist
// garantiert: im schlimmsten Fall ein Zeichen pro Zeile) oder null, wenn das
// Wort nicht teilbar ist (ein Zeichen).
function _emergencyBreak(doc, word, style, maxWidth, o) {
  const chars = Array.from(word);
  if (chars.length < 2) return null;
  const fontKey = _fontKeyOf(style, o);
  const size = _sizeFor(style, o.sizePt);
  // Längstes passendes Präfix nach Zeichen (binäre Suche über die Länge).
  let lo = 1, hi = chars.length - 1, fit = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (measureText(doc, chars.slice(0, mid).join(''), fontKey, size) <= maxWidth) { fit = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (fit < 1) fit = 1;
  // Innerhalb des passenden Präfixes die letzte Notbruch-Stelle suchen — aber
  // nur, wenn sie nicht absurd früh liegt (sonst lieber hart brechen).
  for (let i = fit; i >= Math.max(1, Math.floor(fit / 3)); i--) {
    if (EMERGENCY_BREAK_CHARS.has(chars[i - 1]) && i < chars.length) {
      return { head: chars.slice(0, i).join(''), tail: chars.slice(i).join('') };
    }
  }
  return { head: chars.slice(0, fit).join(''), tail: chars.slice(fit).join('') };
}

/** Greedy-Zeilenumbruch. Liefert Zeilen mit vorgemessenen Item-Breiten.
 *
 *  Breite pro Zeile: `indentFor(lineIdx)` (falls gesetzt) überschreibt
 *  `firstIndent` (Zeile 0) / `hangIndent` (Folgezeilen). Gebraucht vom Initialen-
 *  Absatz, dessen erste N Zeilen neben dem Initial schmaler laufen. */
function _breakLines(doc, items, o) {
  const { sizePt, totalWidth, firstIndent = 0, hangIndent = 0 } = o;
  const indentFor = typeof o.indentFor === 'function'
    ? o.indentFor
    : (li) => (li === 0 ? firstIndent : hangIndent);
  const lines = [];
  let cur = [];
  let width = 0;      // natürliche Breite (Wörter + Leerzeichen, ohne ws)
  let spaces = 0;
  let avail = totalWidth - indentFor(0);

  const flush = (forced) => {
    while (cur.length && cur[cur.length - 1].space) { const s = cur.pop(); width -= s.w; spaces--; }
    if (cur.length || forced) lines.push({ items: cur, width, spaces, forced });
    cur = []; width = 0; spaces = 0;
    avail = totalWidth - indentFor(lines.length);
  };

  // Breite eines Tokens. Ein Verbund (`parts`) wird teilweise gemessen — jeder
  // Teil in SEINER Schrift und Groesse — und die Teilbreiten werden am Teil
  // gemerkt, damit _renderLine sie nicht neu messen muss.
  const itemWidth = (it) => {
    if (!it.parts) return measureText(doc, it.word, _fontKeyOf(it.style, o), _sizeFor(it.style, sizePt));
    let w = 0;
    for (const p of it.parts) {
      p.w = measureText(doc, p.text, _fontKeyOf(p.style, o), _sizeFor(p.style, sizePt));
      w += p.w;
    }
    return w;
  };

  const pushSplit = (it, part) => {
    const w = measureText(doc, part.head, _fontKeyOf(it.style, o), _sizeFor(it.style, sizePt));
    cur.push({ word: part.head, style: it.style, w, hyphenated: true }); width += w;
    flush(false);
    place({ word: part.tail, style: it.style }); // Rest auf neuer Zeile (ggf. erneut teilen)
  };

  const place = (it) => {
    const w = itemWidth(it);
    if (width + w <= avail) { cur.push({ ...it, w }); width += w; return; }
    if (cur.length === 0) {
      // Allein auf der Zeile und trotzdem zu breit (URL, Kompositum, Pfad):
      // erst Silbentrennung, dann Notbruch — sonst ragt es über den Rand.
      if (!it.parts) {
        const part = _tryHyphenate(doc, it.word, it.style, avail - 0.01, o)
          || _emergencyBreak(doc, it.word, it.style, avail - 0.01, o);
        if (part) { pushSplit(it, part); return; }
      }
      cur.push({ ...it, w }); width += w; return;
    }
    // Silbentrennung nur fuer einfache Woerter — ein Verbund ist per Definition
    // unteilbar (sonst waere das Kleben sinnlos).
    const hy = it.parts ? null : _tryHyphenate(doc, it.word, it.style, avail - width - 0.01, o);
    if (hy) { pushSplit(it, hy); return; }
    // Wort, das auch auf einer eigenen Zeile nicht passt (URL): gleich hier
    // anbrechen, statt die laufende Zeile kurz stehen zu lassen.
    if (!it.parts && w > totalWidth - indentFor(lines.length + 1)) {
      const part = _emergencyBreak(doc, it.word, it.style, avail - width - 0.01, o);
      if (part && Array.from(part.head).length >= 4
          && measureText(doc, part.head, _fontKeyOf(it.style, o), _sizeFor(it.style, sizePt)) <= avail - width) {
        pushSplit(it, part); return;
      }
    }
    flush(false);
    place(it);
  };

  for (const it of items) {
    if (it.br) { flush(true); continue; }
    if (it.space) {
      if (!cur.length) continue;
      const w = measureText(doc, ' ', _fontKeyOf(it.style, o), _sizeFor(it.style, sizePt));
      cur.push({ space: true, style: it.style, w }); width += w; spaces++;
      continue;
    }
    place(it);
  }
  flush(true); // Schlusszeile
  return lines;
}

module.exports = {
  _tokenize, _breakLines, _styleSig, _sizeFor, _fontKeyOf, _glue, _parts, noteIdsOfLine,
  _tryHyphenate, _emergencyBreak, SUP_SCALE, SUP_RISE, SHY,
};
