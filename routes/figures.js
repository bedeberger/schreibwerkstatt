const express = require('express');
const { db, saveFigurenToDb, saveZeitstrahlEvents, getChapterFigures, getBookSettings } = require('../db/schema');
const { ensureTree } = require('../db/book-order');
const { recomputeBookFigureMentions } = require('../lib/page-index');
const { toIntId, inClause } = require('../lib/validate');
const { aclParamGuard } = require('../lib/acl');
const { parseDatum } = require('../lib/datum-parse');
const searchIndex = require('../lib/search');
const logger = require('../logger');

const router = express.Router();
// Figuren/Orte/Szenen sind nur fuer editor+ relevant (Buchwelt-CRUD); Lektor
// und Viewer sehen die Karten nicht — Server folgt der Frontend-Sicht.
router.param('book_id', aclParamGuard('editor'));
const jsonBody = express.json();

// Lese-Reihenfolge: globaler Ordinalwert je Kapitel/Seite aus dem book_order-Tree
// (Depth-First). Brücke, um zu einer Event-Referenz (chapter_id/page_id) die
// Position im Manuskript zu bestimmen.
function _readingOrdinalMap(bookId) {
  const order = ensureTree(bookId);
  const map = new Map();
  let i = 0;
  (function walk(nodes) {
    for (const n of (nodes || [])) {
      if (n.type === 'chapter') { map.set('c' + n.id, i++); walk(n.children); }
      else if (n.type === 'page') { map.set('p' + n.id, i++); }
    }
  })(order?.tree || []);
  return map;
}

// "In welchem Jahr stecken die Figuren?" — abgeleitet aus den sicher datierten
// Zeitstrahl-Events (datum_unsicher === false, datum_year gesetzt).
//   minYear/maxYear  → Jahres-Spektrum des Romans (Start inkl. Spannen-Ende)
//   endYear          → Jahr des Events, das der zuletzt geschriebenen Manuskript-
//                      Stelle am nächsten liegt ("wo ich aufgehört habe")
// null, wenn es keine sicher datierten Events gibt. Abgeleitete Jahre
// (datum_unsicher) fliessen bewusst NICHT ein.
function _computeChronology(bookId, events) {
  const secure = (events || []).filter(e => !e.datum_unsicher && e.datum_year != null);
  if (!secure.length) return null;
  let minYear = Infinity, maxYear = -Infinity;
  for (const e of secure) {
    if (e.datum_year < minYear) minYear = e.datum_year;
    const end = e.datum_ende_year != null ? e.datum_ende_year : e.datum_year;
    if (end > maxYear) maxYear = end;
  }
  const ordinal = _readingOrdinalMap(bookId);
  let bestOrd = -1, endYear = null;
  for (const e of secure) {
    let ord = -1;
    for (const cid of (e.chapter_ids || [])) { const o = ordinal.get('c' + cid); if (o != null && o > ord) ord = o; }
    for (const pid of (e.page_ids || []))    { const o = ordinal.get('p' + pid); if (o != null && o > ord) ord = o; }
    if (ord < 0) continue;
    if (ord > bestOrd || (ord === bestOrd && e.datum_year > endYear)) { bestOrd = ord; endYear = e.datum_year; }
  }
  // Kein Event mit Manuskript-Position (z.B. nur Figuren-Events ohne Verortung):
  // Fallback auf das späteste Story-Jahr.
  if (endYear == null) endYear = maxYear;
  return { minYear, maxYear, endYear };
}

// Erste 4-stellige Jahreszahl aus einem Datums-String (z.B. "Frühling 1850").
function _yearFromString(s) {
  if (!s) return null;
  const m = String(s).match(/\b(\d{4})\b/);
  return m ? parseInt(m[1], 10) : null;
}

// Pro-Figur-Jahr ("in welchem Jahr steckt die Figur") + Alter. Nur bei Romanen
// mit "echter Zeitlinie" (book_settings.zeitlinie_real). Map<figures.id, {…}>:
//   jahr_im_roman  → spätestes sicher datiertes Jahr der Figur (inkl. Spannen-
//                    Ende). Fehlt der Figur jede Datierung: Fallback auf das
//                    späteste Jahr im ganzen Buch (= "aktuelles Roman-Jahr").
//   geburtsjahr    → aus dem kuratierten geburtstag-Feld, sonst aus einem
//                    Geburts-Event (subtyp='geburt').
//   alter_im_roman → jahr_im_roman − geburtsjahr (nur wenn beides bekannt und ≥ 0).
//   anchor_ereignis/anchor_kapitel → das datierte Ereignis, das den aktuellen
//                    Stand setzt (= jüngstes datiertes Ereignis der Figur). Das
//                    "weil …": woran die Figur gerade steht, zum Weiterschreiben.
//                    null, wenn die Figur kein eigenes datiertes Ereignis hat
//                    (Jahr stammt dann aus dem Buch-Fallback).
// null, wenn die Zeitlinie ausgeschaltet ist.
function _computeFigureYears(bookId, userEmail) {
  const { zeitlinie_real } = getBookSettings(bookId, userEmail);
  if (!zeitlinie_real) return null;
  const rows = db.prepare(`
    SELECT fe.figure_id AS fid, fe.datum_year AS y, fe.datum_ende_year AS ye, fe.subtyp AS subtyp,
           fe.ereignis AS ereignis, fe.sort_order AS so, c.chapter_name AS kapitel
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    WHERE f.book_id = ? AND f.user_email = ?
      AND fe.datum_unsicher = 0 AND fe.datum_year IS NOT NULL
  `).all(bookId, userEmail || '');
  const figRows = db.prepare(
    'SELECT id, geburtstag FROM figures WHERE book_id = ? AND user_email = ?'
  ).all(bookId, userEmail || '');

  const latest = new Map();    // fid → { year, ereignis, kapitel, so } (jüngstes Ereignis)
  const birthEvt = new Map();  // fid → frühestes Geburts-Event-Jahr
  let bookMax = -Infinity;
  for (const r of rows) {
    const hi = Math.max(r.y, r.ye != null ? r.ye : r.y);
    const cur = latest.get(r.fid);
    // Höchstes Jahr gewinnt; bei Gleichstand die spätere Manuskript-Reihenfolge.
    if (!cur || hi > cur.year || (hi === cur.year && (r.so ?? 0) >= (cur.so ?? 0))) {
      latest.set(r.fid, { year: hi, ereignis: r.ereignis || '', kapitel: r.kapitel || null, so: r.so ?? 0 });
    }
    if (hi > bookMax) bookMax = hi;
    if (r.subtyp === 'geburt' && (!birthEvt.has(r.fid) || r.y < birthEvt.get(r.fid))) {
      birthEvt.set(r.fid, r.y);
    }
  }

  const out = new Map();
  for (const fr of figRows) {
    const geburtsjahr = _yearFromString(fr.geburtstag) ?? (birthEvt.has(fr.id) ? birthEvt.get(fr.id) : null);
    const lat = latest.get(fr.id) || null;
    const jahr = lat ? lat.year : (Number.isFinite(bookMax) ? bookMax : null);
    if (jahr == null && geburtsjahr == null) continue;
    const alter = (jahr != null && geburtsjahr != null && jahr >= geburtsjahr) ? jahr - geburtsjahr : null;
    out.set(fr.id, {
      jahr_im_roman: jahr,
      geburtsjahr,
      alter_im_roman: alter,
      anchor_ereignis: lat ? lat.ereignis : null,
      anchor_kapitel:  lat ? lat.kapitel  : null,
    });
  }
  return out;
}

// Konsolidierten Zeitstrahl eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/zeitstrahl/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  // ORDER BY: strukturierte Datums-Felder zuerst (Year/Month/Day), Events ohne
  // Jahr ans Ende ("unbekannt"-Bucket via COALESCE-Sentinel 9999/99). sort_order
  // dient nur noch als Tiebreaker bei Datums-Gleichstand.
  const rows = db.prepare(`
    SELECT id, datum, datum_label, datum_year, datum_month, datum_day,
           datum_ende_year, datum_ende_month, datum_ende_day,
           story_tag, datum_unsicher, ereignis, typ, subtyp, bedeutung,
           storyline_id, manually_edited, sort_order
    FROM zeitstrahl_events
    WHERE book_id = ? AND user_email = ?
    ORDER BY
      COALESCE(datum_year,  9999),
      COALESCE(datum_month, 99),
      COALESCE(datum_day,   99),
      COALESCE(story_tag,   99999),
      sort_order, id
  `).all(bookId, userEmail || '');
  if (!rows.length) return res.json({ ereignisse: null });

  // Lazy-Parser-Fallback: Events mit Label aber ohne strukturierte Felder
  // (z.B. nachträglich verbesserter Parser oder manuelle Legacy-Strings)
  // beim Read erneut durchschleusen — füllt nur In-Memory, kein DB-Write.
  for (const r of rows) {
    if (r.datum_label && r.datum_year == null && r.datum_month == null
        && r.datum_day == null && r.story_tag == null) {
      const p = parseDatum(r.datum_label);
      if (p.year  != null) r.datum_year  = p.year;
      if (p.month != null) r.datum_month = p.month;
      if (p.day   != null) r.datum_day   = p.day;
      if (p.story_tag != null) r.story_tag = p.story_tag;
    }
  }

  const eventIds = rows.map(r => r.id);
  const { sql: idSql, values: idVals } = inClause(eventIds);

  const chRows = db.prepare(`
    SELECT zec.event_id, zec.chapter_id, c.chapter_name
    FROM zeitstrahl_event_chapters zec
    LEFT JOIN chapters c ON c.chapter_id = zec.chapter_id
    WHERE zec.event_id IN ${idSql}
    ORDER BY zec.event_id, zec.sort_order
  `).all(...idVals);
  const pgRows = db.prepare(`
    SELECT zep.event_id, zep.page_id, p.page_name
    FROM zeitstrahl_event_pages zep
    LEFT JOIN pages p ON p.page_id = zep.page_id
    WHERE zep.event_id IN ${idSql}
    ORDER BY zep.event_id, zep.sort_order
  `).all(...idVals);
  const fgRows = db.prepare(`
    SELECT zef.event_id, f.fig_id, COALESCE(f.name, zef.figur_name) AS name, f.typ
    FROM zeitstrahl_event_figures zef
    LEFT JOIN figures f ON f.id = zef.figure_id
    WHERE zef.event_id IN ${idSql}
    ORDER BY zef.event_id, zef.sort_order
  `).all(...idVals);

  const chByEvt = new Map();
  for (const r of chRows) {
    if (!chByEvt.has(r.event_id)) chByEvt.set(r.event_id, { kapitel: [], chapter_ids: [] });
    const b = chByEvt.get(r.event_id);
    if (r.chapter_name) b.kapitel.push(r.chapter_name);
    if (r.chapter_id != null) b.chapter_ids.push(r.chapter_id);
  }
  const pgByEvt = new Map();
  for (const r of pgRows) {
    if (!pgByEvt.has(r.event_id)) pgByEvt.set(r.event_id, { seiten: [], page_ids: [] });
    const b = pgByEvt.get(r.event_id);
    if (r.page_name) b.seiten.push(r.page_name);
    if (r.page_id != null) b.page_ids.push(r.page_id);
  }
  const fgByEvt = new Map();
  for (const r of fgRows) {
    if (!fgByEvt.has(r.event_id)) fgByEvt.set(r.event_id, []);
    if (!r.name) continue;
    const out = { name: r.name };
    if (r.fig_id) out.id = r.fig_id;
    if (r.typ) out.typ = r.typ;
    fgByEvt.get(r.event_id).push(out);
  }

  const ereignisse = rows.map(r => ({
    id:               r.id,
    datum:            r.datum,
    datum_label:      r.datum_label || r.datum || '',
    datum_year:       r.datum_year,
    datum_month:      r.datum_month,
    datum_day:        r.datum_day,
    datum_ende_year:  r.datum_ende_year,
    datum_ende_month: r.datum_ende_month,
    datum_ende_day:   r.datum_ende_day,
    story_tag:        r.story_tag,
    datum_unsicher:   !!r.datum_unsicher,
    ereignis:         r.ereignis,
    typ:              r.typ || 'persoenlich',
    subtyp:           r.subtyp || 'sonstiges',
    bedeutung:        r.bedeutung || '',
    storyline_id:     r.storyline_id,
    manually_edited:  !!r.manually_edited,
    sort_order:       r.sort_order ?? 0,
    kapitel:          chByEvt.get(r.id)?.kapitel     || [],
    chapter_ids:      chByEvt.get(r.id)?.chapter_ids || [],
    seiten:           pgByEvt.get(r.id)?.seiten      || [],
    page_ids:         pgByEvt.get(r.id)?.page_ids    || [],
    figuren:          fgByEvt.get(r.id) || [],
  }));

  // Jahres-Anzeige nur bei Romanen mit "echter Zeitlinie" (book_settings.zeitlinie_real).
  const { zeitlinie_real } = getBookSettings(bookId, userEmail);
  const chronology = zeitlinie_real ? _computeChronology(bookId, ereignisse) : null;
  res.json({ ereignisse, chronology });
});

// Szenen eines Buchs laden (vor /:book_id definiert um Konflikte zu vermeiden)
router.get('/scenes/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;

  const rows = db.prepare(`
    SELECT fs.id, c.chapter_name AS kapitel, p.page_name AS seite,
           fs.titel, fs.wertung, fs.kommentar, fs.chapter_id, fs.page_id, fs.updated_at
    FROM figure_scenes fs
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email = ?
    ORDER BY fs.sort_order
  `).all(bookId, userEmail);

  const sceneIds = rows.map(r => r.id);
  const { sql: sceneSql, values: sceneVals } = inClause(sceneIds);
  const sfRows = sceneIds.length
    ? db.prepare(`
        SELECT sf.scene_id, f.fig_id
        FROM scene_figures sf
        JOIN figures f ON f.id = sf.figure_id
        WHERE sf.scene_id IN ${sceneSql}
      `).all(...sceneVals)
    : [];
  const sfMap = {};
  for (const sf of sfRows) (sfMap[sf.scene_id] ??= []).push(sf.fig_id);

  const slRows = sceneIds.length
    ? db.prepare(`SELECT sl.scene_id, l.loc_id FROM scene_locations sl JOIN locations l ON sl.location_id = l.id WHERE sl.scene_id IN ${sceneSql}`).all(...sceneVals)
    : [];
  const slMap = {};
  for (const sl of slRows) (slMap[sl.scene_id] ??= []).push(sl.loc_id);

  const szenen = rows.map(s => ({
    id:         s.id,
    kapitel:    s.kapitel,
    seite:      s.seite,
    titel:      s.titel,
    wertung:    s.wertung,
    kommentar:  s.kommentar,
    chapter_id: s.chapter_id,
    page_id:    s.page_id,
    fig_ids:    sfMap[s.id] || [],
    ort_ids:    slMap[s.id] || [],
  }));

  const updated_at = rows.length ? rows[0].updated_at : null;
  res.json({ szenen, updated_at });
});

// Figuren eines Kapitels laden (für Kontext-Panel im Editor)
router.get('/chapter/:book_id/:chapter_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  const chapterId = toIntId(req.params.chapter_id);
  if (!bookId || !chapterId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;
  const figuren = getChapterFigures(bookId, chapterId, userEmail);
  // Pro-Figur-Jahr/Alter anreichern (nur bei zeitlinie_real; sonst null-Map).
  const yearMap = _computeFigureYears(bookId, userEmail);
  if (yearMap) {
    for (const fig of figuren) {
      const fy = yearMap.get(fig.id);
      if (!fy) continue;
      fig.jahr_im_roman   = fy.jahr_im_roman;
      fig.geburtsjahr     = fy.geburtsjahr;
      fig.alter_im_roman  = fy.alter_im_roman;
      fig.anchor_ereignis = fy.anchor_ereignis;
      fig.anchor_kapitel  = fy.anchor_kapitel;
    }
  }
  res.json({ figuren });
});

// Gespeicherte Figuren eines Buchs laden
router.get('/:book_id', (req, res) => {
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  const userEmail = req.session?.user?.email || null;

  const figs = db.prepare(`
    SELECT * FROM figures
    WHERE book_id = ? AND user_email = ?
    ORDER BY sort_order, id
  `).all(bookId, userEmail);
  if (!figs.length) return res.json(null);

  const tags = db.prepare(`
    SELECT ft.figure_id, ft.tag FROM figure_tags ft
    JOIN figures f ON f.id = ft.figure_id
    WHERE f.book_id = ? AND f.user_email = ?`).all(bookId, userEmail);
  const apps = db.prepare(`
    SELECT fa.figure_id, fa.chapter_id, c.chapter_name, fa.haeufigkeit
    FROM figure_appearances fa
    JOIN figures f ON f.id = fa.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fa.chapter_id
    WHERE f.book_id = ? AND f.user_email = ?`).all(bookId, userEmail);
  const evts = db.prepare(`
    SELECT fe.figure_id, fe.datum, fe.ereignis, fe.bedeutung, fe.typ,
           fe.chapter_id, fe.page_id,
           c.chapter_name AS kapitel, p.page_name AS seite
    FROM figure_events fe
    JOIN figures f ON f.id = fe.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fe.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fe.page_id
    WHERE f.book_id = ? AND f.user_email = ?
    ORDER BY fe.figure_id, fe.sort_order`).all(bookId, userEmail);
  const rels = db.prepare(`
    SELECT ff.fig_id AS from_fig_id, ft.fig_id AS to_fig_id,
           r.typ, r.beschreibung, r.machtverhaltnis, r.belege
    FROM figure_relations r
    JOIN figures ff ON ff.id = r.from_fig_id
    JOIN figures ft ON ft.id = r.to_fig_id
    WHERE r.book_id = ? AND r.user_email = ?
  `).all(bookId, userEmail);

  const tagMap = {};
  for (const t of tags) (tagMap[t.figure_id] ??= []).push(t.tag);
  const appMap = {};
  for (const a of apps) (appMap[a.figure_id] ??= []).push({ chapter_id: a.chapter_id ?? null, name: a.chapter_name, haeufigkeit: a.haeufigkeit });
  const evtMap = {};
  for (const e of evts) (evtMap[e.figure_id] ??= []).push({
    datum: e.datum, ereignis: e.ereignis, bedeutung: e.bedeutung,
    typ: e.typ || 'persoenlich',
    chapter_id: e.chapter_id ?? null, page_id: e.page_id ?? null,
    kapitel: e.kapitel || null, seite: e.seite || null,
  });
  const relMap = {};
  for (const r of rels) {
    let belege = [];
    if (r.belege) { try { belege = JSON.parse(r.belege) || []; } catch { belege = []; } }
    (relMap[r.from_fig_id] ??= []).push({
      figur_id: r.to_fig_id,
      typ: r.typ,
      beschreibung: r.beschreibung,
      machtverhaltnis: r.machtverhaltnis ?? null,
      belege: Array.isArray(belege) ? belege : [],
    });
  }

  const sceneFigRows = db.prepare(`
    SELECT c.chapter_name AS kapitel, p.page_name AS seite, f.fig_id
    FROM figure_scenes fs
    JOIN scene_figures sf ON sf.scene_id = fs.id
    JOIN figures f ON f.id = sf.figure_id
    LEFT JOIN chapters c ON c.chapter_id = fs.chapter_id
    LEFT JOIN pages    p ON p.page_id    = fs.page_id
    WHERE fs.book_id = ? AND fs.user_email = ?
  `).all(bookId, userEmail);
  const seitenMap = {};
  for (const sc of sceneFigRows) {
    if (!seitenMap[sc.fig_id]) seitenMap[sc.fig_id] = [];
    const key = sc.kapitel + '::' + (sc.seite || '');
    if (!seitenMap[sc.fig_id].some(x => x.kapitel + '::' + x.seite === key)) {
      seitenMap[sc.fig_id].push({ kapitel: sc.kapitel, seite: sc.seite || '' });
    }
  }

  const yearMap = _computeFigureYears(bookId, userEmail);

  const figuren = figs.map(f => {
    let zitate = [];
    if (f.schluesselzitate) {
      try { zitate = JSON.parse(f.schluesselzitate) || []; } catch { zitate = []; }
    }
    const fy = yearMap?.get(f.id) || null;
    let arc = null;
    if (f.arc) {
      try { arc = JSON.parse(f.arc); } catch { arc = null; }
      // Alt-Daten / Fehlparse: arc-Spalte hielt einen Flachstring statt JSON.
      if (arc === null && typeof f.arc === 'string') arc = { typ: '', anfang: '', wendepunkte: [], ende: f.arc };
    }
    return {
      id: f.fig_id,
      name: f.name,
      kurzname: f.kurzname,
      typ: f.typ,
      geburtstag: f.geburtstag,
      geschlecht: f.geschlecht,
      beruf: f.beruf,
      wohnadresse: f.wohnadresse || null,
      aeusseres: f.aeusseres || null,
      stimme: f.stimme || null,
      hintergrund: f.hintergrund || null,
      beschreibung: f.beschreibung,
      sozialschicht: f.sozialschicht || null,
      praesenz: f.praesenz || null,
      rolle: f.rolle || null,
      motivation: f.motivation || null,
      konflikt: f.konflikt || null,
      entwicklung: f.entwicklung || null,
      arc: (arc && (arc.anfang || arc.ende || (Array.isArray(arc.wendepunkte) && arc.wendepunkte.length) || arc.typ)) ? arc : null,
      erste_erwaehnung: f.erste_erwaehnung || null,
      erste_erwaehnung_page_id: f.erste_erwaehnung_page_id || null,
      schluesselzitate: Array.isArray(zitate) ? zitate : [],
      eigenschaften: tagMap[f.id] || [],
      kapitel: appMap[f.id] || [],
      seiten: seitenMap[f.fig_id] || [],
      lebensereignisse: evtMap[f.id] || [],
      beziehungen: relMap[f.fig_id] || [],
      jahr_im_roman:   fy ? fy.jahr_im_roman   : null,
      geburtsjahr:     fy ? fy.geburtsjahr     : null,
      alter_im_roman:  fy ? fy.alter_im_roman  : null,
      anchor_ereignis: fy ? fy.anchor_ereignis : null,
      anchor_kapitel:  fy ? fy.anchor_kapitel  : null,
    };
  });

  res.json({ figuren, updated_at: figs[0]?.updated_at || null });
});

// Figuren eines Buchs speichern (überschreibt)
router.put('/:book_id', jsonBody, (req, res) => {
  const userEmail = req.session?.user?.email || null;
  const bookId = toIntId(req.params.book_id);
  if (!bookId) return res.status(400).json({ error_code: 'INVALID_ID' });
  saveFigurenToDb(bookId, req.body.figuren || [], userEmail);
  // Response sofort – Mentions-Neuberechnung läuft im Hintergrund. Auf grossen Büchern
  // (>500 Seiten × >50 Figuren) braucht der Regex-Scan mehrere Sekunden.
  res.json({ ok: true });
  // FTS-Index nachziehen: saveFigurenToDb ist Full-Replace pro Buch — daher
  // kind/book droppen und neu indexieren.
  searchIndex.removeKindForBook('figure', bookId);
  const figRows = db.prepare('SELECT id FROM figures WHERE book_id = ?').all(bookId);
  for (const r of figRows) searchIndex.upsertFigure(r.id);
  setImmediate(() => {
    try {
      const { figures, pagesProcessed } = recomputeBookFigureMentions(bookId, userEmail);
      logger.info(`Figuren-Mentions aktualisiert: Buch ${bookId}, ${figures} Figuren × ${pagesProcessed} Seiten.`);
    } catch (e) {
      logger.warn(`Figuren-Mentions-Neuberechnung für Buch ${bookId} fehlgeschlagen: ${e.message}`);
    }
  });
});

module.exports = router;
