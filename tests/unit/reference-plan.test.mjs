// Plan-Reiter im Referenz-Panel: Board-Reihenfolge + Kontext-Regel.
// Ein Beat haengt am KAPITEL; „hier im Text" (refCtx 'page') kommt allein aus
// der Beat-Verankerung (occ_top[].page_id), nie aus dem Plan selbst.
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderPlanBeats, selectPlanBeatsForPage } from '../../public/js/cards/reference-plan.js';

const plan = {
  acts: [{ id: 10, position: 1 }, { id: 11, position: 0 }],
  beats: [
    { id: 1, act_id: 10, sort_order: 0, chapter_id: 5, status: 'geplant', occ_top: [] },
    { id: 2, act_id: 11, sort_order: 1, chapter_id: 5, status: 'im_buch', occ_top: [{ page_id: 77 }] },
    { id: 3, act_id: 11, sort_order: 0, chapter_id: 6, status: 'geplant' },
    { id: 4, act_id: 11, sort_order: 2, chapter_id: 5, status: 'geplant', verworfen: 1 },
    { id: 5, act_id: 10, sort_order: 1, chapter_id: null, status: 'geplant' },
  ],
};

test('orderPlanBeats: Akt-Position vor sort_order, verworfene fallen raus', () => {
  assert.deepEqual(orderPlanBeats(plan).map(b => b.id), [3, 2, 1, 5]);
});

test('orderPlanBeats: leerer/fehlender Plan ergibt leere Liste', () => {
  assert.deepEqual(orderPlanBeats(null), []);
  assert.deepEqual(orderPlanBeats({ acts: [], beats: [] }), []);
});

test('selectPlanBeatsForPage: nur Beats des Kapitels, auf der Seite verankerte zuerst', () => {
  const out = selectPlanBeatsForPage(orderPlanBeats(plan), { pageId: 77, chapterId: 5 });
  assert.deepEqual(out.map(b => [b.id, b.refCtx]), [[2, 'page'], [1, 'chapter']]);
});

test('selectPlanBeatsForPage: IDs als String und Zahl vergleichbar', () => {
  const out = selectPlanBeatsForPage(orderPlanBeats(plan), { pageId: '77', chapterId: '5' });
  assert.deepEqual(out.map(b => b.id), [2, 1]);
});

test('selectPlanBeatsForPage: Seite ohne Kapitel zeigt keinen Plan', () => {
  assert.deepEqual(selectPlanBeatsForPage(orderPlanBeats(plan), { pageId: 1, chapterId: null }), []);
});

test('selectPlanBeatsForPage: Beat ohne eigenes Kapitel erbt das seines Strangs', () => {
  const ordered = orderPlanBeats({
    acts: [{ id: 1, position: 0 }],
    beats: [
      { id: 8, act_id: 1, sort_order: 0, chapter_id: null, thread_id: 3 },
      { id: 9, act_id: 1, sort_order: 1, chapter_id: 6, thread_id: 3 },   // eigenes Kapitel schlaegt Strang
    ],
  });
  const out = selectPlanBeatsForPage(ordered, { pageId: 1, chapterId: 5, threads: [{ id: 3, chapter_id: 5 }] });
  assert.deepEqual(out.map(b => b.id), [8]);
});
