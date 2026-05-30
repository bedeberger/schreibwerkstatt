'use strict';

const { db } = require('../../../../../db/schema');

// Block 31: Handlungsstränge (storylines) — narrative Stränge, denen
// Zeitstrahl-Ereignisse zugeordnet sind. Pro Strang die zugehörigen
// Ereignisse als Q&A, plus globale Strang-Liste. Lehrt das Modell die
// makro-narrative Gliederung des Buches.
function buildStorylineSamples(ctx) {
  const { langIsEn, bookIdInt, userEmail, pushQA } = ctx;

  const slRows = db.prepare(`
    SELECT id, name FROM storylines WHERE book_id = ? ORDER BY sort_order
  `).all(bookIdInt);
  if (!slRows.length) return;

  // Ereignisse pro Strang aus dem Zeitstrahl
  const evtsBySl = new Map(); // storyline_id → [{ereignis,datum,bedeutung}]
  for (const r of db.prepare(`
    SELECT storyline_id, ereignis, datum, bedeutung
    FROM zeitstrahl_events
    WHERE book_id = ? AND user_email = ? AND storyline_id IS NOT NULL
    ORDER BY sort_order
  `).all(bookIdInt, userEmail || '')) {
    if (!r.ereignis) continue;
    if (!evtsBySl.has(r.storyline_id)) evtsBySl.set(r.storyline_id, []);
    evtsBySl.get(r.storyline_id).push(r);
  }

  const renderEvtList = (items, max = 12) => items.slice(0, max)
    .map(e => `${e.datum ? e.datum + ': ' : ''}${e.ereignis}${e.bedeutung ? ' (' + e.bedeutung + ')' : ''}`)
    .join(' · ');

  for (const sl of slRows) {
    const name = (sl.name || '').trim();
    if (!name) continue;
    const items = evtsBySl.get(sl.id) || [];
    if (!items.length) continue;
    const list = renderEvtList(items);

    pushQA('authorChat|sl|' + sl.id,
      langIsEn ? `What happens in the storyline «${name}»?` : `Was passiert im Handlungsstrang «${name}»?`,
      list);
    pushQA('authorChat|sl2|' + sl.id,
      langIsEn ? `Which events belong to the storyline «${name}»?` : `Welche Ereignisse gehören zum Strang «${name}»?`,
      list);
    pushQA('authorChat|sl3|' + sl.id,
      langIsEn ? `Trace the storyline «${name}».` : `Zeichne den Handlungsstrang «${name}» nach.`,
      list);
  }

  // Globale Strang-Übersicht (nur Stränge mit Ereignissen)
  const named = slRows.filter(sl => (evtsBySl.get(sl.id) || []).length).map(sl => sl.name).filter(Boolean);
  if (named.length >= 2) {
    const all = named.slice(0, 30).join(', ');
    pushQA('authorChat|slAll',
      langIsEn ? `Which storylines run through the book?` : `Welche Handlungsstränge ziehen sich durchs Buch?`,
      all);
    pushQA('authorChat|slAll2',
      langIsEn ? `List the narrative threads of this book.` : `Liste die Erzählstränge dieses Buches auf.`,
      all);
  }
}

module.exports = { buildStorylineSamples };
