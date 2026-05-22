// Anführungszeichen-Normalisierer für den Notebook-Editor.
//
// Walk über Blöcke des Edit-Roots; ersetzt gerade `"` / `'` durch
// typografische Varianten gemäss Buch-Locale (book_settings.language +
// region). Apostroph zwischen Buchstaben/Ziffern → U+2019.
// Skip: <pre>, <code>, <script>, <style>.
//
// Open/Close-State wird pro Block (p/h1-h6/li/blockquote/td/div.poem)
// zurückgesetzt — Quotes überspannen praktisch nie Block-Grenzen, und der
// Reset macht den State robust gegen ungerade Quotes weiter oben im Doc.

const STYLES = {
  // Schweiz / Liechtenstein: Guillemets aussen, Single-Guillemets innen
  'de-CH': { ldquo: '«', rdquo: '»', lsquo: '‹', rsquo: '›', apostrophe: '’' },
  'de-LI': { ldquo: '«', rdquo: '»', lsquo: '‹', rsquo: '›', apostrophe: '’' },
  // Deutschland / Österreich: „…" aussen, ‚…' innen
  'de-DE': { ldquo: '„', rdquo: '“', lsquo: '‚', rsquo: '‘', apostrophe: '’' },
  'de-AT': { ldquo: '„', rdquo: '“', lsquo: '‚', rsquo: '‘', apostrophe: '’' },
  // English: "…" / '…'
  'en':    { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', apostrophe: '’' },
  // Französisch: « … », ‹ … ›  (NBSP innen)
  'fr':    { ldquo: '« ', rdquo: ' »', lsquo: '‹ ', rsquo: ' ›', apostrophe: '’' },
  // Italienisch (Italien): «…» aussen, "…" innen
  'it-IT': { ldquo: '«', rdquo: '»', lsquo: '“', rsquo: '”', apostrophe: '’' },
};

const DEFAULT_STYLE = STYLES['de-CH'];

export function resolveQuoteStyle(language, region) {
  const l = (language || '').toLowerCase();
  const r = (region || '').toUpperCase();
  if (l && r) {
    const tag = `${l}-${r}`;
    if (STYLES[tag]) return STYLES[tag];
  }
  if (l && STYLES[l]) return STYLES[l];
  // Sprach-Fallbacks ohne explizite Region
  if (l === 'de') return STYLES['de-DE'];
  if (l === 'it') return STYLES['it-IT'];
  return DEFAULT_STYLE;
}

const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, td, th, div.poem';
const SKIP_SEL  = 'pre, code, script, style';

const LETTER_DIGIT = /[\p{L}\p{N}]/u;

function _isLetterDigit(ch) {
  return !!ch && LETTER_DIGIT.test(ch);
}

// Eigene Walk-Logik statt TreeWalker — linkedom (Unit-Test-Umgebung)
// ignoriert den acceptNode-Filter und würde Text-Nodes in <pre>/<code>
// fälschlich mit-transformieren.
function _collectTextNodes(root, skipSel, out) {
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      // Text-Node: Skip wenn ein Vorfahre matcht.
      const parent = n.parentElement;
      if (parent && parent.closest(skipSel)) continue;
      out.push(n);
    } else if (n.nodeType === 1) {
      const el = n;
      if (el.matches && el.matches(skipSel)) continue;
      _collectTextNodes(el, skipSel, out);
    }
  }
}

function _normalizeBlock(blockEl, style) {
  const textNodes = [];
  _collectTextNodes(blockEl, SKIP_SEL, textNodes);

  let openDouble = false;
  let openSingle = false;
  let prevChar = '';
  let count = 0;

  for (const node of textNodes) {
    const s = node.nodeValue;
    if (!s) continue;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"') {
        if (!openDouble) { out += style.ldquo; openDouble = true; }
        else             { out += style.rdquo; openDouble = false; }
        count++;
        prevChar = out[out.length - 1];
        continue;
      }
      if (c === "'") {
        const prev = i > 0 ? s[i - 1] : prevChar;
        const next = i + 1 < s.length ? s[i + 1] : '';
        const prevLD = _isLetterDigit(prev);
        const nextLD = _isLetterDigit(next);
        let repl;
        if (prevLD && nextLD)        repl = style.apostrophe;        // don't
        else if (openSingle)         { repl = style.rsquo; openSingle = false; }
        else if (!prevLD && nextLD)  { repl = style.lsquo; openSingle = true; }
        else                         repl = style.apostrophe;        // kids' / 'twas
        out += repl;
        count++;
        prevChar = out[out.length - 1];
        continue;
      }
      out += c;
      prevChar = c;
    }
    if (out !== s) node.nodeValue = out;
  }
  return count;
}

export function normalizeQuotes(rootEl, style) {
  if (!rootEl || !style) return 0;
  let blocks = Array.from(rootEl.querySelectorAll(BLOCK_SEL));
  // Nested blocks (z.B. <li><p>): nur den äusseren behalten, sonst doppelter Walk.
  blocks = blocks.filter(b => !blocks.some(other => other !== b && other.contains(b)));
  if (!blocks.length) blocks = [rootEl];
  let total = 0;
  for (const b of blocks) total += _normalizeBlock(b, style);
  return total;
}

export const __test__ = { STYLES, _normalizeBlock };
