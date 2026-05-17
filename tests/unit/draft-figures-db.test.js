'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

// Eigene Test-DB pro Lauf, sonst kollidiert das Test-Statement-Cache mit
// anderen Test-Suites, die parallel laufen (--test-concurrency=4).
const tmp = path.join('/tmp', `draft-figures-db-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = tmp;

const schema = require('../../db/schema');
const { db } = require('../../db/connection');
const appUsers = require('../../db/app-users');

// Mig 130 FK: user_email braucht app_users-Row.
for (const e of ['a@x.test', 'b@x.test', 'cascade@x.test', 'imp@x.test']) {
  appUsers.createUser({ email: e, displayName: e });
}

function sampleMindmap(name = 'Anna') {
  return {
    meta: { name: 'figur-werkstatt', version: '1' },
    format: 'node_tree',
    data: {
      id: 'root', topic: name,
      children: [
        { id: 'steckbrief', topic: 'Steckbrief', children: [
          { id: 'aussehen', topic: 'Aussehen' },
          { id: 'persoenlichkeit', topic: 'Persönlichkeit' },
        ]},
        { id: 'stimme', topic: 'Stimme', children: [] },
      ],
    },
  };
}

test('CRUD-Cycle für draft_figures', () => {
  schema.upsertBookByName(2042, 'Werkstatt-Test-Buch');
  const userA = 'a@x.test';
  const userB = 'b@x.test';

  // Create
  const created = schema.createDraftFigure(2042, userA, {
    name: 'Anna',
    archetype: 'protagonist',
    mindmap: sampleMindmap('Anna'),
    notes: 'Erste Skizze',
  });
  assert.ok(created.id);
  assert.equal(created.name, 'Anna');
  assert.equal(created.archetype, 'protagonist');
  assert.equal(created.user_email, userA);
  assert.equal(created.book_id, 2042);
  assert.equal(created.mindmap.data.topic, 'Anna');
  assert.equal(created.mindmap.data.children.length, 2);

  // Get
  const fetched = schema.getDraftFigure(created.id);
  assert.equal(fetched.id, created.id);
  assert.equal(fetched.notes, 'Erste Skizze');

  // List nur eigene
  const second = schema.createDraftFigure(2042, userA, {
    name: 'Boris', mindmap: sampleMindmap('Boris'),
  });
  schema.createDraftFigure(2042, userB, {
    name: 'Carla', mindmap: sampleMindmap('Carla'),
  });
  const listA = schema.listDraftFigures(2042, userA);
  assert.equal(listA.length, 2);
  // updated_at DESC: zweite Figur zuerst
  assert.equal(listA[0].id, second.id);

  // User B sieht nur eigene
  const listB = schema.listDraftFigures(2042, userB);
  assert.equal(listB.length, 1);
  assert.equal(listB[0].name, 'Carla');

  // Update
  const updatedMindmap = sampleMindmap('Anna');
  updatedMindmap.data.children.push({ id: 'subtext', topic: 'Subtext' });
  const updated = schema.updateDraftFigure(created.id, {
    name: 'Anna Schmidt',
    archetype: 'protagonist',
    mindmap: updatedMindmap,
    notes: 'Erweitert',
  });
  assert.equal(updated.name, 'Anna Schmidt');
  assert.equal(updated.mindmap.data.children.length, 3);
  assert.equal(updated.notes, 'Erweitert');

  // Delete
  schema.deleteDraftFigure(created.id);
  assert.equal(schema.getDraftFigure(created.id), null);
  assert.equal(schema.listDraftFigures(2042, userA).length, 1);
});

test('FK CASCADE: Buchlöschung räumt draft_figures auf', () => {
  schema.upsertBookByName(2099, 'Lösch-Buch');
  const user = 'cascade@x.test';

  schema.createDraftFigure(2099, user, { name: 'Ghost', mindmap: sampleMindmap('Ghost') });
  assert.equal(schema.listDraftFigures(2099, user).length, 1);

  // Löscht via FK CASCADE alle draft_figures dieses Buchs
  db.prepare('DELETE FROM books WHERE book_id = ?').run(2099);
  assert.equal(schema.listDraftFigures(2099, user).length, 0);
});

test('source_figure_id: roundtrip + LEFT JOIN auf figures.name', () => {
  schema.upsertBookByName(2050, 'Import-Buch');
  const user = 'imp@x.test';

  // figures-Eintrag minimal direkt einfügen (saveFigurenToDb verlangt idMaps).
  const now = new Date().toISOString();
  const info = db.prepare(`
    INSERT INTO figures (book_id, fig_id, name, typ, beschreibung, sort_order, user_email, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(2050, 'fig_anna', 'Anna Schmidt', 'Protagonist', 'Beschreibung', 0, user, now);
  const figureId = info.lastInsertRowid;

  const draft = schema.createDraftFigure(2050, user, {
    name: 'Anna Schmidt',
    archetype: 'protagonist',
    mindmap: sampleMindmap('Anna Schmidt'),
    sourceFigureId: figureId,
  });
  assert.equal(draft.source_figure_id, figureId);
  assert.equal(draft.source_figure_name, 'Anna Schmidt');

  // getDraftFigureBySource findet sie
  const found = schema.getDraftFigureBySource(2050, user, figureId);
  assert.equal(found.id, draft.id);

  // FK SET NULL: figures-Löschung räumt source_figure_id, aber Draft bleibt.
  db.prepare('DELETE FROM figures WHERE id = ?').run(figureId);
  const after = schema.getDraftFigure(draft.id);
  assert.equal(after.source_figure_id, null);
  assert.equal(after.source_figure_name, null);
  assert.equal(after.name, 'Anna Schmidt'); // Mindmap-Arbeit überlebt
});

test.after(() => {
  try { fs.unlinkSync(tmp); } catch {}
  try { fs.unlinkSync(tmp + '-journal'); } catch {}
  try { fs.unlinkSync(tmp + '-wal'); } catch {}
  try { fs.unlinkSync(tmp + '-shm'); } catch {}
});
