'use strict';

// Datums-Erkennung fuer Folder-Import. Versucht aus Pfad-Kontext (Jahr, Monat)
// und Filename ein ISO-Datum YYYY-MM-DD abzuleiten.
// Regel-basierte Heuristik mit Confidence-Score. AI-Fallback liefert das
// Caller-Modul (folder-import-Worker), wenn confidence < threshold.

const MONTHS_DE = {
  januar: 1, jan: 1, jaenner: 1,
  februar: 2, feb: 2,
  maerz: 3, marz: 3, mar: 3, mrz: 3,
  april: 4, apr: 4,
  mai: 5,
  juni: 6, jun: 6,
  juli: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, oct: 10,
  november: 11, nov: 11,
  dezember: 12, dez: 12,
};

const MONTHS_EN = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function _stripExt(name) {
  return String(name || '').replace(/\.[a-zA-Z0-9]+$/, '');
}

function _norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ae/g, 'ae')
    .trim();
}

function parseMonthToken(token) {
  if (!token) return null;
  // Tokenize: Whitespace + Trenner. Wir testen erst den ganzen String (Schnellpfad),
  // dann jede Sub-Komponente — "November 2020" findet so "November".
  const wholeNorm = _norm(token);
  if (MONTHS_DE[wholeNorm]) return MONTHS_DE[wholeNorm];
  if (MONTHS_EN[wholeNorm]) return MONTHS_EN[wholeNorm];
  const parts = String(token).split(/[\s.,;:_\-/]+/).filter(Boolean);
  for (const p of parts) {
    const t = _norm(p);
    if (MONTHS_DE[t]) return MONTHS_DE[t];
    if (MONTHS_EN[t]) return MONTHS_EN[t];
  }
  // Zahlen-Fallback nur bei rein-numerischer Eingabe (sonst frisst "16" aus
  // "Persönliches 16" einen Monat — das ist nie gewollt, der Monat kommt aus
  // dem Ordnernamen, nicht aus dem Filename-Tag).
  if (/^\d+$/.test(wholeNorm)) {
    const n = parseInt(wholeNorm, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 12) return n;
  }
  return null;
}

function _pad(n) { return String(n).padStart(2, '0'); }

function _iso(y, m, d) {
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return y + '-' + _pad(m) + '-' + _pad(d);
}

// Pattern-Builder: jeder Pattern liefert (filename, ctx={year, month}) -> ISO oder null
const PATTERNS = [
  {
    name: 'YYYY-MM-DD',
    test: f => /\b(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})\b/.exec(_stripExt(f)),
    resolve: (m) => _iso(+m[1], +m[2], +m[3]),
  },
  {
    name: 'DD-MM-YYYY',
    test: f => /\b(\d{1,2})[-_.](\d{1,2})[-_.](\d{4})\b/.exec(_stripExt(f)),
    resolve: (m) => _iso(+m[3], +m[2], +m[1]),
  },
  {
    name: 'YYYYMMDD',
    test: f => /\b(\d{4})(\d{2})(\d{2})\b/.exec(_stripExt(f)),
    resolve: (m) => _iso(+m[1], +m[2], +m[3]),
  },
  {
    name: 'DD-monthname',
    test: f => /\b(\d{1,2})[._\-\s]+([A-Za-zÀ-ſ]+)\b/.exec(_stripExt(f)),
    resolve: (m, ctx) => {
      const month = parseMonthToken(m[2]);
      if (!month) return null;
      const y = ctx?.year;
      if (!Number.isFinite(y)) return null;
      return _iso(y, month, +m[1]);
    },
  },
  {
    name: 'monthname-DD',
    test: f => /\b([A-Za-zÀ-ſ]+)[._\-\s]+(\d{1,2})\b/.exec(_stripExt(f)),
    resolve: (m, ctx) => {
      const month = parseMonthToken(m[1]);
      if (!month) return null;
      const y = ctx?.year;
      if (!Number.isFinite(y)) return null;
      return _iso(y, month, +m[2]);
    },
  },
  {
    name: 'DD-only',
    test: f => /^(\d{1,2})$/.exec(_stripExt(f).trim()),
    resolve: (m, ctx) => {
      const y = ctx?.year;
      const mo = ctx?.month;
      if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
      return _iso(y, mo, +m[1]);
    },
  },
  // Letzter Fallback: irgendeine 1-31-Zahl im Filename (z.B. "Persönliches 16.docx"
  // mit ctx Year=2020, Month=11 → 2020-11-16). Aktiviert nur, wenn ctx Jahr UND
  // Monat liefert, und genau eine plausible Tageszahl im stripped Filename steht
  // — sonst zu viele false positives ("Tag 2 Notiz 5" waere ambig).
  {
    name: 'DD-anywhere',
    test: f => {
      const stripped = _stripExt(f);
      const all = [...stripped.matchAll(/\b(\d{1,2})\b/g)].filter(m => {
        const n = +m[1];
        return n >= 1 && n <= 31;
      });
      return all.length === 1 ? all[0] : null;
    },
    resolve: (m, ctx) => {
      const y = ctx?.year;
      const mo = ctx?.month;
      if (!Number.isFinite(y) || !Number.isFinite(mo)) return null;
      return _iso(y, mo, +m[1]);
    },
  },
];

function detectDate(filename, ctx) {
  for (const p of PATTERNS) {
    const m = p.test(filename);
    if (!m) continue;
    const iso = p.resolve(m, ctx);
    if (iso) return { iso, pattern: p.name };
  }
  return null;
}

// Erste Text-Zeile aus HTML extrahieren — fuer Date-Fallback wenn der
// Dateiname kein Datum traegt (z.B. "tag1.docx" und das Datum steht im
// Dokument selbst). Strippt Tags und holt den ersten nicht-leeren Trim.
function firstLineFromHtml(html) {
  if (!html) return '';
  const stripped = String(html).replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ');
  for (const line of stripped.split(/\r?\n/)) {
    const t = line.trim();
    if (t) return t;
  }
  return '';
}

// Datums-Erkennung in einer Text-Zeile (typischerweise erste Zeile des
// Dokuments). Eigene Regex-Sets ohne Extension-Strip (sonst frisst _stripExt
// das ".2024" am Ende einer Datumszeile als Extension).
const TEXT_PATTERNS = [
  {
    name: 'YYYY-MM-DD',
    re: /\b(\d{4})[-_.](\d{1,2})[-_.](\d{1,2})\b/,
    resolve: (m) => _iso(+m[1], +m[2], +m[3]),
  },
  {
    name: 'DD-MM-YYYY',
    re: /\b(\d{1,2})[-_.](\d{1,2})[-_.](\d{4})\b/,
    resolve: (m) => _iso(+m[3], +m[2], +m[1]),
  },
  {
    name: 'YYYYMMDD',
    re: /\b(\d{4})(\d{2})(\d{2})\b/,
    resolve: (m) => _iso(+m[1], +m[2], +m[3]),
  },
  {
    name: 'DD-monthname',
    re: /\b(\d{1,2})[._\-\s]+([A-Za-zÀ-ſ]+)\b/,
    resolve: (m, ctx) => {
      const month = parseMonthToken(m[2]);
      if (!month) return null;
      const y = ctx?.year;
      if (!Number.isFinite(y)) return null;
      return _iso(y, month, +m[1]);
    },
  },
  {
    name: 'monthname-DD',
    re: /\b([A-Za-zÀ-ſ]+)[._\-\s]+(\d{1,2})\b/,
    resolve: (m, ctx) => {
      const month = parseMonthToken(m[1]);
      if (!month) return null;
      const y = ctx?.year;
      if (!Number.isFinite(y)) return null;
      return _iso(y, month, +m[2]);
    },
  },
];

function detectDateInText(text, ctx) {
  const t = String(text || '').trim();
  if (!t) return null;
  for (const p of TEXT_PATTERNS) {
    const m = p.re.exec(t);
    if (!m) continue;
    const iso = p.resolve(m, ctx);
    if (iso) return { iso, pattern: p.name };
  }
  return null;
}

function scoreSample(samples) {
  const counts = new Map();
  for (const s of samples) {
    for (const p of PATTERNS) {
      const m = p.test(s.filename);
      if (!m) continue;
      const iso = p.resolve(m, { year: s.year, month: s.month });
      if (!iso) continue;
      counts.set(p.name, (counts.get(p.name) || 0) + 1);
      break;
    }
  }
  let best = null;
  for (const [name, n] of counts) {
    if (!best || n > best.count) best = { pattern: name, count: n };
  }
  if (!best) return { confidence: 0, pattern: null, total: samples.length };
  return { confidence: best.count / samples.length, pattern: best.pattern, total: samples.length };
}

module.exports = { detectDate, detectDateInText, firstLineFromHtml, scoreSample, parseMonthToken, PATTERNS };
