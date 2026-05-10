'use strict';
// Font-Bootstrapping + PDF/A-Glyph-Sanitizer. Lädt alle Rollen-Fonts (body,
// heading, title, subtitle, byline) inkl. Body-Bold/Italic-Variants und patcht
// doc.text, damit ungültige Codepoints (PDF/A-2 verbietet .notdef-Verweise)
// vor jedem Write gefiltert werden.

const { fetchFont } = require('../font-fetch');
const logger = require('../../logger');

// Lädt + registriert alle benötigten Font-Variants. Pdfkit erwartet einen
// eindeutigen Namen pro Variant. Body-Font wird zusätzlich in italic + bold
// vorgeladen (für strong/em im Fließtext).
async function _registerFonts(doc, font) {
  const tasks = [];
  const reg = (key, family, weight, style) => {
    tasks.push((async () => {
      const ttf = await fetchFont(family, weight, style);
      doc.registerFont(key, ttf);
    })());
  };

  // Body-Familie braucht Bold / Italic / BoldItalic für Inline-Style.
  reg('body',           font.body.family, font.body.weight, 'normal');
  // Bold/italic-Variants nur, wenn vom Family-Set unterstützt; sonst fallback
  // auf Body — das `_safeReg` regelt fallthrough.
  const safeReg = (key, family, weight, style) => {
    tasks.push((async () => {
      try {
        const ttf = await fetchFont(family, weight, style);
        doc.registerFont(key, ttf);
      } catch (e) {
        logger.warn(`pdf-render: font ${family} ${weight} ${style} unavailable (${e.message}); fallback registered`);
        // Fallback: dieselbe Font wie Body.
        const ttf = await fetchFont(font.body.family, font.body.weight, 'normal');
        doc.registerFont(key, ttf);
      }
    })());
  };
  // Heuristik für italic/bold-Verfügbarkeit: probieren, fallback in safeReg.
  safeReg('body-bold',        font.body.family, Math.min(900, font.body.weight + 300), 'normal');
  safeReg('body-italic',      font.body.family, font.body.weight, 'italic');
  safeReg('body-bolditalic',  font.body.family, Math.min(900, font.body.weight + 300), 'italic');

  reg('heading',  font.heading.family,  font.heading.weight,  'normal');
  reg('title',    font.title.family,    font.title.weight,    'normal');
  reg('subtitle', font.subtitle.family, font.subtitle.weight, 'normal');
  reg('byline',   font.byline.family,   font.byline.weight,   'normal');

  await Promise.all(tasks);
}

// PDF/A-2 verbietet Verweise auf das .notdef-Glyph (ISO 19005-2 6.2.11.8).
// Pdfkit emittiert diesen Verweis, sobald ein Codepoint nicht in der Font
// liegt. Wir filtern Strings vor jedem doc.text-Call gegen die aktuell
// aktive Font: bekannte Substitutionen (Soft-Hyphen → drop), NFKD-Fallback
// für Diakritika ohne Glyph (ḿ → m, ń → n), als letztes silent-drop.
const _GLYPH_SUBSTITUTE = new Map([
  [0x00AD, ''], // SOFT HYPHEN — visuell unsichtbar, einfach entfernen
]);

function _sanitizeAgainstFont(doc, s) {
  if (typeof s !== 'string' || !s) return s;
  const f = doc._font && doc._font.font;
  if (!f || typeof f.glyphForCodePoint !== 'function') return s;
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out += ch; continue; }
    const g = f.glyphForCodePoint(cp);
    if (g && g.id !== 0) { out += ch; continue; }
    if (_GLYPH_SUBSTITUTE.has(cp)) { out += _GLYPH_SUBSTITUTE.get(cp); continue; }
    // NFKD: Basiszeichen + Combining Marks; Marks droppen, Basis behalten falls vorhanden
    const decomp = ch.normalize('NFKD');
    let any = '';
    for (const dc of decomp) {
      const dcp = dc.codePointAt(0);
      if (dcp >= 0x0300 && dcp <= 0x036F) continue;
      const dg = f.glyphForCodePoint(dcp);
      if (dg && dg.id !== 0) any += dc;
    }
    out += any;
  }
  return out;
}

function _patchDocTextSanitizer(doc) {
  const orig = doc.text.bind(doc);
  doc.text = function patchedText(text, ...rest) {
    if (typeof text === 'string') text = _sanitizeAgainstFont(doc, text);
    return orig(text, ...rest);
  };
}

function _runFontKey(run) {
  if (run.bold && run.italic) return 'body-bolditalic';
  if (run.bold)   return 'body-bold';
  if (run.italic) return 'body-italic';
  return 'body';
}

module.exports = { _registerFonts, _sanitizeAgainstFont, _patchDocTextSanitizer, _runFontKey };
