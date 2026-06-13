// Plot-Werkstatt (Beat-Board): DB-Layer (CRUD + Reorder) gegen eine Wegwerf-DB
// + Prompt-Builder/Schema-Form. Eigene DB pro Lauf (DB_PATH gesetzt, bevor
// db/* geladen wird), damit das Statement-Cache nicht mit parallelen Suites kollidiert.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.DB_PATH = path.join('/tmp', `plot-db-test-${process.pid}-${Date.now()}.db`);

const schema = require('../../db/schema');
const appUsers = require('../../db/app-users');
const plot = require('../../db/plot');

const USER = 'plot@x.test';
const BOOK = 770001;

function seed() {
  appUsers.createUser({ email: USER, displayName: 'Plot Tester' });
  schema.upsertBookByName(BOOK, 'Plot-Testbuch');
}

test('plot DB: Akt-CRUD + Positionsvergabe', () => {
  seed();
  const a1 = plot.createAct(BOOK, USER, { name: 'Akt 1' });
  const a2 = plot.createAct(BOOK, USER, { name: 'Akt 2' });
  assert.equal(a1.position, 0);
  assert.equal(a2.position, 1);

  const list = plot.listActs(BOOK, USER);
  assert.deepEqual(list.map(a => a.name), ['Akt 1', 'Akt 2']);

  const renamed = plot.updateAct(a1.id, { name: 'Auftakt' });
  assert.equal(renamed.name, 'Auftakt');

  plot.reorderActs(BOOK, USER, [a2.id, a1.id]);
  assert.deepEqual(plot.listActs(BOOK, USER).map(a => a.name), ['Akt 2', 'Auftakt']);
});

test('plot DB: Beat-CRUD inkl. Figuren-Links + Status', () => {
  const act = plot.createAct(BOOK, USER, { name: 'Beats-Akt' });
  const beat = plot.createBeat(BOOK, act.id, USER, { titel: 'Auftakt-Szene', status: 'geplant' });
  assert.equal(beat.act_id, act.id);
  assert.equal(beat.status, 'geplant');
  assert.equal(beat.sort_order, 0);
  assert.deepEqual(beat.fig_ids, []);

  const upd = plot.updateBeat(beat.id, { status: 'im_buch', beschreibung: 'Held tritt auf' }, undefined);
  assert.equal(upd.status, 'im_buch');
  assert.equal(upd.beschreibung, 'Held tritt auf');

  // listBeats liefert fig_ids-Aggregat
  const rows = plot.listBeats(BOOK, USER).filter(b => b.act_id === act.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].titel, 'Auftakt-Szene');

  plot.deleteBeat(beat.id);
  assert.equal(plot.listBeats(BOOK, USER).filter(b => b.act_id === act.id).length, 0);
});

test('plot DB: Beat-Reorder verschiebt act_id + sort_order', () => {
  const a = plot.createAct(BOOK, USER, { name: 'Quelle' });
  const b = plot.createAct(BOOK, USER, { name: 'Ziel' });
  const b1 = plot.createBeat(BOOK, a.id, USER, { titel: 'B1' });
  const b2 = plot.createBeat(BOOK, a.id, USER, { titel: 'B2' });

  // B1 nach Ziel verschieben, B2 in Quelle neu nummeriert
  plot.reorderBeats(BOOK, USER, [
    { actId: a.id, beatIds: [b2.id] },
    { actId: b.id, beatIds: [b1.id] },
  ]);

  const moved = plot.getBeat(b1.id);
  assert.equal(moved.act_id, b.id);
  assert.equal(moved.sort_order, 0);
  const stayed = plot.getBeat(b2.id);
  assert.equal(stayed.act_id, a.id);
  assert.equal(stayed.sort_order, 0);
});

test('plot DB: Akt-Löschung kaskadiert auf Beats (FK CASCADE)', () => {
  const act = plot.createAct(BOOK, USER, { name: 'Wegwerf-Akt' });
  const beat = plot.createBeat(BOOK, act.id, USER, { titel: 'verschwindet mit' });
  plot.deleteAct(act.id);
  assert.equal(plot.getBeat(beat.id), null);
});

// ── Prompts ──────────────────────────────────────────────────────────────────

const prompts = await import('../../public/js/prompts/plot.js');

test('plot prompts: Brainstorm nennt Ziel-Akt + listet Board + verlangt JSON', () => {
  const acts = [{ id: 1, name: 'Akt 1' }, { id: 2, name: 'Akt 2' }];
  const beats = [{ id: 9, act_id: 1, titel: 'Auftakt', status: 'geplant', chapter_name: null }];
  const out = prompts.buildPlotBrainstormPrompt('Akt 2', acts, beats, 'Krimi', [{ name: 'Anna', typ: 'Prot' }], ['Kap 1']);
  assert.ok(out.includes('Akt 2'));
  assert.ok(out.includes('AKT: Akt 1'));
  assert.ok(out.includes('Auftakt'));
  assert.ok(out.includes('"vorschlaege"'));
});

test('plot prompts: Consistency listet Status-Legende + Szenen-Realität', () => {
  const acts = [{ id: 1, name: 'Akt 1' }];
  const beats = [{ id: 9, act_id: 1, titel: 'Showdown', status: 'im_buch', chapter_name: 'Kap 3' }];
  const szenen = [{ titel: 'Duell', kapitel: 'Kap 3', figuren: ['Anna'] }];
  const out = prompts.buildPlotConsistencyPrompt(acts, beats, ['Kap 1', 'Kap 3'], szenen, [{ name: 'Anna' }], 'Krimi');
  assert.ok(out.includes('Showdown'));
  assert.ok(out.includes('im Buch'));     // Status-Label
  assert.ok(out.includes('Duell'));        // Szene als Realität
  assert.ok(out.includes('"konflikte"'));
  assert.ok(out.includes('"fazit"'));
});

test('plot prompts: Schemas haben die erwartete Form', () => {
  assert.deepEqual(prompts.SCHEMA_PLOT_BRAINSTORM.properties.vorschlaege.items.required.sort(), ['begruendung', 'label']);
  const k = prompts.SCHEMA_PLOT_CONSISTENCY.properties.konflikte.items;
  assert.deepEqual(k.required.sort(), ['beat', 'problem', 'schwere', 'vorschlag']);
  assert.deepEqual(prompts.PLOT_SEVERITY_ENUM, ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig']);
});

test('plot prompts: System-Prompt verbietet Fliesstext + erzwingt JSON (Claude-Modus)', () => {
  const sys = prompts.buildPlotSystemPrompt();
  assert.ok(/NIEMALS Fliesstext|kein.*Fliesstext|niemals.*Text/i.test(sys));
  assert.ok(sys.includes('JSON-Objekt'));
});
