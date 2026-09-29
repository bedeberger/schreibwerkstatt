// Erscheinungsdatum einer Quelle (`sources.issued_date`): Eingabe in eine
// ISO-partielle Form bringen — `YYYY`, `YYYY-MM` oder `YYYY-MM-DD`.
//
// Pure, ohne DOM: Formular (Live-Vorschau), Formatierer (format/styles.js) und —
// ueber den CJS-Spiegel lib/issued-date.js — der synchrone DB-Schreibpfad
// verstehen dieselben Schreibweisen. Der Spiegel existiert nur, weil
// db/sources/shared.js synchron schreibt und ESM nur asynchron laden kann;
// tests/unit/issued-date-drift.test.mjs haelt beide deckungsgleich.
//
// Akzeptiert: ISO (auch mit `/` wie im RIS-Feld DA: „2024/03/12/"),
// „12.3.2024", „12. März 2024", „March 12, 2024", „12 March 2024", „März 2024".
// Alles andere ist `null` — der Aufrufer entscheidet, ob das ein Fehler ist.

const MONTHS = {
  jan: 1, januar: 1, january: 1, jaenner: 1, 'jänner': 1,
  feb: 2, februar: 2, february: 2,
  mar: 3, 'mär': 3, maerz: 3, 'märz': 3, march: 3,
  apr: 4, april: 4,
  mai: 5, may: 5,
  jun: 6, juni: 6, june: 6,
  jul: 7, juli: 7, july: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oct: 10, oktober: 10, october: 10,
  nov: 11, november: 11,
  dez: 12, dec: 12, dezember: 12, december: 12,
};

function _month(word) {
  return MONTHS[String(word || '').toLowerCase().replace(/\.$/, '')] || null;
}

function _pad(n) { return String(n).padStart(2, '0'); }

function _build(y, m, d) {
  const year = Number(y), month = m == null ? null : Number(m), day = d == null ? null : Number(d);
  if (!Number.isInteger(year) || year < 1000 || year > 2999) return null;
  if (month == null) return String(year);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  if (day == null) return `${year}-${_pad(month)}`;
  const max = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!Number.isInteger(day) || day < 1 || day > max) return null;
  return `${year}-${_pad(month)}-${_pad(day)}`;
}

/** Eingabe → `YYYY` | `YYYY-MM` | `YYYY-MM-DD`, sonst null. */
export function parseIssuedDate(raw) {
  const s = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let m;
  // ISO bzw. RIS: 2024 | 2024-03 | 2024-03-12 | 2024/03/12/ | 2024/03// | 2024-03-12T…
  if ((m = /^(\d{4})(?:[-/](\d{0,2})(?:[-/](\d{0,2}))?)?(?:[-/]|T.*)?$/.exec(s))) {
    return _build(m[1], m[2] || null, m[2] && m[3] ? m[3] : null);
  }
  // 12.3.2024 / 12.03.2024
  if ((m = /^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})$/.exec(s))) return _build(m[3], m[2], m[1]);
  // 12. März 2024 / 12 March 2024
  if ((m = /^(\d{1,2})\.? ([A-Za-zÄäÖöÜü]+\.?) (\d{4})$/.exec(s))) {
    const mo = _month(m[2]);
    return mo ? _build(m[3], mo, m[1]) : null;
  }
  // March 12, 2024
  if ((m = /^([A-Za-zÄäÖöÜü]+\.?) (\d{1,2}),? (\d{4})$/.exec(s))) {
    const mo = _month(m[1]);
    return mo ? _build(m[3], mo, m[2]) : null;
  }
  // März 2024 / March 2024
  if ((m = /^([A-Za-zÄäÖöÜü]+\.?) (\d{4})$/.exec(s))) {
    const mo = _month(m[1]);
    return mo ? _build(m[2], mo, null) : null;
  }
  return null;
}

/** ISO-partiell → { year, month|null, day|null }, oder null. */
export function issuedParts(iso) {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(iso ?? '').trim());
  if (!m) return null;
  return { year: m[1], month: m[2] ? Number(m[2]) : null, day: m[3] ? Number(m[3]) : null };
}
