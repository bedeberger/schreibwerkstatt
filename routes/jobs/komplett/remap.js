'use strict';
const {
  db, saveZeitstrahlEvents, updateFigurenEvents, saveContinuityCheck,
} = require('../../../db/schema');
const { _modelName } = require('../shared');
const { _refToString, _stelleQuote } = require('./utils');
const { NOW_ISO_SQL } = require('../../../db/now');
const searchIndex = require('../../../lib/search');

/** Mappt Szenen-Klarnamen (aus Phase 1) auf konsolidierte Figuren-/Ort-IDs.
 *  Nicht auflösbare Namen (KI-Halluzination, Tippfehler, in Phase 2/3 wegkonsolidiert)
 *  werden gedroppt und – wenn `log` übergeben – aggregiert geloggt (sonst still). */
function remapSzenen(chSzenen, figNameToId, figNameToIdLower, ortNameToId, ortNameToIdLower, chNameToId, log = null) {
  const szenen = [];
  const droppedFig = new Set();
  const droppedOrt = new Set();
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
          if (!name) return null;
          const id = figNameToId[name] || figNameToIdLower[name.toLowerCase()] || null;
          if (!id) droppedFig.add(name);
          return id;
        }).filter(Boolean),
        ort_ids: (s.orte_namen || []).map(n => {
          const name = _refToString(n);
          if (!name) return null;
          const id = ortNameToId[name] || ortNameToIdLower[name.toLowerCase()] || null;
          if (!id) droppedOrt.add(name);
          return id;
        }).filter(Boolean),
        sort_order: szenen.length,
      });
    }
  }
  if (log) {
    const sample = (set) => [...set].slice(0, 8).join(', ') + (set.size > 8 ? ' …' : '');
    if (droppedFig.size) log.warn(`Szenen-Remap: ${droppedFig.size} Figuren-Name(n) ohne ID ignoriert: ${sample(droppedFig)}`);
    if (droppedOrt.size) log.warn(`Szenen-Remap: ${droppedOrt.size} Ort-Name(n) ohne ID ignoriert: ${sample(droppedOrt)}`);
  }
  return szenen;
}

/** Mappt Assignments auf konsolidierte Figuren-IDs, dedupliziert und sortiert. */
function remapAssignments(chAssignments, figNameToId, figNameToIdLower, chNameToId, log, jobId) {
  const mergedEvtMap = new Map();
  let dropped = 0;

  for (const { kapitel, assignments: chAss } of (chAssignments || [])) {
    for (const assignment of (chAss || [])) {
      // figur_name kann als Objekt statt String kommen (KI-Drift) → _refToString,
      // sonst wirft .toLowerCase() und der gesamte Job failt nach gespeichertem Katalog.
      const figName = _refToString(assignment.figur_name);
      const figId = (figName && (figNameToId[figName] || figNameToIdLower[figName.toLowerCase()])) || null;
      if (!figId) {
        dropped++;
        log.warn(`Assignment «${figName ?? '(ohne Name)'}» (${assignment.lebensereignisse?.length || 0} Ereignisse) – keine Figuren-ID.`);
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
      const key = [ev.datum_year, ev.datum_month, ev.datum_day, (ev.ereignis || '').trim().toLowerCase()].join('||');
      if (!seen.has(key)) { seen.add(key); deduped.push(ev); }
    }
    allAssignments.push({ fig_id, lebensereignisse: deduped });
  }
  return allAssignments;
}

/** Speichert Szenen und Figuren-Events in die DB. Gibt { szenenCount, eventsCount } zurück. */
function saveSzenenAndEvents(bookIdInt, email, szenen, assignments, locIdToDbId, idMaps, log, jobId) {
  db.transaction(() => {
    // Reconcile statt DELETE+INSERT, damit figure_scenes.id (und FK-Refs darauf:
    // research_item_links.scene_id, scene_locations) ueber Re-Analysen stabil bleibt.
    // figure_scenes hat keinen lauf-stabilen Identifier → Match per (chapter_id +
    // normalisierter Titel); re-detektiert behaelt id + stale=0, verschwundene → stale=1
    // statt Loeschen. Spiegelt das figures-/locations-Reconcile-Netz.
    const _normTitel = (t) => (t || '').toLowerCase().trim().replace(/\s+/g, ' ');
    // Eingehende Szenen vorab auf chapter_id/page_id aufloesen (fuer Match-Key + Save).
    const resolved = szenen.map(s => {
      const chapterId = idMaps.chNameToId[s.kapitel] ?? null;
      const pageId = s.seite
        ? (idMaps.pageNameToIdByChapter[chapterId ?? 0]?.[s.seite] ?? null)
        : null;
      return { ...s, chapterId, pageId };
    });

    const existing = db.prepare(
      'SELECT id, chapter_id, titel FROM figure_scenes WHERE book_id = ? AND user_email IS ?'
    ).all(bookIdInt, email);
    const exByKey = new Map();   // 'chapterId::titel' → [existingId, …]
    for (const ex of existing) {
      const k = (ex.chapter_id ?? 0) + '::' + _normTitel(ex.titel);
      if (!exByKey.has(k)) exByKey.set(k, []);
      exByKey.get(k).push(ex.id);
    }
    const matchOf = new Map();   // resolvedIndex → existingId
    const usedExisting = new Set();
    for (let i = 0; i < resolved.length; i++) {
      const bucket = exByKey.get((resolved[i].chapterId ?? 0) + '::' + _normTitel(resolved[i].titel));
      const exId = bucket && bucket.find(id => !usedExisting.has(id));
      if (exId != null) { matchOf.set(i, exId); usedExisting.add(exId); }
    }
    // Verschwundene → stale=1 (Refs bleiben), statt Loeschen.
    const markStale = db.prepare('UPDATE figure_scenes SET stale = 1 WHERE id = ?');
    for (const ex of existing) if (!usedExisting.has(ex.id)) markStale.run(ex.id);

    const ins = db.prepare(`INSERT INTO figure_scenes
      (book_id, user_email, titel, wertung, kommentar, chapter_id, page_id, sort_order, stale, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ${NOW_ISO_SQL})`);
    const upd = db.prepare(`UPDATE figure_scenes
      SET titel=?, wertung=?, kommentar=?, chapter_id=?, page_id=?, sort_order=?, stale=0, updated_at=${NOW_ISO_SQL}
      WHERE id=?`);
    const delSf = db.prepare('DELETE FROM scene_figures WHERE scene_id = ?');
    const delSl = db.prepare('DELETE FROM scene_locations WHERE scene_id = ?');
    // scene_figures.figure_id ist INTEGER (figures.id) seit Mig 73 — Lookup TEXT → INT.
    const figRows = db.prepare(
      'SELECT id, fig_id FROM figures WHERE book_id = ? AND user_email IS ?'
    ).all(bookIdInt, email);
    const figIdToRowId = Object.fromEntries(figRows.map(r => [r.fig_id, r.id]));
    const insSf = db.prepare('INSERT OR IGNORE INTO scene_figures (scene_id, figure_id) VALUES (?, ?)');
    const insSl = db.prepare('INSERT OR IGNORE INTO scene_locations (scene_id, location_id) VALUES (?, ?)');
    for (let i = 0; i < resolved.length; i++) {
      const s = resolved[i];
      const existingId = matchOf.get(i);
      let sceneId;
      if (existingId != null) {
        upd.run(s.titel, s.wertung, s.kommentar, s.chapterId, s.pageId, s.sort_order, existingId);
        sceneId = existingId;
        // Analyse-Bridges neu schreiben (CASCADE-Kinder ohne externe Refs).
        delSf.run(sceneId);
        delSl.run(sceneId);
      } else {
        const r = ins.run(
          bookIdInt, email,
          s.titel, s.wertung, s.kommentar,
          s.chapterId, s.pageId,
          s.sort_order,
        );
        sceneId = r.lastInsertRowid;
      }
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
  // figure_scenes neu indexieren — Full-Replace pro Buch (kind/book
  // droppen, dann Re-Upsert aller aktuellen Rows).
  searchIndex.removeKindForBook('scene', bookIdInt);
  const sceneRows = db.prepare('SELECT id FROM figure_scenes WHERE book_id = ?').all(bookIdInt);
  for (const r of sceneRows) searchIndex.upsertScene(r.id);
  // Figuren wurden im selben Job-Run via saveFigurenToDb persistiert — die
  // figures-Daten haben sich potentiell geaendert (Beschreibungen, Namen).
  searchIndex.removeKindForBook('figure', bookIdInt);
  const figRows = db.prepare('SELECT id FROM figures WHERE book_id = ?').all(bookIdInt);
  for (const f of figRows) searchIndex.upsertFigure(f.id);
  searchIndex.removeKindForBook('location', bookIdInt);
  const locRows = db.prepare('SELECT id FROM locations WHERE book_id = ?').all(bookIdInt);
  for (const l of locRows) searchIndex.upsertLocation(l.id);
  log.info(`${szenen.length} Szenen, ${eventsCount} Ereignisse gespeichert.`);
  return { szenenCount: szenen.length, eventsCount };
}

// Patterns, mit denen die KI eine eigene Entwarnung in beschreibung/empfehlung
// signalisiert. Synchron mit Prompt-Selbstcheck in
// public/js/prompts/komplett/schema-strings.js (PROBLEME_RULES, Z. «Selbstcheck …»).
// KI hält die Selbstcheck-Regel nicht zuverlässig ein → Server filtert defensiv nach.
// `echte[rns]?` deckt alle Genus-/Kasus-Formen ab («kein echter/echte/echten Widerspruch»).
const SELF_CANCEL_PATTERN = /\b(kein(en)?\s+(echte[rns]?\s+)?widerspruch|kein\s+problem|das\s+ist\s+korrekt|konsistent|pass(t|en)\s+zusammen|stimmig|unproblematisch|entwarnung|wird\s+nicht\s+gemeldet|eintrag\s+entfernen)\b/i;

// «lässt sich erklären» ist NUR eine Selbst-Annullierung, wenn es einen Erklär-GRUND
// nennt («… lässt sich erklären durch …») — exakt der Prompt-Wortlaut «lässt sich
// erklären durch … (als Entwarnung)». Eine Lösungs-EMPFEHLUNG dagegen («Der Widerspruch
// lässt sich erklären, indem in Kapitel 3 ein Hinweis ergänzt wird») ist ein ECHTER Befund
// mit Fix-Vorschlag und darf NICHT verworfen werden. Darum (a) nur «… erklären durch …»
// (nicht das blosse «erklären») und (b) nur in der `beschreibung` werten — die `empfehlung`
// soll laut Prompt eine Lösung vorschlagen und enthält «erklären» legitim.
const SELF_CANCEL_EXPLAIN = /l(ä|ae)sst\s+sich\s+erkl(ä|ae)ren\s+durch/i;

function _isSelfCancelled(p) {
  const beschr = p.beschreibung || '';
  const empf = p.empfehlung || '';
  return SELF_CANCEL_PATTERN.test(beschr) || SELF_CANCEL_PATTERN.test(empf)
    || SELF_CANCEL_EXPLAIN.test(beschr);
}

/** Speichert Kontinuitätsprüfung in die DB (eine Zeile pro Issue + Bridge-Tabellen
 *  für Figuren-/Kapitel-Referenzen). Gibt normalizedIssues zurück, oder null bei
 *  ungültiger Antwort. */
function saveKontinuitaetResult(bookIdInt, email, kontResult, figNameToId, chNameToId, effectiveProvider, log, opts = {}) {
  const { fullBookText = null, requireQuoteEvidence = false } = opts;
  if (typeof kontResult?.zusammenfassung === 'undefined') return null;
  const rawProbleme = kontResult.probleme || [];
  let filtered = rawProbleme.filter(p => !_isSelfCancelled(p));
  const dropped = rawProbleme.length - filtered.length;
  if (dropped > 0) log.warn(`Kontinuität: ${dropped} Selbst-Entwarnungen verworfen.`);

  // Beleg-Prüfung NUR für Single-Pass-Pfade (voller Buchtext im Prompt, Zitat-Pflicht
  // ist wörtlich). Der Multi-Pass-Fakten-Pfad zitiert paraphrasierte Fakt-Aussagen,
  // nicht den Buchtext → dort würde ein indexOf gegen den Volltext echte Befunde als
  // False-Negative verwerfen. Der Multi-Pass-Claude-Pfad hat ohnehin die separate
  // verifyKontinuitaetProbleme-Stufe; Single-Pass + lokale Provider hatten bisher
  // keine Beleg-Kontrolle → halluzinierte Zitate erreichten die UI.
  if (requireQuoteEvidence && fullBookText) {
    const haystack = fullBookText.replace(/\s+/g, ' ');
    const inText = (q) => haystack.includes(q.replace(/\s+/g, ' ').slice(0, 40));
    // Konservativ wie die verify-Stufe: nur als Halluzination verwerfen, wenn ein
    // Problem ein wörtliches Zitat LIEFERT, das aber im Buchtext NICHT auffindbar ist.
    // Hat es keine «»-Zitate (nur Kapitel-/Seiten-Hinweis), bleibt es erhalten – das
    // ist eine Zitat-Format-Verletzung, keine erfundene Stelle (kein False-Negative).
    const isFabricated = (p) => {
      const quotes = [p.stelle_a, p.stelle_b].map(_stelleQuote).filter(Boolean);
      return quotes.length > 0 && !quotes.some(inText);
    };
    const before = filtered.length;
    filtered = filtered.filter(p => !isFabricated(p));
    const evDropped = before - filtered.length;
    if (evDropped > 0) log.warn(`Kontinuität: ${evDropped} Problem(e) mit erfundenem Beleg-Zitat (nicht im Buchtext) verworfen.`);
  }

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
