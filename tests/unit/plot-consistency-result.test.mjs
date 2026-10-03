// Plot-Consistency: serverseitige Nachbearbeitung (Aktions-Validierung, Titel-
// Fallback ohne Mehrdeutigkeit, seit_letztem_lauf/erledigt nur mit Vorlauf),
// Vorlauf-Auswahl für den Delta-Check, Kontext-Priorisierung und die
// Strang/Akt-Prüfung der Brainstorm-Route.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useTmpDb } from './_helpers/tmp-db.js';

const require = createRequire(import.meta.url);
useTmpDb('plot-consistency-result');

const { normalizeAktion, normalizeKonflikte, normalizeErledigt, buildDeltaContext, buildTitleIndex } = require('../../routes/jobs/plot/result');
const { prioritize, linkedChapterIds, capBeats, enrichBeats } = require('../../routes/jobs/plot/context');
const { brainstormActFitsThread } = require('../../routes/jobs/plot');
const { PLOT_KONFLIKT_TYP_ENUM, PLOT_AKTION_REL_TYPES } = await import('../../public/js/prompts/plot.js');

const BEATS = [
  { id: 1, titel: 'Auftakt', status: 'geplant', verworfen: 0, updated_at: '2026-10-01T09:00:00.000Z' },
  { id: 2, titel: 'Showdown', status: 'im_buch', verworfen: 0, updated_at: '2026-10-02T12:00:00.000Z' },
  { id: 3, titel: 'Alt', status: 'geplant', verworfen: 1, updated_at: '2026-09-01T00:00:00.000Z' },
  { id: 4, titel: 'Doppelt', status: 'geplant', verworfen: 0, updated_at: '2026-09-01T00:00:00.000Z' },
  { id: 5, titel: 'doppelt ', status: 'geplant', verworfen: 0, updated_at: '2026-09-01T00:00:00.000Z' },
];
const byId = new Map(BEATS.map(b => [b.id, b]));
const relTypes = PLOT_AKTION_REL_TYPES;
const aktion = (raw, beatId) => normalizeAktion(raw, { beatId, beatsById: byId, relTypes });

test('aktion: gültige Formen exakt nach Vertrag', () => {
  assert.deepEqual(aktion({ art: 'status', wert: 'im_buch', typ: null, ziel_beat_id: null }, 1), { art: 'status', wert: 'im_buch' });
  assert.deepEqual(aktion({ art: 'verwerfen', wert: null }, 1), { art: 'verwerfen' });
  assert.deepEqual(aktion({ art: 'relation', typ: 'bereitet-vor', ziel_beat_id: 2 }, 1), { art: 'relation', typ: 'bereitet-vor', ziel_beat_id: 2 });
  assert.deepEqual(aktion({ art: 'relation', typ: 'zahlt-ein', ziel_beat_id: '2' }, 1), { art: 'relation', typ: 'zahlt-ein', ziel_beat_id: 2 });
});

test('aktion: alles Ungültige wird null', () => {
  assert.equal(aktion({ art: 'keine' }, 1), null);
  assert.equal(aktion(null, 1), null);
  assert.equal(aktion({ art: 'status', wert: 'im_buch' }, null), null, 'ohne Beat keine Aktion');
  assert.equal(aktion({ art: 'status', wert: 'im_buch' }, 99), null, 'Beat nicht im Board');
  assert.equal(aktion({ art: 'status', wert: 'fertig' }, 1), null, 'ungültiger Wert');
  assert.equal(aktion({ art: 'status', wert: 'geplant' }, 1), null, 'No-Op (Status schon so)');
  assert.equal(aktion({ art: 'status', wert: 'im_buch' }, 3), null, 'verworfene Beats: keine Status-Aktion');
  assert.equal(aktion({ art: 'verwerfen' }, 3), null, 'schon verworfen');
  assert.equal(aktion({ art: 'relation', typ: 'bereitet-vor', ziel_beat_id: 1 }, 1), null, 'Ziel == Beat');
  assert.equal(aktion({ art: 'relation', typ: 'bereitet-vor', ziel_beat_id: 77 }, 1), null, 'Ziel nicht im Board');
  assert.equal(aktion({ art: 'relation', typ: 'liebt', ziel_beat_id: 2 }, 1), null, 'freier Typ nicht erlaubt');
  assert.equal(aktion({ art: 'loeschen' }, 1), null);
});

test('Titel-Index: mehrdeutige Titel matchen nicht', () => {
  const idx = buildTitleIndex(BEATS);
  assert.equal(idx.get('showdown'), 2);
  assert.equal(idx.has('doppelt'), false);
});

test('normalizeKonflikte: beat_id-Validierung, Titel-Fallback, Enums, Aktion, Fundstelle', () => {
  const raw = [
    { beat: 'Showdown', beat_id: 2, schwere: 'stark', typ: 'kausalitaet', problem: ' P ', vorschlag: 'V', aktion: { art: 'status', wert: 'geplant' } },
    { beat: '«Auftakt»', beat_id: 999, schwere: 'quatsch', typ: 'unbekannt', problem: 'P2', aktion: { art: 'keine' } },
    { beat: 'Doppelt', beat_id: null, schwere: 'mittel', typ: 'logik', problem: 'P3' },
    { beat: '—', beat_id: null, schwere: 'niedrig', typ: 'struktur', problem: 'P4', aktion: { art: 'verwerfen' } },
    { beat: 'x', problem: '' },
  ];
  const out = normalizeKonflikte(raw, { beats: BEATS, belegById: { 2: { page_id: 7, page_name: 'S7' } }, typEnum: PLOT_KONFLIKT_TYP_ENUM, relTypes });
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { beat: 'Showdown', beat_id: 2, schwere: 'stark', typ: 'kausalitaet', problem: 'P', vorschlag: 'V', aktion: { art: 'status', wert: 'geplant' }, fundstelle: { page_id: 7, page_name: 'S7' } });
  assert.equal(out[1].beat_id, 1, 'Fremd-ID verworfen, Titel (ohne «») matcht');
  assert.equal(out[1].schwere, 'mittel');
  assert.equal(out[1].typ, 'logik', 'ungültiger Typ → Fallback');
  assert.equal(out[1].aktion, null);
  assert.equal(out[2].beat_id, null, 'mehrdeutiger Titel bleibt ohne ID');
  assert.equal(out[3].aktion, null, 'übergreifend → keine Aktion');
  assert.ok(!('seit_letztem_lauf' in out[0]), 'ohne Vorlauf kein seit_letztem_lauf');
});

test('normalizeKonflikte: mit Vorlauf seit_letztem_lauf neu|bestehend, sonst null', () => {
  const raw = [
    { beat: '—', problem: 'a', typ: 'logik', seit_letztem_lauf: 'bestehend' },
    { beat: '—', problem: 'b', typ: 'logik', seit_letztem_lauf: 'alt' },
  ];
  const out = normalizeKonflikte(raw, { beats: BEATS, typEnum: PLOT_KONFLIKT_TYP_ENUM, relTypes, hasDelta: true });
  assert.equal(out[0].seit_letztem_lauf, 'bestehend');
  assert.equal(out[1].seit_letztem_lauf, null);
});

test('normalizeErledigt: nur mit Vorlauf, getrimmte Strings', () => {
  assert.deepEqual(normalizeErledigt([' Kausalität repariert ', '', 3], true), ['Kausalität repariert']);
  assert.deepEqual(normalizeErledigt(['x'], false), []);
  assert.deepEqual(normalizeErledigt(undefined, true), []);
});

test('Delta: Vorlauf-Befunde kompakt + seit created_at geänderte Beats', () => {
  const prev = {
    id: 42, created_at: '2026-10-02T00:00:00.000Z',
    result: { konflikte: [
      { beat: 'Showdown', beat_id: 2, typ: 'kausalitaet', problem: 'X'.repeat(400) },
      { beat: 'Gelöscht', beat_id: 77, problem: 'weg' },
      { beat: '—', beat_id: null, problem: 'übergreifend' },
    ], fazit: 'f' },
  };
  const d = buildDeltaContext(prev, BEATS, { maxKonflikte: 2 });
  assert.equal(d.runId, 42);
  assert.equal(d.konflikteTotal, 3);
  assert.equal(d.konflikte.length, 2, 'Cap greift');
  assert.equal(d.konflikte[0].beat, 'Showdown');
  assert.equal(d.konflikte[0].problem.length, 160);
  assert.equal(d.konflikte[1].beat_id, null, 'Beat nicht mehr im Board');
  assert.match(d.konflikte[1].beat, /nicht mehr im Board/);
  assert.deepEqual(d.geaendert, [{ id: 2, titel: 'Showdown' }]);
  assert.equal(d.konflikte[0].typ, 'kausalitaet');
});

test('Delta: kein Vorlauf / unlesbares Ergebnis → normaler Lauf; Alt-Läufe ohne typ lesbar', () => {
  assert.equal(buildDeltaContext(null, BEATS), null);
  assert.equal(buildDeltaContext({ id: 1, created_at: 'x', result: null }, BEATS), null);
  const alt = buildDeltaContext({ id: 1, created_at: '2026-10-02 00:00:00', result: { konflikte: [{ beat: 'Auftakt', problem: 'p' }] } }, BEATS);
  assert.equal(alt.konflikte[0].typ, null);
  assert.deepEqual(alt.geaendert.map(b => b.id), [2], 'SQLite-Zeitformat ohne Zone als UTC');
});

test('prioritize/capBeats: Relevante zuerst, Ordnung bleibt, Total gemeldet', () => {
  const r = prioritize([1, 2, 3, 4, 5], 2, x => x >= 4);
  assert.deepEqual(r, { items: [4, 5], total: 5 });
  assert.deepEqual(prioritize([1, 2], 5).items, [1, 2]);
  const cb = capBeats(BEATS, 4);
  assert.equal(cb.total, 5);
  assert.ok(!cb.items.some(b => b.verworfen), 'verworfene zuerst geopfert');
});

test('linkedChapterIds: eigenes Kapitel oder Strang-Kapitel, verworfene nicht', () => {
  const ids = linkedChapterIds([
    { chapter_id: 10, thread_id: null },
    { chapter_id: null, thread_id: 7 },
    { chapter_id: 30, verworfen: 1 },
  ], [{ id: 7, chapter_id: 20 }]);
  assert.deepEqual([...ids].sort(), [10, 20]);
});

test('enrichBeats: Figuren-Namen aus Katalog (TEXT-fig_id) und Werkstatt (draft id)', () => {
  const [b] = enrichBeats([{ id: 1, fig_ids: ['f1', 'fx'], draft_fig_ids: [5] }], [{ id: 'f1', name: 'Anna' }], [{ id: 5, name: 'Mara' }]);
  assert.deepEqual(b.figuren_namen, ['Anna']);
  assert.deepEqual(b.werkstatt_namen, ['Mara']);
});

test('Brainstorm-Route: Strang mit eigenen Akten nur in eigene Akte, sonst nur geteilte', () => {
  const shared = { thread_id: null };
  const ownOf7 = { thread_id: 7 };
  const ownOf8 = { thread_id: 8 };
  assert.equal(brainstormActFitsThread(shared, null, false), true);
  assert.equal(brainstormActFitsThread(ownOf7, null, false), false);
  assert.equal(brainstormActFitsThread(shared, 9, false), true, 'Strang ohne eigene Akte → geteilt');
  assert.equal(brainstormActFitsThread(ownOf7, 9, false), false);
  assert.equal(brainstormActFitsThread(ownOf7, 7, true), true);
  assert.equal(brainstormActFitsThread(shared, 7, true), false, 'Strang mit eigenen Akten → nicht in geteilte');
  assert.equal(brainstormActFitsThread(ownOf8, 7, true), false);
});
