'use strict';
// Integration: die Seiten-/Kapitel-/Buch-Abfragen der Buch-Chat-Tools liegen in
// db/book-chat/*.js. Die Tests treiben die Tools über ein gemeinsames Buch und
// prüfen die Stellen, an denen das SQL Semantik trägt: Leserichtung
// (chapters.position/pages.position), Kapitel nur aus demselben Buch
// (`c.book_id = p.book_id`), optionale Filter, jüngster Check/Review je Einheit.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let TOOLS;
let db;

const BOOK = 9101;
const OTHER = 9102;
const U = 'alice@example.com';
const T = '2026-01-01T10:00:00.000Z';
const T2 = '2026-02-01T10:00:00.000Z';
const call = (name, input = {}) => TOOLS[name](input, { bookId: BOOK, userEmail: U, inputBudgetChars: 100000 });

const ids = {};

function seed() {
  ctx.dbSeed.setBook({
    books: [{ id: BOOK, name: 'Queries' }, { id: OTHER, name: 'Fremd' }],
    // Kapitel-ID-Reihenfolge absichtlich gegen die Leserichtung.
    chapters: [
      { id: 91011, book_id: BOOK, name: 'Zwei', position: 2 },
      { id: 91012, book_id: BOOK, name: 'Eins', position: 1 },
      { id: 91021, book_id: OTHER, name: 'FremdKap', position: 1 },
    ],
    pages: [
      { id: 910101, book_id: BOOK, name: 'P-Zwei', chapter_id: 91011, position: 1, updated_at: T2 },
      { id: 910102, book_id: BOOK, name: 'P-Eins-b', chapter_id: 91012, position: 2, updated_at: T },
      { id: 910103, book_id: BOOK, name: 'P-Eins-a', chapter_id: 91012, position: 1, updated_at: T },
      { id: 910104, book_id: BOOK, name: 'P-ohne', position: 0, updated_at: T },
    ],
    pageBodies: {
      910101: '<p>„Hallo Anna“, sagte Bert. Anna ging zur Tür.</p>',
      910102: '<p>Bert rief: „Komm her!“ Anna ging zur Tür und wieder zur Tür.</p>',
      910103: '<p>Kurz.</p>',
      910104: '<p>Ohne Kapitel. Anna im Wald.</p>',
    },
  });
  // Seite im eigenen Buch, deren Kapitel in einem fremden Buch liegt — der
  // Seeder verwirft unbekannte Kapitel, darum direkt.
  db.prepare(`INSERT INTO pages (page_id, book_id, page_name, chapter_id, position, priority, updated_at, body_html)
              VALUES (910105, ?, 'P-fremdkap', 91021, 3, 3, ?, '<p>Bert schwieg.</p>')`).run(BOOK, T);

  const insPs = db.prepare(`INSERT INTO page_stats (page_id, book_id, words, chars, sentences, dialog_chars, pronoun_counts, passive_count, avg_sentence_len)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insPs.run(910101, BOOK, 10, 50, 2, 12, JSON.stringify({ ich: { narr: 1, dlg: 2 } }), 3, 5);
  insPs.run(910102, BOOK, 12, 60, 2, 10, JSON.stringify({ ich: { narr: 4, dlg: 0 } }), 1, 6);
  insPs.run(910103, BOOK, 1, 5, 1, 0, null, 0, 1);
  insPs.run(910104, BOOK, 5, 25, 2, 0, JSON.stringify({ wir: { narr: 1, dlg: 0 } }), 2, 2.5);

  const insFig = db.prepare(`INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  ids.anna = insFig.run(BOOK, U, 'fig_anna', 'Anna Adler', 'Anna', 1, T).lastInsertRowid;
  ids.bert = insFig.run(BOOK, U, 'fig_bert', 'Bert Berg', 'Bert', 0, T).lastInsertRowid;
  const insPfm = db.prepare('INSERT INTO page_figure_mentions (page_id, figure_id, count, first_offset) VALUES (?, ?, ?, ?)');
  insPfm.run(910101, ids.anna, 2, 8);
  insPfm.run(910102, ids.anna, 1, 25);
  insPfm.run(910104, ids.anna, 1, 14);
  insPfm.run(910102, ids.bert, 1, 0);
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(ids.anna, 91011, 2);
  db.prepare('INSERT INTO figure_appearances (figure_id, chapter_id, haeufigkeit) VALUES (?, ?, ?)').run(ids.anna, 91012, 1);
  db.prepare(`INSERT INTO figure_events (figure_id, datum, ereignis, chapter_id, page_id, sort_order) VALUES (?, '2000', 'Geburt', 91012, 910103, 0)`).run(ids.anna);

  const insSc = db.prepare('INSERT INTO figure_scenes (book_id, user_email, titel, chapter_id, page_id, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  ids.sceneA = insSc.run(BOOK, U, 'Tür-Szene', 91011, 910101, 1, T).lastInsertRowid;
  ids.sceneB = insSc.run(BOOK, U, 'Ruf-Szene', 91012, 910102, 0, T).lastInsertRowid;
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(ids.sceneA, ids.anna);
  db.prepare('INSERT INTO scene_figures (scene_id, figure_id) VALUES (?, ?)').run(ids.sceneB, ids.bert);

  const insIdee = db.prepare('INSERT INTO ideen (book_id, page_id, chapter_id, user_email, content, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  insIdee.run(BOOK, 910102, null, U, 'an Seite', 'offen', T, T);
  insIdee.run(BOOK, null, 91012, U, 'am Kapitel', 'erledigt', T, T2);

  const insPc = db.prepare('INSERT INTO page_checks (page_id, book_id, checked_at, error_count, errors_json, fazit, user_email) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const errs = (typ, n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ typ, original: `o${i}`, korrektur: `k${i}` })));
  insPc.run(910101, BOOK, T, 9, errs('stil', 9), 'alt', U);
  insPc.run(910101, BOOK, T2, 1, errs('stil', 1), 'neu', U);
  insPc.run(910102, BOOK, T, 3, errs('grammatik', 3), null, U);
  insPc.run(910103, BOOK, T, 2, errs('stil', 2), null, U);

  const review = note => JSON.stringify({ gesamtnote: note, fazit: 'f', staerken: [], schwaechen: [] });
  const insCr = db.prepare('INSERT INTO chapter_reviews (book_id, chapter_id, reviewed_at, review_json, user_email) VALUES (?, ?, ?, ?, ?)');
  insCr.run(BOOK, 91011, '2025-12-01T00:00:00.000Z', review(2), U);
  insCr.run(BOOK, 91011, '2026-01-15T00:00:00.000Z', review(5), U);
  db.prepare('INSERT INTO book_reviews (book_id, reviewed_at, review_json, user_email) VALUES (?, ?, ?, ?)')
    .run(BOOK, '2026-01-15T00:00:00.000Z', review(4), U);

  const check = db.prepare('INSERT INTO continuity_checks (book_id, checked_at, summary, user_email) VALUES (?, ?, ?, ?)').run(BOOK, T, 's', U).lastInsertRowid;
  const issue = db.prepare(`INSERT INTO continuity_issues (check_id, book_id, user_email, schwere, typ, sort_order) VALUES (?, ?, ?, 'hoch', 'zeit', 0)`).run(check, BOOK, U).lastInsertRowid;
  db.prepare('INSERT INTO continuity_issue_chapters (issue_id, chapter_id, sort_order) VALUES (?, ?, 0)').run(issue, 91012);

  const evt = db.prepare(`INSERT INTO zeitstrahl_events (book_id, user_email, datum, ereignis, sort_order) VALUES (?, ?, '2000', 'E1', 0)`).run(BOOK, U).lastInsertRowid;
  db.prepare('INSERT INTO zeitstrahl_event_chapters (event_id, chapter_id, sort_order) VALUES (?, ?, 0)').run(evt, 91011);
  db.prepare('INSERT INTO zeitstrahl_event_pages (event_id, page_id, sort_order) VALUES (?, ?, 0)').run(evt, 910104);

  const fact = db.prepare(`INSERT INTO world_facts (book_id, kategorie, subjekt, fakt, sort_order, user_email) VALUES (?, 'magie', 'Anna', 'fliegt', 0, ?)`).run(BOOK, U).lastInsertRowid;
  db.prepare('INSERT INTO world_fact_chapters (fact_id, chapter_id) VALUES (?, ?)').run(fact, 91011);
  db.prepare('INSERT INTO world_fact_chapters (fact_id, chapter_id) VALUES (?, ?)').run(fact, 91012);
}

test.before(() => {
  ctx = bootstrap();
  TOOLS = require('../../routes/jobs/book-chat-tools').TOOLS;
  db = require('../../db/connection').db;
  seed();
});
test.after(() => { ctx.cleanup(); });

// ── Katalog ─────────────────────────────────────────────────────────────────

test('list_chapters: Kapitel und Seiten in Leserichtung, Seite ohne Kapitel separat', () => {
  const r = call('list_chapters');
  assert.deepEqual(r.chapters.map(c => c.chapter_name), ['Eins', 'Zwei']);
  assert.deepEqual(r.chapters[0].pages.map(p => p.page_name), ['P-Eins-a', 'P-Eins-b']);
  assert.equal(r.chapters[0].words, 13);
  assert.deepEqual(r.pages_without_chapter.map(p => p.page_name), ['P-ohne']);
  assert.equal(r.total_pages, 5);
});

test('list_ideen: Kapitelname über Seite oder Kapitel, Kapitel-Filter deckt beide Anker', () => {
  const r = call('list_ideen', { chapter_id: 91012 });
  assert.equal(r.total, 2);
  assert.deepEqual(r.ideen.map(i => [i.scope, i.chapter_name]), [['page', 'Eins'], ['chapter', 'Eins']]);
  assert.equal(call('list_ideen', { offen_only: true }).total, 1);
});

test('list_scenes: Kapitel-/Seitenname per JOIN, Figurenfilter', () => {
  const all = call('list_scenes');
  assert.deepEqual(all.scenes.map(s => [s.titel, s.chapter_name, s.page_name]),
    [['Ruf-Szene', 'Eins', 'P-Eins-b'], ['Tür-Szene', 'Zwei', 'P-Zwei']]);
  const anna = call('list_scenes', { figur_id: 'fig_anna' });
  assert.deepEqual(anna.scenes.map(s => s.titel), ['Tür-Szene']);
});

test('list_figures: Erwähnungssumme aus page_figure_mentions', () => {
  const r = call('list_figures');
  assert.deepEqual(r.results.map(f => [f.fig_id, f.mentions]), [['fig_anna', 4], ['fig_bert', 1]]);
});

test('list_revisions: chapter_id aus der Seite, chapter_name nur aus demselben Buch', () => {
  const r = call('list_revisions', { page_id: 910105 });
  assert.equal(r.chapter_id, 91021);
  assert.equal(r.chapter_name, null);
  assert.match(call('list_revisions', { page_id: 999999 }).error, /nicht im aktuellen Buch/);
});

test('list_world_facts: Kapitelnamen je Fakt in Leserichtung', () => {
  assert.deepEqual(call('list_world_facts').fakten[0].kapitel, ['Eins', 'Zwei']);
});

// ── Figuren ─────────────────────────────────────────────────────────────────

test('count_pronouns per_chapter: Seiten ohne Kapitel unter „(ohne Kapitel)"', () => {
  const r = call('count_pronouns', { per_chapter: true, pronouns: ['ich', 'wir'] });
  const byName = Object.fromEntries(r.chapters.map(c => [c.chapter_name, c.counts]));
  assert.deepEqual(byName.Zwei.ich, { narr: 1, dlg: 2 });
  assert.deepEqual(byName.Eins.ich, { narr: 4, dlg: 0 });
  assert.deepEqual(byName['(ohne Kapitel)'].wir, { narr: 1, dlg: 0 });
});

test('get_figure_mentions + find_first_last_mention: erste/letzte Seite in Leserichtung', () => {
  const m = call('get_figure_mentions', { figur_id: 'fig_anna' });
  assert.equal(m.total_mentions, 4);
  // ohne Kapitel (position NULL) zuerst, dann Eins vor Zwei
  assert.equal(m.first_appearance.page_name, 'P-ohne');
  assert.equal(m.last_appearance.page_name, 'P-Zwei');
  const f = call('find_first_last_mention', { figur_id: 'fig_anna' });
  assert.equal(f.first_appearance.first_offset, 14);
  assert.equal(f.last_appearance.chapter_name, 'Zwei');
});

test('get_figure_profile: Kapitel, Ereignisse, Szenen mit Namen', () => {
  const p = call('get_figure_profile', { figur_id: 'fig_anna' });
  assert.deepEqual(p.kapitel.map(k => k.chapter_name), ['Eins', 'Zwei']);
  assert.equal(p.lebensereignisse[0].page_name, 'P-Eins-a');
  assert.equal(p.szenen[0].chapter_name, 'Zwei');
});

// ── Analyse ─────────────────────────────────────────────────────────────────

test('get_reviews: jüngste Kapitelbewertung, stale gegen pages.updated_at, fehlende Kapitel', () => {
  const r = call('get_reviews');
  assert.equal(r.reviews.length, 1);
  assert.equal(r.reviews[0].gesamtnote, 5);
  assert.equal(r.reviews[0].stale, true);
  assert.deepEqual(r.ohne_bewertung.map(c => c.chapter_name), ['Eins']);
  const book = call('get_reviews', { scope: 'book' });
  assert.equal(book.book_name, 'Queries');
  assert.equal(book.stale, true);
});

test('get_lektorat_hotspots / findings: nur jüngster Check je Seite, Filter', () => {
  const h = call('get_lektorat_hotspots');
  assert.equal(h.total_errors, 6);
  assert.deepEqual(h.top_pages.map(p => p.page_name), ['P-Eins-b', 'P-Eins-a', 'P-Zwei']);
  assert.equal(call('get_lektorat_hotspots', { chapter_id: 91011 }).pages_checked, 1);
  const f = call('get_lektorat_findings', { chapter_id: 91012 });
  assert.deepEqual([...new Set(f.findings.map(x => x.page_name))], ['P-Eins-a', 'P-Eins-b']);
  assert.equal(call('get_lektorat_findings', { page_id: 910101 }).total_findings, 1);
});

test('get_stil_metrics: Kapitel-Aggregat in Leserichtung, Seiten-Ranking, Top-Figuren', () => {
  const ch = call('get_stil_metrics', { scope: 'chapter', include_figures: true });
  assert.deepEqual(ch.chapters.map(c => c.chapter_name), ['(ohne Kapitel)', 'Eins', 'Zwei']);
  assert.deepEqual(ch.chapters.find(c => c.chapter_name === 'Eins').top_figuren.map(f => f.fig_id), ['fig_anna', 'fig_bert']);
  const pg = call('get_stil_metrics', { scope: 'page', metric: 'avg_sentence_len', order: 'asc', limit: 2 });
  assert.deepEqual(pg.pages.map(p => p.page_name), ['P-Eins-a', 'P-ohne']);
});

test('listPageStilMetric lehnt eine Spalte ausserhalb STIL_METRIC_COLS ab', () => {
  const { listPageStilMetric } = require('../../db/book-chat/analysis');
  assert.throws(() => listPageStilMetric(BOOK, 'words; DROP TABLE pages', 'DESC', 5), /Unbekannte Stil-Metrik/);
});

// ── Text ────────────────────────────────────────────────────────────────────

test('get_chapter_text: Seiten eines Kapitels in Leserichtung, fremdes Kapitel abgewiesen', async () => {
  const r = await call('get_chapter_text', { chapter_id: 91012 });
  assert.deepEqual(r.pages.map(p => p.page_name), ['P-Eins-a', 'P-Eins-b']);
  assert.match((await call('get_chapter_text', { chapter_id: 91021 })).error, /nicht im aktuellen Buch/);
});

test('get_pages / quote_match: Kapitelname nur aus demselben Buch', async () => {
  const pages = await call('get_pages', { ids: [910101, 910105] });
  assert.deepEqual(pages.pages.map(p => [p.page_name, p.chapter_name]), [['P-Zwei', 'Zwei'], ['P-fremdkap', null]]);
  const q = await call('quote_match', { page_id: 910102, pattern: 'tür', occurrence: 2 });
  assert.equal(q.chapter_name, 'Eins');
  assert.equal(q.total_matches, 2);
});

test('search_passages (Regex) + get_dialogue: Scope-Filter auf Kapitel', async () => {
  const s = await call('search_passages', { pattern: 'Tür', regex: true, chapter_id: 91012 });
  assert.ok(s.results.length >= 2);
  assert.ok(s.results.every(x => x.chapter_id === 91012));
  const d = call('get_dialogue', { chapter_id: 91011 });
  assert.ok(d.results.length >= 1);
  assert.ok(d.results.every(x => x.page_id === 910101));
});

// ── Zeitstrahl / Kontinuität ────────────────────────────────────────────────

test('list_continuity_issues + get_timeline: Kapitel-/Seitennamen der Bridges', () => {
  const c = call('list_continuity_issues', { chapter_id: 91012 });
  assert.equal(c.total, 1);
  assert.equal(c.issues[0].kapitel[0].chapter_name, 'Eins');
  const t = call('get_timeline');
  assert.equal(t.events[0].kapitel[0].chapter_name, 'Zwei');
  assert.equal(t.events[0].seiten[0].page_name, 'P-ohne');
});
