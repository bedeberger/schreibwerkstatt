'use strict';
// Tests für routes/jobs/research-chat-tools.js:
//  - propose_research_item: Validierung (URL-Schema, Pflichtfelder, Cap) + Sammeln in ctx.proposals
//  - list_research_items / read_research_item: lesen vorhandenes Material
//  - list_book_entities: liefert Kontext-Kategorien
//
// Persistiert NICHTS automatisch — propose_research_item füllt nur ctx.proposals.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const tmpDb = path.join(os.tmpdir(), `schreibwerkstatt-rct-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

require('../../db/migrations');
const { db } = require('../../db/schema');
const { executeResearchTool } = require('../../routes/jobs/research-chat-tools');

const USER = 'tester@example.com';
const BOOK_ID = 70001;
const NOW = '2026-01-01T00:00:00.000Z';

// Seed: Buch + ein Recherche-Item.
db.prepare("INSERT INTO books (book_id, name, created_at, updated_at) VALUES (?, 'Testbuch', ?, ?)").run(BOOK_ID, NOW, NOW);
const itemRes = db.prepare(
  `INSERT INTO research_items (book_id, user_email, kind, title, body, url, source, created_at, updated_at)
   VALUES (?, ?, 'note', 'Bronzezeit', 'Notiz über Bronzezeit-Grabungen', '', 'Wikipedia', ?, ?)`
).run(BOOK_ID, USER, NOW, NOW);
const ITEM_ID = itemRes.lastInsertRowid;

const mkCtx = () => ({ bookId: BOOK_ID, userEmail: USER, proposals: [], logger: { warn() {}, info() {} } });

test('list_research_items liefert vorhandene Einträge', async () => {
  const out = await executeResearchTool('list_research_items', {}, mkCtx());
  assert.ok(Array.isArray(out.items));
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].title, 'Bronzezeit');
  assert.equal(out.items[0].kind, 'note');
});

test('read_research_item liefert Volltext', async () => {
  const out = await executeResearchTool('read_research_item', { id: ITEM_ID }, mkCtx());
  assert.equal(out.id, ITEM_ID);
  assert.match(out.body, /Bronzezeit-Grabungen/);
  assert.equal(out.source, 'Wikipedia');
});

test('read_research_item: unbekannte id → error', async () => {
  const out = await executeResearchTool('read_research_item', { id: 999999 }, mkCtx());
  assert.ok(out.error);
});

test('list_book_entities liefert Kontext-Kategorien', async () => {
  const out = await executeResearchTool('list_book_entities', {}, mkCtx());
  for (const k of ['figuren', 'schauplaetze', 'szenen', 'plot_abschnitte', 'handlungsstraenge']) {
    assert.ok(Array.isArray(out[k]), `${k} sollte ein Array sein`);
  }
});

test('propose_research_item: gültige Notiz wird in ctx.proposals gesammelt (NICHT persistiert)', async () => {
  const ctx = mkCtx();
  const before = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ?').get(BOOK_ID).n;
  const out = await executeResearchTool('propose_research_item',
    { kind: 'fact', title: 'Fundstück', body: 'Ein Fakt', source: 'https://example.org' }, ctx);
  assert.equal(out.ok, true);
  assert.equal(ctx.proposals.length, 1);
  assert.equal(ctx.proposals[0].kind, 'fact');
  // Kein DB-Insert — der User bestätigt erst im Frontend.
  const after = db.prepare('SELECT COUNT(*) AS n FROM research_items WHERE book_id = ?').get(BOOK_ID).n;
  assert.equal(after, before);
});

test('propose_research_item: nicht-http(s)-URL wird abgelehnt', async () => {
  const ctx = mkCtx();
  const out = await executeResearchTool('propose_research_item',
    { kind: 'link', title: 'Böse', url: 'javascript:alert(1)' }, ctx);
  assert.equal(out.ok, false);
  assert.equal(ctx.proposals.length, 0);
});

test('propose_research_item: leerer Vorschlag wird abgelehnt', async () => {
  const ctx = mkCtx();
  const out = await executeResearchTool('propose_research_item', { kind: 'note' }, ctx);
  assert.equal(out.ok, false);
  assert.equal(ctx.proposals.length, 0);
});

test('unbekanntes Werkzeug wirft', async () => {
  await assert.rejects(() => executeResearchTool('nope', {}, mkCtx()), /Unbekanntes Werkzeug/);
});
