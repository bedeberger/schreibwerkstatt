'use strict';

// Datums-Erkennung fuer Folder-Import. Versucht aus Pfad-Kontext (Jahr, Monat)
// und Filename ein ISO-Datum YYYY-MM-DD abzuleiten.
// Regel-basierte Heuristik mit Confidence-Score. AI-Fallback liefert das
// Caller-Modul (folder-import-Worker), wenn confidence < threshold.

const MONTHS_DE = {
  januar: 1, jan: 1, jaenner: 1,
  februar: 2, feb: 2,
  maerz: 3, mar: 3, mrz: 3,
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
  const t = _norm(token);
  if (MONTHS_DE[t]) return MONTHS_DE[t];
  if (MONTHS_EN[t]) return MONTHS_EN[t];
  const n = parseInt(t, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 12) return n;
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

module.exports = { detectDate, scoreSample, parseMonthToken, PATTERNS };
