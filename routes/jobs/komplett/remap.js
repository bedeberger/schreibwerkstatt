'use strict';
const {
  db, saveZeitstrahlEvents, updateFigurenEvents, saveContinuityCheck,
} = require('../../../db/schema');
const { _modelName } = require('../shared');
const { _refToString } = require('./utils');

/** Mappt Szenen-Klarnamen (aus Phase 1) auf konsolidierte Figuren-/Ort-IDs. */
function remapSzenen(chSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, chNameToId) {
  const szenen = [];
  for (const { kapitel, szenen: chSz } of (chSzenen || [])) {
    for (const s of (chSz || [])) {
      // Wie bei `seite` kann die KI auch beim Kapitel den ##-Präfix mitliefern.
      const rawKapitel = (s.kapitel || '').replace(/^#{1,6}\s+/, '').trim();
      const effKapitel = (rawKapitel && chNameToId[rawKapitel] != null) ? rawKapitel : kapitel;
      // LLM-Halluzination 1: Markdown-Header-Präfix («### Seitentitel» statt
      // «Seitentitel») – wortwörtlich aus der User-Message kopiert.
      // LLM-Halluzination 2: Kapitelname als Seitentitel zurückgegeben, weil der
      // echte Titel nicht erkannt wurde. Oder chMap-Fallback «Sonstige Seiten».
      // In beiden Fällen `seite` nullen / strippen, damit der page_id-Lookup
      // unten trifft.
      let effSeite = (s.seite || '').replace(/^#{1,6}\s+/, '').trim() || null;
      if (effSeite && (effSeite === effKapitel || effSeite === 'Sonstige Seiten')) {
        effSeite = null;
      }
      szenen.push({
        kapitel: effKapitel,
        seite: effSeite,
        titel: s.titel || '(unbekannt)',
        wertung: s.wertung || null,
        kommentar: s.kommentar || null,
        fig_ids: (s.figuren_namen || []).map(n => {
          const name = _refToString(n);
          return name ? (figNameToId[name] || figNameToIdLower[name.toLowerCase()] || null) : null;
        }).filter(Boolean),
        ort_ids: (s.orte_namen || []).map(n => {
          const name = _refToString(n);
          return name ? (ortNameToId[name] || ortNameToIdLower[name.toLowerCase()] || null) : null;
        }).filter(Boolean),
        sort_order: szenen.length,
      });
    }
  }
  return szenen;
}

/** Mappt Assignments auf konsolidierte Figuren-IDs, dedupliziert und sortiert. */
function remapAssignments(chAssignments, figNameToId, figNameToIdLower, chNameToId, log, jobId) {
  const mergedEvtMap = new Map();
  let dropped = 0;

  for (const { kapitel, assignments: chAss } of (chAssignments || [])) {
    for (const assignment of (chAss || [])) {
      const figId = figNameToId[assignment.figur_name]
        || figNameToIdLower[assignment.figur_name?.toLowerCase()] || null;
      if (!figId) {
        dropped++;
        log.warn(`Assignment «${assignment.figur_name}» (${assignment.lebensereignisse?.length || 0} Ereignisse) – keine Figuren-ID.`);
        continue;
      }
      if (!mergedEvtMap.has(figId)) mergedEvtMap.set(figId, []);
      for (const ev of (assignment.lebensereignisse || [])) {
        const evKap = (ev.kapitel || '').replace(/^#{1,6}\s+/, '').trim();
        const evSeite = (ev.seite || '').replace(/^#{1,6}\s+/, '').trim();
        mergedEvtMap.get(figId).push({
          ...ev,
          kapitel: (evKap && chNameToId[evKap] != null) ? evKap : kapitel,
          seite: evSeite || null,
        });
      }
    }
  }
  if (dropped > 0) log.warn(`${dropped} Assignments ohne Figuren-ID ignoriert.`);

  const allAssignments = [];
  for (const [fig_id, events] of mergedEvtMap) {
    const seen = new Set();
    const deduped = [];
    for (const ev of events) {
      const key = (ev.datum || '') + '||' + (ev.ereignis || '').trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); deduped.push(ev); }
    }
    deduped.sort((a, b) => (parseInt(a.datum) || 0) - (parseInt(b.datum) || 0));
    allAssignments.push({ fig_id, lebensereignisse: deduped });
  }
  return allAssignments;
}

/** Speichert Szenen und Figuren-Events in die DB. Gibt { szenenCount, eventsCount } zurück. */
function saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId) {
  db.transaction(() => {
    db.prepare('DELETE FROM figure_scenes WHERE book_id = ? AND user_email = ?').run(bookIdInt, email);
    const now = new Date().toISOString();
    const ins = db.prepare(`INSERT INTO figure_scenes
      (book_id, user_email, titel, wertung, kommentar, chapter_id, page_id, sort_order, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    // scene_figures.figure_id ist INTEGER (figures.id) seit Mig 73 — Lookup TEXT → INT.
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookIdInt, email);
    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const insSf = db.prepare('INSERT OR IGNORE INTO scene_figures (scene_id, figure_id) VALUES (?, ?)');
    const insSl = db.prepare('INSERT OR IGNORE INTO scene_locations (scene_id, location_id) VALUES (?, ?)');
    for (const s of szenen) {
      const chapterId = idMaps.chNameToId[s.kapitel] ?? null;
      const pageId = s.seite
        ? (idMaps.pageNameToIdByChapter[chapterId ?? 0]?.[s.seite] ?? null)
        : null;
      const { lastInsertRowid: sceneId } = ins.run(
        bookIdInt, email,
        s.titel, s.wertung, s.kommentar,
        chapterId, pageId,
        s.sort_order, now,
      );
      for (const fid of s.fig_ids) {
        const rowId = figIdToRowId[fid];
        if (rowId != null) insSf.run(sceneId, rowId);
      }
      for (const locIdStr of s.ort_ids) {
        const dbLocId = locIdToDbId[locIdStr];
        if (dbLocId) insSl.run(sceneId, dbLocId);
      }
    }
  })();

  const eventsCount = assignments.reduce((s, a) => s + (a.lebensereignisse?.length || 0), 0);
  if (eventsCount > 0) {
    saveZeitstrahlEvents(bookIdInt, email, []);
    updateFigurenEvents(bookIdInt, assignments, email, idMaps);
  }
  log.info(`${szenen.length} Szenen, ${eventsCount} Ereignisse gespeichert.`);
  return { szenenCount: szenen.length, eventsCount };
}

// Patterns, mit denen die KI eine eigene Entwarnung in beschreibung/empfehlung
// signalisiert. Synchron mit Prompt-Selbstcheck in
// public/js/prompts/komplett.js (PROBLEME_RULES). KI hält die Selbstcheck-Regel
// nicht zuverlässig ein → Server filtert defensiv nach.
const SELF_CANCEL_PATTERN = /\b(kein(en)?\s+(echten?\s+)?widerspruch|kein\s+problem|das\s+ist\s+korrekt|konsistent|pass(t|en)\s+zusammen|stimmig|unproblematisch|entwarnung|wird\s+nicht\s+gemeldet|eintrag\s+entfernen)\b/i;

function _isSelfCancelled(p) {
  return SELF_CANCEL_PATTERN.test(p.beschreibung || '') || SELF_CANCEL_PATTERN.test(p.empfehlung || '');
}

/** Speichert Kontinuitätsprüfung in die DB (eine Zeile pro Issue + Bridge-Tabellen
 *  für Figuren-/Kapitel-Referenzen). Gibt normalizedIssues zurück, oder null bei
 *  ungültiger Antwort. */
function saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, chNameToId, effectiveProvider, log, jobId) {
  if (typeof kontResult?.zusammenfassung === 'undefined') return null;
  const rawProbleme = kontResult.probleme || [];
  const filtered = rawProbleme.filter(p => !_isSelfCancelled(p));
  const dropped = rawProbleme.length - filtered.length;
  if (dropped > 0) log.warn(`Kontinuität: ${dropped} Selbst-Entwarnungen verworfen.`);
  const issues = filtered.map(p => ({
    schwere: p.schwere, typ: p.typ, beschreibung: p.beschreibung,
    stelle_a: p.stelle_a, stelle_b: p.stelle_b, empfehlung: p.empfehlung,
    figuren: (p.figuren || []).map(_refToString).filter(Boolean),
    kapitel: (p.kapitel || []).map(_refToString).filter(Boolean),
  }));
  const { normalizedIssues } = saveContinuityCheck(
    bookIdInt, email, kontResult.zusammenfassung || '',
    _modelName(effectiveProvider), issues, figNameToId, chNameToId,
  );
  log.info(`Kontinuitätsprüfung gespeichert (${normalizedIssues.length} Probleme).`);
  return normalizedIssues;
}

module.exports = { remapSzenen, remapAssignments, saveSzenenAndEvents, saveKontinuitaetResult, _isSelfCancelled };
