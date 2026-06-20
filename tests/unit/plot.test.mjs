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
const draftFigures = require('../../db/draft-figures');
const { db } = require('../../db/connection');

const USER = 'plot@x.test';
const BOOK = 770001;

function seed() {
  appUsers.createUser({ email: USER, displayName: 'Plot Tester' });
  schema.upsertBookByName(BOOK, 'Plot-Testbuch');
}

// Figur direkt anlegen — fig_id (TEXT, Frontend-Identität) + id (INTEGER PK).
function seedFigur(bookId, userEmail, figId, name) {
  return db.prepare(
    `INSERT INTO figures (book_id, user_email, fig_id, name, kurzname, updated_at)
     VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`
  ).run(bookId, userEmail, figId, name, name).lastInsertRowid;
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

test('plot DB: Beat-Figuren persistieren als TEXT-fig_id (id↔fig_id-Übersetzung)', () => {
  const anna = seedFigur(BOOK, USER, 'fig_anna', 'Anna');
  const bert = seedFigur(BOOK, USER, 'fig_bert', 'Bert');
  // resolveFigureIds übersetzt die Frontend-fig_ids in INTEGER figures.id
  const annaIds = plot.resolveFigureIds(BOOK, USER, ['fig_anna']);
  assert.deepEqual(annaIds, [anna]);

  const act = plot.createAct(BOOK, USER, { name: 'Fig-Akt' });
  // createBeat erwartet bereits aufgelöste INTEGER-ids (wie der Route-Handler liefert)
  const beat = plot.createBeat(BOOK, act.id, USER, { titel: 'Treffen', figureIds: [anna] });
  // ... Lese-Aggregat gibt aber die TEXT-fig_id zurück (Frontend-Identität)
  assert.deepEqual(beat.fig_ids, ['fig_anna']);

  // Update ersetzt die Links komplett (Anna + Bert)
  const upd = plot.updateBeat(beat.id, {}, plot.resolveFigureIds(BOOK, USER, ['fig_anna', 'fig_bert']));
  assert.deepEqual([...upd.fig_ids].sort(), ['fig_anna', 'fig_bert']);
  // listBeats spiegelt denselben Stand
  const reread = plot.listBeats(BOOK, USER).find(b => b.id === beat.id);
  assert.deepEqual([...reread.fig_ids].sort(), ['fig_anna', 'fig_bert']);

  // Leeres Array löscht alle Links
  const cleared = plot.updateBeat(beat.id, {}, []);
  assert.deepEqual(cleared.fig_ids, []);

  plot.deleteAct(act.id);
});

test('plot DB: Beat-Intensität (1–5) persistiert + lässt sich nullen', () => {
  const act = plot.createAct(BOOK, USER, { name: 'Spannungs-Akt' });
  const beat = plot.createBeat(BOOK, act.id, USER, { titel: 'Showdown', intensitaet: 5 });
  assert.equal(beat.intensitaet, 5);

  // listBeats/getBeat spiegeln den Wert
  assert.equal(plot.getBeat(beat.id).intensitaet, 5);
  assert.equal(plot.listBeats(BOOK, USER).find(b => b.id === beat.id).intensitaet, 5);

  // partielles Update ändert nur die Intensität
  assert.equal(plot.updateBeat(beat.id, { intensitaet: 2 }, undefined).intensitaet, 2);
  // null setzt zurück
  assert.equal(plot.updateBeat(beat.id, { intensitaet: null }, undefined).intensitaet, null);

  // Default beim Anlegen ohne Wert ist NULL
  const plain = plot.createBeat(BOOK, act.id, USER, { titel: 'Ohne Spannung' });
  assert.equal(plain.intensitaet, null);

  plot.deleteAct(act.id);
});

test('plot DB: CHECK-Constraint lehnt Intensität ausserhalb 1–5 ab', () => {
  const act = plot.createAct(BOOK, USER, { name: 'Check-Akt' });
  // createBeat schreibt den Wert ungefiltert (Route validiert) — DB-CHECK greift.
  assert.throws(() => plot.createBeat(BOOK, act.id, USER, { titel: 'Zu hoch', intensitaet: 9 }));
  plot.deleteAct(act.id);
});

test('plot DB: Beat-Werkstatt-Figuren (draft_figures) linken + persistieren', () => {
  const act = plot.createAct(BOOK, USER, { name: 'Werkstatt-Akt' });
  const d1 = draftFigures.createDraftFigure(BOOK, USER, { name: 'Entwurf-Held', mindmap: { topic: 'Entwurf-Held' } });
  const d2 = draftFigures.createDraftFigure(BOOK, USER, { name: 'Entwurf-Gegner', mindmap: { topic: 'Entwurf-Gegner' } });

  // resolveDraftFigureIds filtert aufs (Buch, User)-Subset; IDs sind INTEGER (keine TEXT-Indirektion)
  assert.deepEqual(plot.resolveDraftFigureIds(BOOK, USER, [d1.id, d2.id]).sort((a, b) => a - b), [d1.id, d2.id].sort((a, b) => a - b));

  const beat = plot.createBeat(BOOK, act.id, USER, { titel: 'Konfrontation', draftFigureIds: [d1.id] });
  assert.deepEqual(beat.draft_fig_ids, [d1.id]);
  assert.deepEqual(beat.fig_ids, []); // Katalog- und Werkstatt-Brücke sind getrennt

  // Update ersetzt die Werkstatt-Links komplett, ohne die (leeren) Katalog-Links anzufassen
  const upd = plot.updateBeat(beat.id, {}, undefined, [d1.id, d2.id]);
  assert.deepEqual([...upd.draft_fig_ids].sort((a, b) => a - b), [d1.id, d2.id].sort((a, b) => a - b));

  // listBeats spiegelt denselben Stand
  const reread = plot.listBeats(BOOK, USER).find(b => b.id === beat.id);
  assert.deepEqual([...reread.draft_fig_ids].sort((a, b) => a - b), [d1.id, d2.id].sort((a, b) => a - b));

  // Leeres Array löscht alle Werkstatt-Links
  const cleared = plot.updateBeat(beat.id, {}, undefined, []);
  assert.deepEqual(cleared.draft_fig_ids, []);

  plot.deleteAct(act.id);
});

test('plot DB: resolveDraftFigureIds filtert Fremd-/Unbekannt-IDs raus', () => {
  const own = draftFigures.createDraftFigure(BOOK, USER, { name: 'Eigen-Draft', mindmap: { topic: 'Eigen' } });
  appUsers.createUser({ email: 'plot-foreign@x.test', displayName: 'Fremd' });
  const foreign = draftFigures.createDraftFigure(BOOK, 'plot-foreign@x.test', { name: 'Fremd-Draft', mindmap: { topic: 'Fremd' } });
  const resolved = plot.resolveDraftFigureIds(BOOK, USER, [own.id, foreign.id, 99999]);
  assert.deepEqual(resolved, [own.id]);
  assert.deepEqual(plot.resolveDraftFigureIds(BOOK, USER, []), []);
});

test('plot DB: resolveFigureIds filtert Fremd-/Unbekannt-fig_ids raus', () => {
  const own = seedFigur(BOOK, USER, 'fig_own', 'Eigen');
  appUsers.createUser({ email: 'someone-else@x.test', displayName: 'Fremd' });
  seedFigur(BOOK, 'someone-else@x.test', 'fig_foreign', 'Fremd'); // anderer User
  const resolved = plot.resolveFigureIds(BOOK, USER, ['fig_own', 'fig_foreign', 'fig_ghost']);
  assert.deepEqual(resolved, [own]);
  assert.deepEqual(plot.resolveFigureIds(BOOK, USER, []), []);
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

// ── Handlungsstränge (Swimlanes) ───────────────────────────────────────────

test('plot DB: Strang-CRUD + Positionsvergabe + Reorder', () => {
  const t1 = plot.createThread(BOOK, USER, { name: 'Strang A' });
  const t2 = plot.createThread(BOOK, USER, { name: 'Strang B' });
  assert.equal(t1.position, 0);
  assert.equal(t2.position, 1);
  assert.deepEqual(plot.listThreads(BOOK, USER).map(t => t.name), ['Strang A', 'Strang B']);

  const renamed = plot.updateThread(t1.id, { name: 'Haupt-Strang', farbe: 'blue' });
  assert.equal(renamed.name, 'Haupt-Strang');
  assert.equal(renamed.farbe, 'blue');

  plot.reorderThreads(BOOK, USER, [t2.id, t1.id]);
  assert.deepEqual(plot.listThreads(BOOK, USER).map(t => t.name), ['Strang B', 'Haupt-Strang']);

  plot.deleteThread(t1.id);
  plot.deleteThread(t2.id);
  assert.equal(plot.listThreads(BOOK, USER).length, 0);
});

test('plot DB: Strang-Figuren-Bindung — Katalog exponiert TEXT-fig_id, Werkstatt INTEGER-id', () => {
  const carl = seedFigur(BOOK, USER, 'fig_carl', 'Carl');
  const draft = draftFigures.createDraftFigure(BOOK, USER, { name: 'Entwurf-Strang-Figur', mindmap: { topic: 'x' } });

  // Katalog-Bindung: createThread bekommt INTEGER figures.id (wie Route nach resolveFigureIds liefert)
  const tCat = plot.createThread(BOOK, USER, { name: 'Carls Strang', figureId: carl });
  assert.equal(tCat.figure_id, carl);
  assert.equal(tCat.fig_id, 'fig_carl');         // Lese-Aggregat liefert die Frontend-Identität
  assert.equal(tCat.draft_figure_id, null);

  // Werkstatt-Bindung: draft_figures.id ist bereits die Frontend-Identität
  const tDraft = plot.createThread(BOOK, USER, { name: 'Entwurf-Strang', draftFigureId: draft.id });
  assert.equal(tDraft.draft_figure_id, draft.id);
  assert.equal(tDraft.figure_id, null);
  assert.equal(tDraft.fig_id, null);

  // Bindung lässt sich nullen
  const cleared = plot.updateThread(tCat.id, { name: 'Carls Strang', figureId: null });
  assert.equal(cleared.figure_id, null);
  assert.equal(cleared.fig_id, null);

  plot.deleteThread(tCat.id);
  plot.deleteThread(tDraft.id);
});

test('plot DB: _validThreadId filtert Fremd-/Unbekannt-Stränge raus', () => {
  const own = plot.createThread(BOOK, USER, { name: 'Eigen-Strang' });
  appUsers.createUser({ email: 'thread-foreign@x.test', displayName: 'Fremd' });
  const foreign = plot.createThread(BOOK, 'thread-foreign@x.test', { name: 'Fremd-Strang' });

  assert.equal(plot._validThreadId(BOOK, USER, own.id), own.id);
  assert.equal(plot._validThreadId(BOOK, USER, foreign.id), null); // anderer User
  assert.equal(plot._validThreadId(BOOK, USER, 999999), null);     // unbekannt
  assert.equal(plot._validThreadId(BOOK, USER, null), null);

  plot.deleteThread(own.id);
  plot.deleteThread(foreign.id);
});

test('plot DB: Beat trägt thread_id; sort_order ist pro Zelle (Akt × Strang)', () => {
  const act = plot.createAct(BOOK, USER, { name: 'Zell-Akt' });
  const t1 = plot.createThread(BOOK, USER, { name: 'Zeile 1' });
  const t2 = plot.createThread(BOOK, USER, { name: 'Zeile 2' });

  // Zwei Beats in derselben Zelle (act, t1) → sort_order 0,1
  const b1 = plot.createBeat(BOOK, act.id, USER, { titel: 'A', threadId: t1.id });
  const b2 = plot.createBeat(BOOK, act.id, USER, { titel: 'B', threadId: t1.id });
  assert.equal(b1.thread_id, t1.id);
  assert.equal(b1.sort_order, 0);
  assert.equal(b2.sort_order, 1);

  // Beat in anderer Zelle (act, t2) startet wieder bei 0 (per-Zelle, nicht per-Akt)
  const b3 = plot.createBeat(BOOK, act.id, USER, { titel: 'C', threadId: t2.id });
  assert.equal(b3.sort_order, 0);

  // „ohne Strang"-Lane (thread_id null) ist eine eigene Zelle, ebenfalls ab 0
  const b4 = plot.createBeat(BOOK, act.id, USER, { titel: 'D' });
  assert.equal(b4.thread_id, null);
  assert.equal(b4.sort_order, 0);

  plot.deleteAct(act.id);
  plot.deleteThread(t1.id);
  plot.deleteThread(t2.id);
});

test('plot DB: 2D-Reorder setzt act_id + thread_id + sort_order', () => {
  const act = plot.createAct(BOOK, USER, { name: '2D-Akt' });
  const t1 = plot.createThread(BOOK, USER, { name: 'T1' });
  const t2 = plot.createThread(BOOK, USER, { name: 'T2' });
  const b1 = plot.createBeat(BOOK, act.id, USER, { titel: 'X', threadId: t1.id });
  const b2 = plot.createBeat(BOOK, act.id, USER, { titel: 'Y', threadId: t1.id });

  // b1 in Zelle (act, t2) verschieben, b2 bleibt in (act, t1)
  plot.reorderBeats(BOOK, USER, [
    { actId: act.id, threadId: t1.id, beatIds: [b2.id] },
    { actId: act.id, threadId: t2.id, beatIds: [b1.id] },
  ]);
  const moved = plot.getBeat(b1.id);
  assert.equal(moved.thread_id, t2.id);
  assert.equal(moved.sort_order, 0);
  const stayed = plot.getBeat(b2.id);
  assert.equal(stayed.thread_id, t1.id);
  assert.equal(stayed.sort_order, 0);

  // Reorder in die „ohne Strang"-Lane (threadId weggelassen → null)
  plot.reorderBeats(BOOK, USER, [{ actId: act.id, beatIds: [b1.id] }]);
  assert.equal(plot.getBeat(b1.id).thread_id, null);

  plot.deleteAct(act.id);
  plot.deleteThread(t1.id);
  plot.deleteThread(t2.id);
});

test('plot DB: Strang-Löschung setzt Beat.thread_id auf NULL (SET NULL, Beat bleibt)', () => {
  const act = plot.createAct(BOOK, USER, { name: 'SetNull-Akt' });
  const thread = plot.createThread(BOOK, USER, { name: 'Vergänglicher Strang' });
  const beat = plot.createBeat(BOOK, act.id, USER, { titel: 'überlebt', threadId: thread.id });
  assert.equal(beat.thread_id, thread.id);

  plot.deleteThread(thread.id);
  const survivor = plot.getBeat(beat.id);
  assert.ok(survivor, 'Beat darf nicht mitgelöscht werden');
  assert.equal(survivor.thread_id, null, 'thread_id fällt auf NULL (ohne Strang)');

  plot.deleteAct(act.id);
});

test('plot DB: updateBeat kann thread_id setzen + nullen (PATCH-Pfad)', () => {
  const act = plot.createAct(BOOK, USER, { name: 'Patch-Akt' });
  const thread = plot.createThread(BOOK, USER, { name: 'Patch-Strang' });
  const beat = plot.createBeat(BOOK, act.id, USER, { titel: 'zu' });
  assert.equal(beat.thread_id, null);

  assert.equal(plot.updateBeat(beat.id, { thread_id: thread.id }, undefined).thread_id, thread.id);
  assert.equal(plot.updateBeat(beat.id, { thread_id: null }, undefined).thread_id, null);

  plot.deleteAct(act.id);
  plot.deleteThread(thread.id);
});

// ── Hybrid-Akte (eigene Aktstruktur pro Strang) ──────────────────────────────

test('plot DB: forkThreadActs klont geteilte Akte in den Strang + hängt Beats um', () => {
  const a1 = plot.createAct(BOOK, USER, { name: 'H-A1' });
  const a2 = plot.createAct(BOOK, USER, { name: 'H-A2' });
  const t = plot.createThread(BOOK, USER, { name: 'Fork-Strang' });
  const beat = plot.createBeat(BOOK, a1.id, USER, { titel: 'geforkt', threadId: t.id });
  // Geteilte Akte vor dem Fork (das Test-BOOK kann Akte aus anderen Tests tragen).
  const sharedBefore = plot.listActs(BOOK, USER).filter(a => a.thread_id == null).length;

  assert.equal(plot.threadHasOwnActs(BOOK, USER, t.id), false);
  plot.forkThreadActs(BOOK, USER, t.id);
  assert.equal(plot.threadHasOwnActs(BOOK, USER, t.id), true);

  // Es gibt jetzt strang-eigene Klone (thread_id = t.id), je geteiltem Akt einen.
  const own = plot.listActs(BOOK, USER).filter(a => a.thread_id === t.id);
  assert.equal(own.length, sharedBefore);
  assert.ok(own.some(a => a.name === 'H-A1') && own.some(a => a.name === 'H-A2'));

  // Der Beat sitzt nicht mehr auf dem geteilten Akt, sondern auf dem H-A1-Klon.
  const moved = plot.getBeat(beat.id);
  assert.notEqual(moved.act_id, a1.id);
  assert.equal(moved.thread_id, t.id);
  assert.equal(plot.getAct(moved.act_id).name, 'H-A1');

  plot.deleteThread(t.id);
  plot.deleteAct(a1.id);
  plot.deleteAct(a2.id);
});

test('plot DB: unforkThreadActs hängt Beats zurück auf geteilte Akte + löscht eigene', () => {
  const a1 = plot.createAct(BOOK, USER, { name: 'U-A1' });
  const t = plot.createThread(BOOK, USER, { name: 'Unfork-Strang' });
  const beat = plot.createBeat(BOOK, a1.id, USER, { titel: 'zurück', threadId: t.id });
  plot.forkThreadActs(BOOK, USER, t.id);
  assert.equal(plot.threadHasOwnActs(BOOK, USER, t.id), true);

  plot.unforkThreadActs(BOOK, USER, t.id);
  assert.equal(plot.threadHasOwnActs(BOOK, USER, t.id), false);
  // Beat lebt weiter und sitzt wieder auf einem geteilten Akt (thread_id NULL).
  const back = plot.getBeat(beat.id);
  assert.equal(back.act_id, a1.id);
  const act = plot.getAct(back.act_id);
  assert.equal(act.thread_id, null);

  plot.deleteThread(t.id);
  plot.deleteAct(a1.id);
});

test('plot DB: deleteThread mit eigenen Akten verliert keine Beats (auf geteilte umgehängt)', () => {
  const a1 = plot.createAct(BOOK, USER, { name: 'D-A1' });
  const t = plot.createThread(BOOK, USER, { name: 'Del-Strang' });
  const beat = plot.createBeat(BOOK, a1.id, USER, { titel: 'überlebt', threadId: t.id });
  plot.forkThreadActs(BOOK, USER, t.id);

  plot.deleteThread(t.id);
  const survivor = plot.getBeat(beat.id);
  assert.ok(survivor, 'Beat überlebt die Strang-Löschung');
  assert.equal(survivor.thread_id, null, 'fällt in die „ohne Strang"-Lane');
  assert.equal(survivor.act_id, a1.id, 'sitzt auf dem geteilten Akt');

  plot.deleteAct(a1.id);
});

test('plot DB: createAct mit threadId nummeriert position pro Scope', () => {
  const shared = plot.createAct(BOOK, USER, { name: 'S-A1' });
  const t = plot.createThread(BOOK, USER, { name: 'Scope-Strang' });
  const own1 = plot.createAct(BOOK, USER, { name: 'O-A1', threadId: t.id });
  const own2 = plot.createAct(BOOK, USER, { name: 'O-A2', threadId: t.id });
  // Strang-eigene Akte starten ihre eigene 0..n-Sequenz, unabhängig von geteilten.
  assert.equal(own1.thread_id, t.id);
  assert.equal(own1.position, 0);
  assert.equal(own2.position, 1);

  plot.deleteThread(t.id);
  plot.deleteAct(shared.id);
});

// ── Brainstorm-Lauf-Historie ─────────────────────────────────────────────────

test('plot DB: Brainstorm-Run insert/list/get/delete + JOIN auf Akt/Strang-Name', () => {
  const act = plot.createAct(BOOK, USER, { name: 'BR-Akt' });
  const thread = plot.createThread(BOOK, USER, { name: 'BR-Strang' });
  const runId = plot.insertPlotBrainstormRun({
    bookId: BOOK, userEmail: USER, actId: act.id, threadId: thread.id,
    vorschlagCount: 2, result: { vorschlaege: [{ label: 'A', begruendung: 'x' }, { label: 'B', begruendung: 'y' }] },
    model: 'test-model',
  });
  assert.ok(runId);

  const list = plot.listPlotBrainstormRuns(BOOK, USER);
  const row = list.find(r => r.id === runId);
  assert.ok(row);
  assert.equal(row.vorschlag_count, 2);
  assert.equal(row.act_name, 'BR-Akt');     // via JOIN, kein Snapshot
  assert.equal(row.thread_name, 'BR-Strang');
  assert.equal(row.result_json, undefined);  // Liste ohne result_json

  const detail = plot.getPlotBrainstormRun(runId);
  assert.equal(detail.result.vorschlaege.length, 2);
  assert.equal(detail.result.vorschlaege[0].label, 'A');
  assert.equal(detail.act_id, act.id);

  // Fremd-User darf nicht löschen.
  assert.equal(plot.deletePlotBrainstormRun(runId, 'someone@else.test'), 0);
  assert.equal(plot.deletePlotBrainstormRun(runId, USER), 1);
  assert.equal(plot.listPlotBrainstormRuns(BOOK, USER).find(r => r.id === runId), undefined);

  plot.deleteThread(thread.id);
  plot.deleteAct(act.id);
});

test('plot DB: Brainstorm-Run überlebt Akt-/Strang-Löschung (FK SET NULL, Name → null)', () => {
  const act = plot.createAct(BOOK, USER, { name: 'Vergänglich' });
  const thread = plot.createThread(BOOK, USER, { name: 'Auch-weg' });
  const runId = plot.insertPlotBrainstormRun({
    bookId: BOOK, userEmail: USER, actId: act.id, threadId: thread.id,
    vorschlagCount: 1, result: { vorschlaege: [{ label: 'X', begruendung: '' }] }, model: null,
  });
  plot.deleteAct(act.id);
  plot.deleteThread(thread.id);

  const row = plot.listPlotBrainstormRuns(BOOK, USER).find(r => r.id === runId);
  assert.ok(row, 'Lauf bleibt erhalten');
  assert.equal(row.act_id, null);      // SET NULL
  assert.equal(row.thread_id, null);
  assert.equal(row.act_name, null);    // JOIN findet keinen Akt mehr
  assert.equal(row.thread_name, null);

  plot.deletePlotBrainstormRun(runId, USER);
});

// ── Prompts ──────────────────────────────────────────────────────────────────

const prompts = await import('../../public/js/prompts/plot.js');

test('plot prompts: Board-Outline kennzeichnet geteilte vs. strang-eigene Akte + Hybrid-Hinweis', () => {
  const acts = [{ id: 1, name: 'Geteilt' }, { id: 2, name: 'Eigen', thread_id: 7 }];
  const beats = [{ id: 9, act_id: 2, thread_id: 7, titel: 'B', status: 'geplant', chapter_name: null }];
  const threads = [{ id: 7, name: 'Mara', figur: null }];
  const out = prompts.buildPlotConsistencyPrompt(acts, beats, [], [], [], '', [], threads);
  assert.ok(out.includes('AKT (geteilt): Geteilt'));
  assert.ok(out.includes('eigener Akt von Strang „Mara"'));
  assert.ok(out.includes('HYBRID-AKTE'));
});

test('plot prompts: Brainstorm nennt Ziel-Akt + listet Board + Werkstatt-Figuren + verlangt JSON', () => {
  const acts = [{ id: 1, name: 'Akt 1' }, { id: 2, name: 'Akt 2' }];
  const beats = [{ id: 9, act_id: 1, titel: 'Auftakt', status: 'geplant', chapter_name: null }];
  const out = prompts.buildPlotBrainstormPrompt('Akt 2', acts, beats, 'Krimi',
    [{ name: 'Anna', typ: 'Prot' }], ['Kap 1'], [{ name: 'Mara', archetype: 'mentor' }]);
  assert.ok(out.includes('Akt 2'));
  assert.ok(out.includes('AKT (geteilt): Akt 1'));
  assert.ok(out.includes('Auftakt'));
  assert.ok(out.includes('FIGUREN-WERKSTATT'));
  assert.ok(out.includes('Mara'));
  assert.ok(out.includes('mentor'));
  assert.ok(out.includes('"vorschlaege"'));
});

test('plot prompts: Brainstorm ohne Werkstatt-Figuren lässt den Block weg', () => {
  const out = prompts.buildPlotBrainstormPrompt('Akt 1', [{ id: 1, name: 'Akt 1' }], [], '', [], []);
  assert.ok(!out.includes('FIGUREN-WERKSTATT'));
});

test('plot prompts: Brainstorm rendert reichen Katalog-Figuren-Kontext (Kurzname/Meta/Beschreibung/Tags)', () => {
  const figuren = [{
    name: 'Anna Held', kurzname: 'Anni', typ: 'Protagonistin', beruf: 'Kommissarin',
    geschlecht: 'weiblich', beschreibung: 'Zynische Ermittlerin mit Vergangenheit.',
    tags: ['traumatisiert', 'loyal'],
  }];
  const out = prompts.buildPlotBrainstormPrompt('Akt 1', [{ id: 1, name: 'Akt 1' }], [], '', figuren);
  assert.ok(out.includes('FIGUREN-ENSEMBLE'));
  assert.ok(out.includes('Anna Held'));
  assert.ok(out.includes('Anni'));
  assert.ok(out.includes('Kommissarin'));
  assert.ok(out.includes('Zynische Ermittlerin mit Vergangenheit.'));
  assert.ok(out.includes('traumatisiert, loyal'));
});

test('plot prompts: Brainstorm kürzt überlange Figuren-Beschreibung', () => {
  const lang = 'X'.repeat(400);
  const out = prompts.buildPlotBrainstormPrompt('Akt 1', [{ id: 1, name: 'Akt 1' }], [], '',
    [{ name: 'Anna', beschreibung: lang }]);
  assert.ok(out.includes('…'));
  assert.ok(!out.includes('X'.repeat(300)));
});

test('plot prompts: Consistency listet Status-Legende + Szenen-Realität + Werkstatt-Figuren', () => {
  const acts = [{ id: 1, name: 'Akt 1' }];
  const beats = [{ id: 9, act_id: 1, titel: 'Showdown', status: 'im_buch', chapter_name: 'Kap 3' }];
  const szenen = [{ titel: 'Duell', kapitel: 'Kap 3', figuren: ['Anna'] }];
  const out = prompts.buildPlotConsistencyPrompt(acts, beats, ['Kap 1', 'Kap 3'], szenen,
    [{ name: 'Anna' }], 'Krimi', [{ name: 'Mara', archetype: 'mentor' }]);
  assert.ok(out.includes('Showdown'));
  assert.ok(out.includes('im Buch'));     // Status-Label
  assert.ok(out.includes('Duell'));        // Szene als Realität
  assert.ok(out.includes('FIGUREN-WERKSTATT'));
  assert.ok(out.includes('Mara'));
  assert.ok(out.includes('"konflikte"'));
  assert.ok(out.includes('"fazit"'));
});

test('plot prompts: Brainstorm mit Ziel-Strang nennt Strang + Hauptfigur + filtert Beats der Zelle', () => {
  const acts = [{ id: 1, name: 'Akt 1' }];
  const beats = [
    { id: 9, act_id: 1, thread_id: 7, titel: 'Maras Aufbruch', status: 'geplant', chapter_name: null },
    { id: 10, act_id: 1, thread_id: 8, titel: 'Lucas Plan', status: 'geplant', chapter_name: null },
  ];
  const threads = [{ id: 7, name: 'Mara', figur: 'Mara Stein' }, { id: 8, name: 'Luca', figur: null }];
  const out = prompts.buildPlotBrainstormPrompt('Akt 1', acts, beats, '', [], [], [], threads, threads[0]);
  assert.ok(out.includes('HANDLUNGSSTRÄNGE'));
  assert.ok(out.includes('ZIEL-STRANG: "Mara"'));
  assert.ok(out.includes('Mara Stein'));            // gebundene Hauptfigur
  assert.ok(out.includes('{Strang: Mara}'));        // Board-Annotation
  // Existierende Beats sind auf die Zelle (Strang 7) gefiltert: Maras Beat ja, Lucas nein
  assert.ok(out.includes('IN DIESER ZELLE'));
  assert.ok(out.includes('Maras Aufbruch'));
  const existingBlock = out.split('IN DIESER ZELLE')[1] || '';
  assert.ok(!existingBlock.includes('Lucas Plan'));
});

test('plot prompts: Consistency mit Strängen listet Stränge + Strang-Prüfpunkte', () => {
  const acts = [{ id: 1, name: 'Akt 1' }];
  const beats = [{ id: 9, act_id: 1, thread_id: 7, titel: 'Showdown', status: 'geplant', chapter_name: null }];
  const threads = [{ id: 7, name: 'Mara', figur: 'Mara Stein' }];
  const out = prompts.buildPlotConsistencyPrompt(acts, beats, [], [], [], '', [], threads);
  assert.ok(out.includes('HANDLUNGSSTRÄNGE'));
  assert.ok(out.includes('Mara'));
  assert.ok(/Strang-Balance|vollständiger Bogen|POV/i.test(out)); // Strang-spezifische Checks
  assert.ok(out.includes('{Strang: Mara}'));
});

test('plot prompts: ohne Stränge bleibt der Strang-Block weg (Abwärtskompat)', () => {
  const acts = [{ id: 1, name: 'Akt 1' }];
  const beats = [{ id: 9, act_id: 1, titel: 'Auftakt', status: 'geplant', chapter_name: null }];
  const bs = prompts.buildPlotBrainstormPrompt('Akt 1', acts, beats, '', [], []);
  assert.ok(!bs.includes('HANDLUNGSSTRÄNGE'));
  assert.ok(!bs.includes('ZIEL-STRANG'));
  const cons = prompts.buildPlotConsistencyPrompt(acts, beats, [], [], [], '');
  assert.ok(!cons.includes('HANDLUNGSSTRÄNGE'));
  assert.ok(!cons.includes('Strang-Balance'));
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

// ── Frontend-Logik (plotMethods, pure Helfer ohne Alpine/DOM) ────────────────

const { plotMethods } = await import('../../public/js/book/plot.js');

// Minimaler Karten-Kontext: plotMethods auf ein Plain-Object gemappt, `this`=ctx.
function makeCtx({ beats = [], acts = [], verworfenOpen = {} } = {}) {
  return Object.assign(
    { _memos: {}, beats, acts, verworfenOpen, plotFilters: { kapitel: '', figurId: '', draftFigurId: '' } },
    plotMethods,
  );
}

test('plotMethods.actAccent: Palette-Key → --palette-*, sonst Karten-Akzent', () => {
  const ctx = makeCtx();
  assert.equal(ctx.actAccent({ farbe: 'green' }), 'var(--palette-green)');
  assert.equal(ctx.actAccent({ farbe: null }), 'var(--card-accent)');
  // Nicht-Whitelist-Wert fällt zurück (keine CSS-Injection aus dem Freitextfeld)
  assert.equal(ctx.actAccent({ farbe: 'evil); }' }), 'var(--card-accent)');
});

test('plotMethods.boardStats/_computeStats: Status-Zählung + imBuch/geplant-Spiegel', () => {
  const ctx = makeCtx({ beats: [
    { status: 'geplant' }, { status: 'geplant' }, { status: 'im_buch' },
    { status: 'entwurf' }, { status: 'verworfen' },
  ] });
  const s = ctx.boardStats();
  assert.equal(s.total, 5);
  assert.deepEqual(s.by, { geplant: 2, entwurf: 1, im_buch: 1, verworfen: 1 });
  assert.equal(s.imBuch, 1);
  assert.equal(s.geplant, 2);
});

test('plotMethods.tensionCurve: nur Beats mit Intensität, Board-Reihenfolge, verworfen excluded', () => {
  const acts = [{ id: 1, name: 'A1', position: 0 }, { id: 2, name: 'A2', position: 1 }];
  const beats = [
    { id: 10, act_id: 2, sort_order: 0, status: 'geplant', intensitaet: 4, titel: 'Mitte' },
    { id: 11, act_id: 1, sort_order: 1, status: 'im_buch', intensitaet: 2, titel: 'Auftakt2' },
    { id: 12, act_id: 1, sort_order: 0, status: 'geplant', intensitaet: 1, titel: 'Auftakt1' },
    { id: 13, act_id: 2, sort_order: 1, status: 'verworfen', intensitaet: 5, titel: 'gestrichen' },
    { id: 14, act_id: 2, sort_order: 2, status: 'geplant', intensitaet: null, titel: 'ohne' },
  ];
  const curve = makeCtx({ beats, acts }).tensionCurve();
  // verworfen (13) + ohne Intensität (14) fliegen raus → 3 Punkte
  assert.equal(curve.count, 3);
  // Reihenfolge: Akt-Position dann sort_order → 12, 11, 10
  assert.deepEqual(curve.points.map(p => p.beat.id), [12, 11, 10]);
  // x von 5 % bis 95 %, y aus Intensität (1 → bottom 10 %, 4 → bottom 70 %)
  assert.equal(curve.points[0].xPct, 5);
  assert.equal(curve.points[2].xPct, 95);
  assert.equal(curve.points[0].bottomPct, 10);
  assert.equal(curve.points[2].bottomPct, 70);
  // Punktfarbe folgt dem Akt-Akzent
  assert.equal(curve.points[2].color, 'var(--card-accent)');
  // Polyline-String hat 3 Koordinatenpaare
  assert.equal(curve.polyline.split(' ').length, 3);
});

test('plotMethods.tensionCurve: <2 Punkte → count steuert Sichtbarkeit', () => {
  const acts = [{ id: 1, name: 'A1', position: 0 }];
  const curve = makeCtx({ beats: [{ id: 1, act_id: 1, sort_order: 0, status: 'geplant', intensitaet: 3 }], acts }).tensionCurve();
  assert.equal(curve.count, 1);
  assert.equal(curve.points[0].xPct, 50); // Einzelpunkt zentriert
});

test('plotMethods.visibleBeatsForAct: verworfen versteckt bis aufgeklappt', () => {
  const acts = [{ id: 1, name: 'A1', position: 0 }];
  const beats = [
    { id: 1, act_id: 1, sort_order: 0, status: 'geplant', fig_ids: [], draft_fig_ids: [] },
    { id: 2, act_id: 1, sort_order: 1, status: 'verworfen', fig_ids: [], draft_fig_ids: [] },
  ];
  const ctx = makeCtx({ beats, acts });
  assert.deepEqual(ctx.visibleBeatsForAct(1).map(b => b.id), [1]);
  assert.equal(ctx.verworfenCountForAct(1), 1);
  ctx.verworfenOpen = { 1: true };
  ctx._memos = {};
  assert.deepEqual(ctx.visibleBeatsForAct(1).map(b => b.id), [1, 2]);
});
