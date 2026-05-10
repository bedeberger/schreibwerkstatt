'use strict';

/** Reduziert KI-Ref (String oder {name,id,…}-Objekt) auf einen blanken Namen.
 *  KI liefert in figuren_namen/orte_namen/issue.figuren etc. gelegentlich Objekte
 *  statt Strings — ohne Normalisierung würde `[object Object]` durch die Pipeline
 *  laufen oder `n?.toLowerCase()` werfen. */
function _refToString(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'object') {
    const s = v.name || v.titel || v.label || v.fig_id || v.loc_id || v.id;
    return s ? String(s).trim() || null : null;
  }
  return null;
}

/** Extrahiert ein Feld aus settledAll-Ergebnissen in das Kapitel-Array-Format. */
function extractField(settled, chunkTexts, field) {
  return settled.map((r, i) => ({
    kapitel: chunkTexts[i].chunk.name,
    [field]: r.status === 'fulfilled' ? (r.value?.[field] || []) : [],
  }));
}

/**
 * Baut den System-Block mit dem Buchtext, der über mehrere Claude-Calls gecached wird.
 * Byte-identische Formatierung in Phase 1 Pass A/B und Phase 8 Kontinuität,
 * damit der Cache-Prefix-Match greift (erster cache_control-Breakpoint).
 */
function buildBookSystemBlockText(bookName, pageCount, fullBookText) {
  return `Buch: «${bookName}»\n\nBuchtext (${pageCount} Seiten):\n\n${fullBookText}`;
}

/**
 * Signatur aller Seiten eines Buchs für den Single-Pass-Cache der Phase 1.
 * Berücksichtigt page_id, page-updated_at, chapter_id, chapter-Name sowie
 * buchtyp/buch_kontext/language – ändert sich eins davon, wird der Cache
 * invalidiert, weil die entsprechenden Prompts andere Ergebnisse liefern.
 * `cacheVersion` (model+prompts-Version) hängt zusätzlich an, damit Modell-
 * oder Schema-Änderungen alte Caches automatisch invalidieren.
 */
function buildBookPagesSig(pageContents, bookSettings, cacheVersion) {
  const pagesPart = pageContents
    .map(p => `${p.id}:${p.updated_at || ''}|${p.chapter_id ?? ''}:${p.chapter ?? ''}`)
    .sort()
    .join('|');
  const s = bookSettings || {};
  const settingsPart = `${s.language || ''}:${s.region || ''}:${s.buchtyp || ''}:${s.buch_kontext || ''}`;
  return `${pagesPart}||${settingsPart}||${cacheVersion || ''}`;
}

/** Führt eine nicht-kritische Phase aus – Fehler werden geloggt, nicht geworfen. */
async function runNonCritical(label, fn, log, jobId) {
  try {
    return await fn();
  } catch (e) {
    log.warn(`${label} fehlgeschlagen (ignoriert): ${e.message}`);
    return null;
  }
}

/**
 * Baut Name→ID Lookup-Maps für konsolidierte Figuren.
 * Enthält kanonischen Namen, Kurznamen und Token-Fallback für Phase-1-Namen.
 * Wenn das Modell in Phase 1 einen anderen Namen verwendet als Phase 2
 * (z.B. nur Nachname, Titel+Name), wird per Token-Matching die eindeutig
 * passende Phase-2-Figur gesucht. Nur bei eindeutigem Match.
 */
function buildFigNameLookup(figuren, chapterFiguren, chapterAssignments, log, jobId) {
  const nameToId = {};
  for (const f of figuren) {
    nameToId[f.name] = f.id;
    if (f.kurzname && f.kurzname !== f.name) nameToId[f.kurzname] = f.id;
  }
  const nameToIdLower = Object.fromEntries(
    Object.entries(nameToId).map(([k, v]) => [k.toLowerCase(), v])
  );

  function tryTokenFallback(name) {
    if (!name || nameToId[name] || nameToIdLower[name.toLowerCase()]) return;
    const tokens = new Set(name.toLowerCase().split(/[\s\-\.]+/).filter(t => t.length > 2));
    if (!tokens.size) return;
    const seen = new Set();
    const matches = [];
    for (const [canon, fid] of Object.entries(nameToId)) {
      if (seen.has(fid)) continue;
      const overlap = canon.toLowerCase().split(/[\s\-\.]+/)
        .filter(t => t.length > 2 && tokens.has(t)).length;
      if (overlap > 0) { seen.add(fid); matches.push(fid); }
    }
    if (matches.length === 1) {
      nameToId[name] = matches[0];
      nameToIdLower[name.toLowerCase()] = matches[0];
      log.info(`Phase-1-Name «${name}» → ${matches[0]} (Token-Fallback)`);
    }
  }

  for (const { figuren: chFigs } of (chapterFiguren || []))
    for (const f1 of (chFigs || [])) tryTokenFallback(f1.name);
  for (const { assignments: chAss } of (chapterAssignments || []))
    for (const a of (chAss || [])) tryTokenFallback(a?.figur_name);

  return { figNameToId: nameToId, figNameToIdLower: nameToIdLower };
}

module.exports = {
  _refToString, extractField,
  buildBookSystemBlockText, buildBookPagesSig,
  runNonCritical, buildFigNameLookup,
};
