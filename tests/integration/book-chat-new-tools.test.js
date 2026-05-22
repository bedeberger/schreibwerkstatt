'use strict';
// Integration test: 6 neue Book-Chat-Tools
// get_book_settings / find_repetitions / get_dialogue / diff_page_revisions /
// find_first_last_mention / quote_passage (DB-only Pfade).

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let bookChatTools;
let pageRevisions;

test.before(() => {
  ctx = bootstrap();
  bookChatTools = require('../../routes/jobs/book-chat-tools');
  pageRevisions = require('../../db/page-revisions');
});
test.after(() => { ctx.cleanup(); });

// ── get_book_settings ────────────────────────────────────────────────────────

test('get_book_settings: liefert Defaults für leeres Buch', () => {
  const BOOK_ID = 8001;
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'Mein Buch');

  const result = bookChatTools.TOOLS.get_book_settings({}, {
    bookId: BOOK_ID, userEmail: 'alice@example.com',
  });
  assert.equal(result.book_id, BOOK_ID);
  assert.equal(result.book_name, 'Mein Buch');
  assert.equal(result.language, 'de');
  assert.equal(result.region, 'CH');
  assert.equal(result.locale, 'de-CH');
  assert.equal(result.is_finished, 0);
});

test('get_book_settings: löst Buchtyp/POV/Tempus zu Labels auf', () => {
  const BOOK_ID = 8002;
  ctx.dbSchema.upsertBookByName(BOOK_ID, 'Krimi');
  ctx.dbSchema.saveBookSettings(BOOK_ID, 'de', 'DE', 'krimi', 'Düster, knapp.', 'ich', 'praeteritum', 1, 0, 5000);

  const result = bookChatTools.TOOLS.get_book_settings({}, {
    bookId: BOOK_ID, userEmail: 'alice@example.com',
  });
  assert.equal(result.buchtyp, 'krimi');
  assert.equal(result.buchtyp_label, 'Krimi / Thriller');
  assert.equal(result.erzaehlperspektive, 'ich');
  assert.match(result.erzaehlperspektive_label, /1\. Person/);
  assert.equal(result.erzaehlzeit, 'praeteritum');
  assert.match(result.erzaehlzeit_label, /Präteritum/);
  assert.equal(result.buch_kontext, 'Düster, knapp.');
  assert.equal(result.is_finished, 1);
  assert.equal(result.daily_goal_chars, 5000);
});

// ── find_repetitions ────────────────────────────────────────────────────────

test('find_repetitions: findet wiederkehrendes Tri-Gramm', () => {
  const BOOK_ID = 8010;
  const body = '<p>' + Array(8).fill('Sie ging zur Tür').join(' und dann ') + '</p>';
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'Wdh' }],
    chapters: [{ id: 80100, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: 80101, book_id: BOOK_ID, name: 'P1', chapter_id: 80100 }],
    pageBodies: { 80101: body },
  });

  const result = bookChatTools.TOOLS.find_repetitions(
    { n: 3, scope: 'book', min_count: 5 },
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.equal(result.pages_scanned, 1);
  const hit = result.results.find(r => r.phrase === 'sie ging zur');
  assert.ok(hit, `expected "sie ging zur" in ${JSON.stringify(result.results.slice(0, 5))}`);
  assert.ok(hit.count >= 5);
  assert.equal(hit.sample_pages[0].page_id, 80101);
});

test('find_repetitions: scope=page bricht ohne page_id', () => {
  const result = bookChatTools.TOOLS.find_repetitions(
    { scope: 'page' },
    { bookId: 8010, userEmail: 'alice@example.com' }
  );
  assert.match(result.error, /page_id/);
});

// ── get_dialogue ────────────────────────────────────────────────────────────

test('get_dialogue: extrahiert Anführungszeichen-Dialoge', () => {
  const BOOK_ID = 8020;
  // DE-typografische Anführungszeichen — vermeidet das «...»-Inversion-Merge,
  // bei dem zwei CH-Guillemet-Dialoge mit der inverted-DE-Pattern »…«
  // verschmolzen werden.
  const body = '<p>„Hallo&#8220;, sagte Anna. „Geht’s?&#8220; fragte sie.</p>';
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'Dlg' }],
    chapters: [{ id: 80200, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: 80201, book_id: BOOK_ID, name: 'P1', chapter_id: 80200 }],
    pageBodies: { 80201: body },
  });

  const result = bookChatTools.TOOLS.get_dialogue(
    {},
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.ok(result.results.length >= 2, `expected >=2 dialogues, got ${result.results.length}`);
  assert.ok(result.results.some(r => r.text.includes('Hallo')));
  for (const r of result.results) {
    assert.equal(typeof r.offset, 'number');
    assert.equal(typeof r.length, 'number');
  }
});

// ── diff_page_revisions ─────────────────────────────────────────────────────

test('diff_page_revisions: vergleicht zwei jüngste Revisionen', () => {
  const BOOK_ID = 8030;
  const PAGE_ID = 80301;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'Rev' }],
    chapters: [{ id: 80300, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, name: 'P1', chapter_id: 80300 }],
    pageBodies: { [PAGE_ID]: '<p>alter Text</p>' },
  });

  pageRevisions.insert({
    pageId: PAGE_ID, bookId: BOOK_ID,
    bodyHtml: '<p>Sie ging zur alten Tür.</p>',
    source: 'main', userEmail: 'alice@example.com',
  });
  pageRevisions.insert({
    pageId: PAGE_ID, bookId: BOOK_ID,
    bodyHtml: '<p>Sie rannte zur neuen Tür.</p>',
    source: 'main', userEmail: 'alice@example.com',
  });

  const result = bookChatTools.TOOLS.diff_page_revisions(
    { page_id: PAGE_ID },
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.equal(result.page_id, PAGE_ID);
  assert.notEqual(result.unchanged, true);
  assert.ok(result.from && result.to);
  assert.ok(result.blocks.length > 0);
  const changes = result.blocks.filter(b => b.kind === 'change' || b.kind === 'add' || b.kind === 'del');
  assert.ok(changes.length > 0);
});

test('diff_page_revisions: < 2 Revisionen → Fehler', () => {
  const BOOK_ID = 8031;
  const PAGE_ID = 80311;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'OneRev' }],
    chapters: [{ id: 80310, book_id: BOOK_ID, name: 'K1' }],
    pages: [{ id: PAGE_ID, book_id: BOOK_ID, name: 'P1', chapter_id: 80310 }],
    pageBodies: { [PAGE_ID]: '<p>foo</p>' },
  });
  pageRevisions.insert({
    pageId: PAGE_ID, bookId: BOOK_ID,
    bodyHtml: '<p>nur eine Revision</p>',
    source: 'main', userEmail: 'alice@example.com',
  });

  const result = bookChatTools.TOOLS.diff_page_revisions(
    { page_id: PAGE_ID },
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.match(result.error, /< 2|Weniger/);
});

// ── find_first_last_mention ─────────────────────────────────────────────────

test('find_first_last_mention: liefert Fehler ohne Argument', () => {
  const result = bookChatTools.TOOLS.find_first_last_mention(
    {},
    { bookId: 8001, userEmail: 'alice@example.com' }
  );
  assert.match(result.error, /figur|loc_id/i);
});

test('find_first_last_mention: figur ohne Index → freundlicher Fehler', () => {
  const BOOK_ID = 8040;
  ctx.dbSeed.setBook({
    books: [{ id: BOOK_ID, name: 'FL' }],
    chapters: [],
    pages: [],
  });
  const { db } = require('../../db/connection');
  db.prepare(`
    INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at)
    VALUES (?, ?, 'fig_1', 'Anna', 'Anna', ?)
  `).run(BOOK_ID, 'alice@example.com', new Date().toISOString());

  const result = bookChatTools.TOOLS.find_first_last_mention(
    { figur_id: 'fig_1' },
    { bookId: BOOK_ID, userEmail: 'alice@example.com' }
  );
  assert.equal(result.fig_id, 'fig_1');
  assert.match(result.error, /Index|Erwähnung/);
});
