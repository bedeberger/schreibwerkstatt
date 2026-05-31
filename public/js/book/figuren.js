// Figurenübersicht-Methoden am Root-Spread (von vielen Modulen via
// $root.loadFiguren() gerufen). Die eigentliche Extraktion läuft als Teil
// von POST /jobs/komplett-analyse.

import { fetchJson } from '../utils.js';

const _VALID_TYPES = new Set(['hauptfigur', 'nebenfigur', 'antagonist', 'mentor', 'randfigur', 'andere']);

export function _cleanStr(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '–' || s === '—' || s === 'n/a' || s === 'N/A') return null;
  return s;
}

// Umschliessende Anführungszeichen entfernen: Das Display wrappt Zitate selbst
// mit «…» (figuren.html, Prompt-Kontext). Liefert die KI das Zitat bereits in
// Original-Interpunktion mit Gänsefüsschen, gäbe das sonst ««…»». Idempotent.
const _QUOTE_PAIRS = [['«', '»'], ['„', '“'], ['“', '”'], ['‚', '‘'], ['‘', '’'], ['"', '"'], ["'", "'"]];
export function _stripQuotes(v) {
  let s = _cleanStr(v);
  if (!s) return s;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of _QUOTE_PAIRS) {
      if (s.length > open.length + close.length - 1 && s.startsWith(open) && s.endsWith(close)) {
        s = s.slice(open.length, s.length - close.length).trim();
        changed = true;
        break;
      }
    }
  }
  return s || null;
}

// Strukturierter Entwicklungsbogen: leere Felder bereinigen; null wenn nichts übrig.
function _sanitizeArc(arc) {
  if (!arc || typeof arc !== 'object') return null;
  const anfang = _cleanStr(arc.anfang);
  const ende = _cleanStr(arc.ende);
  const wendepunkte = (Array.isArray(arc.wendepunkte) ? arc.wendepunkte : []).map(_cleanStr).filter(Boolean);
  const typ = _cleanStr(arc.typ);
  if (!anfang && !ende && !wendepunkte.length && !typ) return null;
  return { typ: typ || '', anfang: anfang || '', wendepunkte, ende: ende || '' };
}

export function _sanitizeFigur(f) {
  return {
    ...f,
    typ: _VALID_TYPES.has(f.typ) ? f.typ : 'andere',
    kurzname: _cleanStr(f.kurzname),
    beruf: _cleanStr(f.beruf),
    wohnadresse: _cleanStr(f.wohnadresse),
    beschreibung: _cleanStr(f.beschreibung),
    geburtstag: _cleanStr(f.geburtstag),
    geschlecht: _cleanStr(f.geschlecht),
    sozialschicht: _cleanStr(f.sozialschicht),
    praesenz: _cleanStr(f.praesenz),
    rolle: _cleanStr(f.rolle),
    motivation: _cleanStr(f.motivation),
    konflikt: _cleanStr(f.konflikt),
    aeusseres: _cleanStr(f.aeusseres),
    stimme: _cleanStr(f.stimme),
    hintergrund: _cleanStr(f.hintergrund),
    entwicklung: _cleanStr(f.entwicklung),
    arc: _sanitizeArc(f.arc),
    erste_erwaehnung: _cleanStr(f.erste_erwaehnung),
    schluesselzitate: (f.schluesselzitate || []).map(_stripQuotes).filter(Boolean).slice(0, 5),
    eigenschaften: (f.eigenschaften || []).map(_cleanStr).filter(Boolean),
    lebensereignisse: (f.lebensereignisse || []).map(ev => ({
      ...ev,
      datum: _cleanStr(ev.datum),
      ereignis: _cleanStr(ev.ereignis),
      kapitel: _cleanStr(ev.kapitel),
      seite: _cleanStr(ev.seite),
      bedeutung: _cleanStr(ev.bedeutung),
    })).filter(ev => ev.ereignis || ev.datum),
    beziehungen: (f.beziehungen || []).map(bz => ({
      ...bz,
      beschreibung: _cleanStr(bz.beschreibung),
    })),
  };
}

export const figurenMethods = {
  async loadFiguren(bookId, { signal } = {}) {
    try {
      const data = await fetchJson('/figures/' + bookId, { signal });
      this.figuren = (data?.figuren || []).map(_sanitizeFigur);
      this.figurenUpdatedAt = data?.updated_at || null;
      this._figurLookupIndex = null;
      this._buildGlobalZeitstrahl();
    } catch (e) {
      if (e?.name === 'AbortError') return;
      console.error('[loadFiguren]', e);
    }
  },

  async saveFiguren() {
    try {
      const r = await fetch('/figures/' + this.selectedBookId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figuren: this.figuren }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.error('[saveFiguren]', e);
    }
  },
};
