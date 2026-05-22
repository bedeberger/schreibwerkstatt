// Anführungszeichen-Normalisierer für Notebook- + Focus-Editor.
//
// Walk über Blöcke des Edit-Roots; ersetzt gerade `"` / `'` durch
// typografische Varianten gemäss Buch-Locale (book_settings.language +
// region). Apostroph zwischen Buchstaben/Ziffern → U+2019.
// Skip: <pre>, <code>, <script>, <style>.
//
// Klassifikation rein kontextbasiert — kein Open/Close-State. Jeder Quote
// wird anhand der Nachbarschaftszeichen (prev/next) eigenständig entschieden;
// ein einzelner ungerader Quote vergiftet nicht alle folgenden.
//
// Zwei Scopes: `normalizeQuotes(rootEl, style)` für Page-weit (Slash-Item
// Notebook + Focus-Topbar), `normalizeQuotesInRange(range, style)` für eine
// Selection-Range (Bubble-Toolbar Notebook).

const STYLES = {
  // Schweiz / Liechtenstein: Guillemets aussen, Single-Guillemets innen
  'de-CH': { ldquo: '«', rdquo: '»', lsquo: '‹', rsquo: '›', apostrophe: '’' },
  'de-LI': { ldquo: '«', rdquo: '»', lsquo: '‹', rsquo: '›', apostrophe: '’' },
  // Deutschland / Österreich: „…" aussen, ‚…' innen
  'de-DE': { ldquo: '„', rdquo: '“', lsquo: '‚', rsquo: '‘', apostrophe: '’' },
  'de-AT': { ldquo: '„', rdquo: '“', lsquo: '‚', rsquo: '‘', apostrophe: '’' },
  // English: "…" / '…'
  'en':    { ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', apostrophe: '’' },
  // Französisch: « … », ‹ … ›  (NBSP innen)
  'fr':    { ldquo: '« ', rdquo: ' »', lsquo: '‹ ', rsquo: ' ›', apostrophe: '’' },
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
  if (l === 'de') return STYLES['de-DE'];
  if (l === 'it') return STYLES['it-IT'];
  return DEFAULT_STYLE;
}

const BLOCK_SEL = 'p, h1, h2, h3, h4, h5, h6, blockquote, li, td, th, div.poem';
const SKIP_SEL  = 'pre, code, script, style';

const LETTER_DIGIT = /[\p{L}\p{N}]/u;
// Öffnungs-Kontext: Whitespace, Klammer-auf, Gedankenstrich, bereits gesetzte
// öffnende Quote-Varianten (für nested „...'...'").
const OPEN_CTX  = /[\s({\[–—\-«‹„‚“‘]/;
// Schliess-Kontext: Whitespace, Klammer-zu, Satzzeichen, bereits gesetzte
// schliessende Quote-Varianten.
const CLOSE_CTX = /[\s)\]}.,;:!?»›"”’]/;

function _isLetterDigit(ch) {
  return !!ch && LETTER_DIGIT.test(ch);
}

function _classifyDouble(prev, next, style) {
  const prevOpen  = !prev || OPEN_CTX.test(prev);
  const nextClose = !next || CLOSE_CTX.test(next);
  // Eindeutige Fälle
  if (prevOpen && !nextClose) return style.ldquo;   // ` "Wort` → öffnend
  if (!prevOpen && nextClose) return style.rdquo;   // `Wort" ` → schliessend
  // Ambig: beide oder keiner — prev-Seite gibt den Ausschlag
  if (prevOpen) return style.ldquo;
  return style.rdquo;
}

function _classifySingle(prev, next, style) {
  const prevLD = _isLetterDigit(prev);
  const nextLD = _isLetterDigit(next);
  if (prevLD && nextLD) return style.apostrophe;    // `don't`
  const prevOpen  = !prev || OPEN_CTX.test(prev);
  const nextClose = !next || CLOSE_CTX.test(next);
  if (prevOpen && !nextClose) return style.lsquo;   // ` 'Wort`
  if (!prevOpen && nextClose) return style.rsquo;   // `Wort' `
  // Ambig (z.B. `kids' ` mit prevLD && nextClose) → Apostroph als sicherste Wahl
  if (prevLD) return style.apostrophe;
  if (prevOpen) return style.lsquo;
  return style.apostrophe;
}

// Eigene Walk-Logik statt TreeWalker — linkedom (Unit-Test-Umgebung)
// ignoriert den acceptNode-Filter und würde Text-Nodes in <pre>/<code>
// fälschlich mit-transformieren.
function _collectTextNodes(root, skipSel, out) {
  for (let n = root.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 3) {
      const parent = n.parentElement;
      if (parent && parent.closest(skipSel)) continue;
      out.push(n);
    } else if (n.nodeType === 1) {
      if (n.matches && n.matches(skipSel)) continue;
      _collectTextNodes(n, skipSel, out);
    }
  }
}

// Liefert das erste Zeichen, das `nodeIdx+1..end` an Text-Nodes hat. Damit
// kann ein Quote am Ende eines Text-Nodes seinen next-Kontext aus dem
// nächsten Geschwister-Text-Node lesen (z.B. `"<strong>foo</strong>"`).
function _peekNext(textNodes, nodeIdx) {
  for (let k = nodeIdx + 1; k < textNodes.length; k++) {
    const s = textNodes[k].nodeValue;
    if (s && s.length) return s[0];
  }
  return '';
}

function _normalizeBlock(blockEl, style) {
  const textNodes = [];
  _collectTextNodes(blockEl, SKIP_SEL, textNodes);
  if (!textNodes.length) return 0;

  let count = 0;
  let prevChar = '';

  for (let nodeIdx = 0; nodeIdx < textNodes.length; nodeIdx++) {
    const node = textNodes[nodeIdx];
    const s = node.nodeValue;
    if (!s) continue;
    let out = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c !== '"' && c !== "'") {
        out += c;
        prevChar = c;
        continue;
      }
      const next = i + 1 < s.length ? s[i + 1] : _peekNext(textNodes, nodeIdx);
      const repl = c === '"'
        ? _classifyDouble(prevChar, next, style)
        : _classifySingle(prevChar, next, style);
      out += repl;
      count++;
      prevChar = repl[repl.length - 1] || c;
    }
    if (out !== s) node.nodeValue = out;
  }
  return count;
}

export function normalizeQuotes(rootEl, style) {
  if (!rootEl || !style) return 0;
  let blocks = Array.from(rootEl.querySelectorAll(BLOCK_SEL));
  blocks = blocks.filter(b => !blocks.some(other => other !== b && other.contains(b)));
  if (!blocks.length) blocks = [rootEl];
  let total = 0;
  for (const b of blocks) total += _normalizeBlock(b, style);
  return total;
}

// Selection-Scope-Variante: nur Zeichen innerhalb von `range` werden
// transformiert. Zeichen ausserhalb der Range werden nicht mutiert, dienen
// aber als prev/next-Kontext für Klassifikation an den Range-Grenzen.
export function normalizeQuotesInRange(range, style) {
  if (!range || range.collapsed || !style) return 0;
  const anchor = range.commonAncestorContainer;
  const common = anchor.nodeType === 1 ? anchor : anchor.parentElement;
  if (!common) return 0;

  const all = [];
  _collectTextNodes(common, SKIP_SEL, all);
  if (!all.length) return 0;

  let count = 0;
  let prevChar = '';

  for (let nodeIdx = 0; nodeIdx < all.length; nodeIdx++) {
    const node = all[nodeIdx];
    const s = node.nodeValue;
    if (!s) continue;

    if (!range.intersectsNode(node)) {
      // Ausserhalb der Range: nichts ändern, prevChar aber fortschreiben für
      // Kontext der nächsten in-Range-Node.
      prevChar = s[s.length - 1];
      continue;
    }

    const startOff = node === range.startContainer ? range.startOffset : 0;
    const endOff   = node === range.endContainer   ? range.endOffset   : s.length;
    if (startOff >= endOff) {
      if (s.length) prevChar = s[s.length - 1];
      continue;
    }

    let out = '';
    if (startOff > 0) {
      out = s.slice(0, startOff);
      prevChar = out[out.length - 1];
    }
    for (let i = startOff; i < endOff; i++) {
      const c = s[i];
      if (c !== '"' && c !== "'") {
        out += c;
        prevChar = c;
        continue;
      }
      const next = i + 1 < s.length ? s[i + 1] : _peekNext(all, nodeIdx);
      const repl = c === '"'
        ? _classifyDouble(prevChar, next, style)
        : _classifySingle(prevChar, next, style);
      out += repl;
      count++;
      prevChar = repl[repl.length - 1] || c;
    }
    if (endOff < s.length) {
      out += s.slice(endOff);
      prevChar = out[out.length - 1];
    }
    if (out !== s) node.nodeValue = out;
  }
  return count;
}

// Lädt Buch-Locale + ruft die passende Normalize-Variante auf. Gemeinsamer
// Aufrufer für Notebook-Slash, Bubble-Selection und Focus-Topbar.
export async function runQuoteNormalize({ bookId, rootEl, range = null }) {
  if (!bookId || !rootEl) return { ok: false, count: 0 };
  let style;
  try {
    const r = await fetch(`/booksettings/${bookId}`, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    style = resolveQuoteStyle(data.language, data.region);
  } catch (e) {
    console.error('[quote-normalize] booksettings fetch failed', e);
    return { ok: false, count: 0 };
  }
  const count = range
    ? normalizeQuotesInRange(range, style)
    : normalizeQuotes(rootEl, style);
  return { ok: true, count };
}

export const __test__ = { STYLES, _normalizeBlock, _classifyDouble, _classifySingle };
