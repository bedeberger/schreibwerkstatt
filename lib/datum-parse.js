// Datums-Parser für Zeitstrahl-Events. Fallback wenn KI / Legacy-Daten keine
// strukturierten Felder liefern. Zerlegt Freitext wie "Mai 1850", "1849-12-03",
// "12.03.1850", "Tag 3", "500 v. Chr." in { year, month, day, story_tag, label }.
//
// Rückgabe: Objekt mit optionalen Feldern. `label` ist immer der getrimmte
// Original-String. Nicht erkannte Inputs liefern `{ label }` ohne weitere Felder.

const DE_MONTHS = {
  jan: 1, januar: 1, jän: 1, jaenner: 1, 'jänner': 1,
  feb: 2, februar: 2,
  mar: 3, 'mär': 3, 'märz': 3, maerz: 3, 'maer': 3,
  apr: 4, april: 4,
  mai: 5,
  jun: 6, juni: 6,
  jul: 7, juli: 7,
  aug: 8, august: 8,
  sep: 9, sept: 9, september: 9,
  okt: 10, oktober: 10,
  nov: 11, november: 11,
  dez: 12, dezember: 12,
};
const EN_MONTHS = {
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  may: 5,
};
const MONTHS = { ...DE_MONTHS, ...EN_MONTHS };

// Liefert den Monatsindex (1–12) für einen rohen Token oder null.
function _matchMonth(token) {
  if (!token) return null;
  const t = String(token).toLowerCase().replace(/\.$/, '').trim();
  return MONTHS[t] || null;
}

function _clampMonth(m)  { return Number.isInteger(m) && m >= 1 && m <= 12 ? m : null; }
function _clampDay(d)    { return Number.isInteger(d) && d >= 1 && d <= 31 ? d : null; }

/**
 * @param {*} input  Freitext (string oder convertibles).
 * @returns {{ year?: number, month?: number, day?: number, story_tag?: number, label: string }}
 */
function parseDatum(input) {
  if (input == null) return { label: '' };
  const raw = String(input).trim();
  if (!raw) return { label: '' };
  const out = { label: raw };
  const s = raw.toLowerCase();

  // 1) Story-Tag: "Tag 3", "Day 12"
  const tag = s.match(/^(?:tag|day)\s+(\d{1,4})\b/);
  if (tag) {
    out.story_tag = parseInt(tag[1], 10);
    return out;
  }

  // 2) ISO: YYYY-MM-DD oder YYYY-MM (führendes Minus optional für BCE)
  const iso = s.match(/^(-?\d{1,5})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (iso) {
    out.year  = parseInt(iso[1], 10);
    const m   = _clampMonth(parseInt(iso[2], 10));
    if (m) out.month = m;
    if (iso[3]) {
      const d = _clampDay(parseInt(iso[3], 10));
      if (d) out.day = d;
    }
    return out;
  }

  // 3) DD.MM.YYYY / DD.MM.YY / DD.MM.
  const dmy = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/);
  if (dmy) {
    out.day   = _clampDay(parseInt(dmy[1], 10))   || undefined;
    out.month = _clampMonth(parseInt(dmy[2], 10)) || undefined;
    let y = parseInt(dmy[3], 10);
    if (y < 100) y += 2000;
    out.year = y;
    if (out.day == null) delete out.day;
    if (out.month == null) delete out.month;
    return out;
  }
  const dm = s.match(/^(\d{1,2})\.(\d{1,2})\.?$/);
  if (dm) {
    const d = _clampDay(parseInt(dm[1], 10));
    const m = _clampMonth(parseInt(dm[2], 10));
    if (d) out.day = d;
    if (m) out.month = m;
    return out;
  }

  // 4) Vor-Christus: "500 v. Chr.", "500 v.Chr", "300 BCE", "200 BC"
  const bce = s.match(/(\d{1,5})\s*(?:v\.?\s*chr\.?|bce\b|bc\b|n\s*chr\s*−?)/);
  if (bce) {
    out.year = -parseInt(bce[1], 10);
    // Monat/Tag aus Resttext extrahieren (selten, aber möglich)
    const m = _findMonthName(s);
    if (m) out.month = m;
    return out;
  }

  // 5) Monatsname-Heuristik: "Mai 1850", "12. März 1850", "May 5, 1850"
  const m = _findMonthName(s);
  if (m) {
    out.month = m;
    // Jahr suchen (3–5 Stellen Zahl ist Jahr; bevorzugt 4-stellig)
    const yr4 = s.match(/\b(\d{4,5})\b/);
    if (yr4) out.year = parseInt(yr4[1], 10);
    // Tag: erste 1–2-stellige Zahl die nicht das Jahr ist und <=31
    const nums = s.match(/\b\d{1,4}\b/g) || [];
    for (const n of nums) {
      if (n.length > 2) continue;
      const v = parseInt(n, 10);
      if (v >= 1 && v <= 31 && v !== out.year) {
        out.day = v;
        break;
      }
    }
    return out;
  }

  // 6) Reines Jahr: "1850", "1850er", "ca. 1850", "anno 1850"
  const yr = s.match(/\b(\d{3,5})\b/);
  if (yr) {
    out.year = parseInt(yr[1], 10);
    return out;
  }

  // 7) Nichts erkannt → nur Label
  return out;
}

function _findMonthName(s) {
  // Tokens mit Wortgrenze; greift auch abgekürzte Formen mit Punkt.
  // Reihenfolge wichtig: längere Varianten zuerst probieren.
  const tokens = Object.keys(MONTHS).sort((a, b) => b.length - a.length);
  for (const tok of tokens) {
    // Boundary: vorne Wortgrenze, hinten optionaler Punkt + Wortgrenze
    const re = new RegExp(`(?:^|[^a-zäöü])${_escape(tok)}\\.?(?:$|[^a-zäöü])`, 'i');
    if (re.test(s)) return MONTHS[tok];
  }
  return null;
}

function _escape(t) {
  return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { parseDatum };
