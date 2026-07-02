'use strict';
// Orte- und Szenen-Matching für die Komplettanalyse — pure Helper, geteilte SSoT
// für Cross-Run-Reconcile (db/schema.js#saveOrteToDb, routes/jobs/komplett/remap.js#
// saveSzenenAndEvents) und Within-Run-Dedup (routes/jobs/komplett/phases/orte.js).
//
// Pendant zu lib/name-normalize.js (Figuren): Figuren haben ein dreistufiges
// Cross-Run-Matching (exakt → Token-Teilmenge+Indizien → Rename-Fallback), Orte/Szenen
// matchten bis dato nur exakt normalisiert → jede Schreibvariante zwischen zwei Läufen
// fiel auf stale und akkumulierte Dubletten. Diese Lib schliesst die Lücke.
//
// Liegt in lib/, weil beide Konsumenten (db/ und routes/) darauf zugreifen, ohne eine
// Layering-Inversion (db/ → routes/) einzuführen.

// Verbindungswörter/Artikel in Ortsnamen, die als Token kein Diskriminator sind.
const LOC_STOPWORDS = new Set([
  'und', 'in', 'an', 'am', 'im', 'bei', 'zur', 'zum', 'auf', 'der', 'die', 'das',
  'den', 'dem', 'von', 'vom', 'zu', 'de', 'la', 'le', 'of', 'the', 'at',
]);

// Bedeutungstragende Ortsnamen-Token: Klammern/Slashes/Satzzeichen entfernt,
// lowercased, Stopwords + Ein-Zeichen-Token raus. «Mathys AG (Bettlach)» →
// [mathys, ag, bettlach]; «EPA / Nordmann Solothurn» → [epa, nordmann, solothurn].
function placeTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[()[\]{}/,;:«»"']/g, ' ')
    .split(/[\s\-.]+/)
    .map(t => t.trim())
    .filter(t => t.length > 1 && !LOC_STOPWORDS.has(t));
}

// Normalisierter Ortsname (exakt-Match-Schlüssel) — SSoT für Orte/Szenen-Matching.
function normLocName(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function _inter(a, b) { return a.filter(t => b.includes(t)); }
function _isSubset(a, b) { return a.length > 0 && a.every(t => b.includes(t)); }

// Ähnlichkeit zweier Orte 0..1 (0 = kein Match). Typ-Gate: klar verschiedene Typen
// (STADT vs. GEBAEUDE) sind nie derselbe Ort. Token-Teilmenge → starkes Signal (ein
// Name ist der andere + Qualifizierer, «Mathys AG (Bettlach)» ⊂ «Mathys AG
// Produktionsstätte Bettlach»). Sonst Jaccard-Overlap ≥ threshold mit ≥2 gemeinsamen
// Token («Dieters Bar (Innenstadt Olten)» ~ «Dieters Bar/Etablissement in Olten»:
// {dieters,bar,olten} geteilt). Verschiedene Städte trennen sich über das Stadt-Token
// ({bahnhof} allein = 1 geteilt < 2 → kein Match).
function locationSimilarity(a, b, { overlapThreshold = 0.5 } = {}) {
  const ta = (a.typ || '').toString().toLowerCase();
  const tb = (b.typ || '').toString().toLowerCase();
  if (ta && tb && ta !== tb && ta !== 'andere' && tb !== 'andere') return 0;
  const A = placeTokens(a.name), B = placeTokens(b.name);
  if (!A.length || !B.length) return 0;
  const shared = _inter(A, B);
  if (!shared.length) return 0;
  if (_isSubset(A, B) || _isSubset(B, A)) return 0.95;
  const union = new Set([...A, ...B]).size;
  const jac = shared.length / union;
  if (shared.length >= 2 && jac >= overlapThreshold) return jac;
  return 0;
}

// Cross-Run-Matching Orte: ordnet jeden neuen Analyse-Ort einer bestehenden DB-Row zu
// (oder null = Neuanlage). Greedy, jede Bestands-Row höchstens einmal.
//   Stufe 1: exakter normalisierter Name.
//   Stufe 2: Token-Teilmenge / Token-Overlap ≥ 0.5 (locationSimilarity).
// existing: [{ id, name, typ }]  incoming: [{ name, typ }]  → Map(incomingIndex → existingId).
function matchLocations(existing, incoming) {
  const matchOf = new Map();
  const used = new Set();
  const exByNorm = new Map();
  for (const ex of existing) {
    const k = normLocName(ex.name);
    if (k && !exByNorm.has(k)) exByNorm.set(k, ex);
  }
  // Stufe 1: exakter Name.
  for (let i = 0; i < incoming.length; i++) {
    const ex = exByNorm.get(normLocName(incoming[i].name));
    if (ex && !used.has(ex.id)) { matchOf.set(i, ex.id); used.add(ex.id); }
  }
  // Stufe 2: Fuzzy (Token-Teilmenge / Overlap).
  for (let i = 0; i < incoming.length; i++) {
    if (matchOf.has(i)) continue;
    let best = null, bestSim = 0;
    for (const ex of existing) {
      if (used.has(ex.id)) continue;
      const sim = locationSimilarity(ex, incoming[i]);
      if (sim > bestSim) { best = ex; bestSim = sim; }
    }
    if (best) { matchOf.set(i, best.id); used.add(best.id); }
  }
  return matchOf;
}

// Within-Run-Dedup Orte: verschmilzt Varianten desselben Orts INNERHALB eines Laufs
// (Completeness-Gap-Pässe ziehen im Single-Pass Schreibvarianten nach). Konservativ:
// NUR Token-Teilmenge (kein Overlap-Threshold) — ein Within-Run-Merge verliert einen
// Eintrag wirklich, darum nur bei sehr starkem Signal. Union von figuren/kapitel; die
// reichste beschreibung/stimmung gewinnt. Erstes Vorkommen bleibt kanonisch.
function dedupeLocationsWithinRun(orte) {
  const kept = [];
  for (const o of (orte || [])) {
    let target = null;
    for (const k of kept) {
      if (locationSimilarity(k, o, { overlapThreshold: 2 }) >= 0.95) { target = k; break; }
    }
    if (!target) { kept.push({ ...o }); continue; }
    // Merge in den bestehenden Eintrag.
    const figs = new Set([...(target.figuren_namen || []), ...(o.figuren_namen || [])]);
    target.figuren_namen = [...figs];
    const kap = new Map();
    for (const src of [target.kapitel, o.kapitel]) {
      for (const k of (src || [])) {
        const name = typeof k === 'object' && k ? k.name : k;
        if (name && !kap.has(name)) kap.set(name, k);
      }
    }
    if (kap.size) target.kapitel = [...kap.values()];
    if ((o.beschreibung || '').length > (target.beschreibung || '').length) target.beschreibung = o.beschreibung;
    if (!target.stimmung && o.stimmung) target.stimmung = o.stimmung;
    // Längeren, spezifischeren Namen bevorzugen (mehr Qualifizierer).
    if (String(o.name || '').length > String(target.name || '').length) target.name = o.name;
  }
  return kept;
}

// Szenen-Titel-Token (analog placeTokens, aber Titel sind Freitext-Sätze — nur
// Satzzeichen strippen, Stopwords entfernen). «Ankunft in Olten» → [ankunft, olten].
function sceneTitleTokens(titel) {
  return placeTokens(titel);
}

// Cross-Run-Matching Szenen: pro Kapitel gebucketet. Stufe 1 exakter normalisierter
// Titel; Stufe 2 Token-Teilmenge des Titels (konservativ, kein Overlap — Szenen sind
// zahlreich, ein Fehlmatch verschmilzt zwei echte Szenen). Match nur INNERHALB
// desselben chapter_id. existing/incoming: [{ id?, chapterId|chapter_id, titel }].
function matchScenes(existing, incoming) {
  const norm = (t) => normLocName(t);
  const exByChap = new Map();  // chapterId → [{ id, titel }]
  for (const ex of existing) {
    const c = ex.chapterId ?? ex.chapter_id ?? 0;
    if (!exByChap.has(c)) exByChap.set(c, []);
    exByChap.get(c).push(ex);
  }
  const matchOf = new Map();
  const used = new Set();
  // Stufe 1: exakter Titel im selben Kapitel.
  for (let i = 0; i < incoming.length; i++) {
    const c = incoming[i].chapterId ?? incoming[i].chapter_id ?? 0;
    const bucket = exByChap.get(c) || [];
    const ex = bucket.find(e => !used.has(e.id) && norm(e.titel) === norm(incoming[i].titel));
    if (ex) { matchOf.set(i, ex.id); used.add(ex.id); }
  }
  // Stufe 2: Token-Teilmenge des Titels im selben Kapitel.
  for (let i = 0; i < incoming.length; i++) {
    if (matchOf.has(i)) continue;
    const c = incoming[i].chapterId ?? incoming[i].chapter_id ?? 0;
    const ti = sceneTitleTokens(incoming[i].titel);
    if (!ti.length) continue;
    const bucket = exByChap.get(c) || [];
    let best = null;
    for (const ex of bucket) {
      if (used.has(ex.id)) continue;
      const te = sceneTitleTokens(ex.titel);
      if (!te.length) continue;
      if (_isSubset(ti, te) || _isSubset(te, ti)) { best = ex; break; }
    }
    if (best) { matchOf.set(i, best.id); used.add(best.id); }
  }
  return matchOf;
}

module.exports = {
  LOC_STOPWORDS, placeTokens, normLocName, locationSimilarity,
  matchLocations, dedupeLocationsWithinRun, sceneTitleTokens, matchScenes,
};
