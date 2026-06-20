'use strict';

// Namens-/Konsistenz-Waechter: erkennt buchweite Schreibvarianten/Tippfehler von
// Eigennamen (Figuren + Orte) rein regelbasiert — kein KI-Call. Verankert auf den
// kanonischen Namens-Stamm (figures.name/kurzname, locations.name): ein Token wird
// nur dann als Variante gemeldet, wenn es einem bekannten Namen nahe ist (Damerau-
// Levenshtein), nicht selbst ein bekannter Name ist und keine deutsche Flexionsform.
//
// Praezision statt Recall: drei Faellen-Schutz im Deutschen —
//   1. Flexion: "Stefans"/"Annas"/"Muellern" (Genitiv/Dativ/Plural) ist KEIN Tippfehler.
//   2. Kurznamen (<4 Zeichen): Edit-Distance 1 matcht zu viel ("Tom"~"von") → kein Fuzzy.
//   3. Frequenz: "Stefann" (2x) neben "Stefan" (200x) ist hochkonfident; gleich haeufige
//      Varianten sind niedrigkonfident (koennten zwei reale Namen sein).
//
// Pure Funktionen, server-seitig (routes/name-guard.js) + unit-getestet.

// Deutsche Flexions-Suffixe an Eigennamen: Genitiv -s/-ns/-es, schwache/Dativ/Plural
// -n/-en/-e. Konservativ gehalten — die mehrdeutigen -in/-innen (Movierung) bewusst
// NICHT, weil sie die Bedeutung aendern und bei Namen kaum auftreten.
const INFLECTION_SUFFIXES = Object.freeze(['s', 'n', 'e', 'en', 'ns', 'es']);

// Partikel, die in mehrteiligen Namen vorkommen, aber keine eigenstaendigen Anker
// sein duerfen (sonst wuerden Allerweltswoerter zu Treffern). Klein geschrieben →
// faellt ohnehin durch den Capitalized-Filter; hier zur Sicherheit explizit.
const NAME_PARTICLES = new Set(['von', 'van', 'de', 'der', 'den', 'des', 'die', 'das',
  'zu', 'zur', 'zum', 'am', 'im', 'auf', 'aus', 'la', 'le', 'di', 'da', 'del', 'und']);

const MIN_ANCHOR_LEN = 4;   // kuerzere Namensteile → kein Fuzzy (zu viele Falsch-Positive)
const MIN_TOKEN_LEN = 3;

// Damerau-Levenshtein (mit Transposition) inkl. Early-Exit ab Schwelle `max`.
// Liefert eine Zahl > max, sobald klar ist, dass die Distanz max ueberschreitet.
function damerauLevenshtein(a, b, max = Infinity) {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  if (al === 0) return bl;
  if (bl === 0) return al;

  // Drei rollende Zeilen: prev2 (i-2), prev (i-1), cur (i) — prev2 fuer Transposition.
  let prev2 = new Array(bl + 1);
  let prev = new Array(bl + 1);
  let cur = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    const ai = a[i - 1];
    for (let j = 1; j <= bl; j++) {
      const cost = ai === b[j - 1] ? 0 : 1;
      let v = Math.min(
        prev[j] + 1,        // Loeschung
        cur[j - 1] + 1,     // Einfuegung
        prev[j - 1] + cost, // Substitution
      );
      if (i > 1 && j > 1 && ai === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1); // Transposition
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // ganze Zeile ueber Schwelle → abbrechen
    const tmp = prev2; prev2 = prev; prev = cur; cur = tmp;
  }
  return prev[bl];
}

// Edit-Distance-Schwelle abhaengig von der Ankerlaenge.
function thresholdFor(len) {
  if (len < MIN_ANCHOR_LEN) return 0;
  if (len <= 7) return 1;
  return 2;
}

// Umlaut-/ß-Transliteration falten: ü→ue etc. Damit werden die im Deutschen
// haeufigsten Schreibvarianten (Müller/Mueller, Zürich/Zuerich, Straße/Strasse)
// erkannt, obwohl ihre rohe Edit-Distance (2) ueber der Laengen-Schwelle liegt.
function foldUmlaut(s) {
  return s
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

// Best-Match-Distanz zwischen Token und Anker (beide klein). Liefert die rohe
// Damerau-Levenshtein-Distanz, wenn innerhalb der Laengen-Schwelle ODER wenn die
// umlaut-gefaltete Form passt; sonst Infinity. `len` = Ankerlaenge (roh).
function matchDistance(key, anchorLower, len) {
  const max = thresholdFor(len);
  if (max === 0) return Infinity;
  if (Math.abs(key.length - anchorLower.length) <= max) {
    const d = damerauLevenshtein(key, anchorLower, max);
    if (d <= max) return d;
  }
  const fk = foldUmlaut(key);
  const fa = foldUmlaut(anchorLower);
  if (fk === key && fa === anchorLower) return Infinity; // keine Umlaute beteiligt
  const fmax = thresholdFor(fa.length);
  if (Math.abs(fk.length - fa.length) <= fmax && damerauLevenshtein(fk, fa, fmax) <= fmax) {
    // Display-Distanz aus der rohen Form (uneingeschraenkt) — aussagekraeftiger.
    return damerauLevenshtein(key, anchorLower);
  }
  return Infinity;
}

// Pruefe, ob `token` eine deutsche Flexionsform von `name` ist (token = name + Suffix).
// Beide bereits klein geschrieben. Gleichheit zaehlt ebenfalls als "Flexion" (= der
// Name selbst, keine Variante).
function isInflectedForm(token, name) {
  if (token === name) return true;
  if (token.length <= name.length) return false;
  if (!token.startsWith(name)) return false;
  const suffix = token.slice(name.length);
  if (!INFLECTION_SUFFIXES.includes(suffix)) return false;
  // Verdoppelter Endbuchstabe (Stefan→Stefann) ist ein Tippfehler, keine Flexion:
  // ein einbuchstabiges Suffix, das den letzten Namensbuchstaben wiederholt, faellt raus.
  if (suffix.length === 1 && suffix === name[name.length - 1]) return false;
  return true;
}

// Anker aus dem Namens-Stamm extrahieren. `names` = Array von Strings (figures.name,
// figures.kurzname, locations.name). Mehrteilige Namen werden an Whitespace/Bindestrich
// in Teile zerlegt; behalten werden grossgeschriebene Teile ab MIN_ANCHOR_LEN, die kein
// Partikel sind. Dedup case-insensitiv (Display = erste gesehene Schreibweise).
function extractAnchors(names) {
  const byKey = new Map();
  for (const raw of names || []) {
    if (!raw || typeof raw !== 'string') continue;
    const parts = raw.split(/[\s\-–—/]+/u).filter(Boolean);
    for (const part of parts) {
      const cleaned = part.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
      if (cleaned.length < MIN_ANCHOR_LEN) continue;
      if (!/^\p{Lu}/u.test(cleaned)) continue;
      const lower = cleaned.toLowerCase();
      if (NAME_PARTICLES.has(lower)) continue;
      if (!byKey.has(lower)) byKey.set(lower, cleaned);
    }
  }
  return [...byKey.entries()].map(([lower, display]) => ({ lower, display, len: lower.length }));
}

// Token-Frequenztabelle aus Freitext. Liefert Map<lowerKey, { count, display }>.
// Display bevorzugt eine grossgeschriebene Variante (Eigenname-Heuristik).
function tokenize(text) {
  const counts = new Map();
  const re = /\p{L}[\p{L}'’.-]*\p{L}|\p{L}/gu;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const tok = m[0];
    const key = tok.toLowerCase();
    let entry = counts.get(key);
    if (!entry) { entry = { count: 0, display: tok, hasUpper: false }; counts.set(key, entry); }
    entry.count++;
    const upper = /^\p{Lu}/u.test(tok);
    if (upper && !entry.hasUpper) { entry.display = tok; entry.hasUpper = true; }
  }
  return counts;
}

function classifyConfidence(canonicalCount, variantCount, minDistance) {
  // Variante haeufiger als der "kanonische" Name → unsicher (evtl. zwei reale Namen,
  // oder der Stamm-Eintrag ist die seltenere Schreibweise).
  if (variantCount >= canonicalCount) return 'niedrig';
  if (canonicalCount < 3) return 'niedrig';
  if (minDistance <= 2 && variantCount <= Math.max(2, canonicalCount * 0.15)) return 'hoch';
  return 'mittel';
}

// Kernfunktion. Optionen:
//   names    — Array kanonischer Namen/Kurznamen/Orte (Strings)
//   text     — gesamter Buchtext (plain)
//   ignores  — Array von { canonical, variant } (klein-egal), die unterdrueckt werden
// Rueckgabe: { clusters: [{ canonical, canonicalCount, confidence, variants:[{form,count,distance}] }] }
function detectNameVariants({ names = [], text = '', ignores = [] } = {}) {
  const anchors = extractAnchors(names);
  if (!anchors.length) return { clusters: [] };

  const counts = tokenize(text);
  const anchorSet = new Set(anchors.map(a => a.lower));
  // Alle bekannten Namens-Tokens (auch <MIN_ANCHOR_LEN) als "ist ein echter Name" sperren.
  const knownNames = new Set();
  for (const raw of names || []) {
    if (!raw || typeof raw !== 'string') continue;
    for (const part of raw.split(/[\s\-–—/]+/u)) {
      const cleaned = part.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '').toLowerCase();
      if (cleaned) knownNames.add(cleaned);
    }
  }

  const ignoreSet = new Set();
  for (const ig of ignores || []) {
    if (ig && ig.variant) ignoreSet.add(String(ig.variant).toLowerCase());
  }

  // Pro Anker die Token-Frequenz nachschlagen (kanonische Haeufigkeit).
  const anchorCount = new Map();
  for (const a of anchors) anchorCount.set(a.lower, counts.get(a.lower)?.count || 0);

  // Kandidaten-Token → bester Anker.
  const clustersByCanonical = new Map();

  for (const [key, entry] of counts) {
    if (key.length < MIN_TOKEN_LEN) continue;
    if (!entry.hasUpper) continue;            // Eigennamen sind grossgeschrieben
    if (anchorSet.has(key)) continue;         // ist selbst ein Anker
    if (knownNames.has(key)) continue;        // ist ein anderer bekannter Name(steil)
    if (ignoreSet.has(key)) continue;         // vom User akzeptiert

    // Flexionsform irgendeines Ankers → legitim, nie melden.
    let inflected = false;
    for (const a of anchors) {
      if (isInflectedForm(key, a.lower)) { inflected = true; break; }
    }
    if (inflected) continue;

    // Besten Anker innerhalb der Schwelle finden (inkl. Umlaut-Faltung).
    let best = null;
    for (const a of anchors) {
      const d = matchDistance(key, a.lower, a.len);
      if (!Number.isFinite(d)) continue;
      if (!best || d < best.distance ||
          (d === best.distance && (anchorCount.get(a.lower) || 0) > (anchorCount.get(best.lower) || 0))) {
        best = { lower: a.lower, display: a.display, distance: d };
      }
    }
    if (!best) continue;

    let cluster = clustersByCanonical.get(best.lower);
    if (!cluster) {
      cluster = { canonical: best.display, canonicalCount: anchorCount.get(best.lower) || 0, variants: [] };
      clustersByCanonical.set(best.lower, cluster);
    }
    cluster.variants.push({ form: entry.display, count: entry.count, distance: best.distance });
  }

  const clusters = [];
  for (const cluster of clustersByCanonical.values()) {
    cluster.variants.sort((a, b) => b.count - a.count || a.distance - b.distance);
    const variantCount = cluster.variants.reduce((s, v) => s + v.count, 0);
    const minDistance = cluster.variants.reduce((m, v) => Math.min(m, v.distance), Infinity);
    cluster.confidence = classifyConfidence(cluster.canonicalCount, variantCount, minDistance);
    clusters.push(cluster);
  }

  const confRank = { hoch: 0, mittel: 1, niedrig: 2 };
  clusters.sort((a, b) =>
    (confRank[a.confidence] - confRank[b.confidence]) || (b.canonicalCount - a.canonicalCount) ||
    a.canonical.localeCompare(b.canonical));

  return { clusters };
}

module.exports = {
  detectNameVariants,
  // Fuer Tests exportiert:
  damerauLevenshtein,
  isInflectedForm,
  extractAnchors,
  tokenize,
  thresholdFor,
  classifyConfidence,
  INFLECTION_SUFFIXES,
};
