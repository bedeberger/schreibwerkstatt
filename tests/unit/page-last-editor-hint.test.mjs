// Der „Zuletzt bearbeitet auf <Gerät>"-Banner unter dem Editor-Frame ist eine
// Aussage über den NEUESTEN Stand der Seite. Speichert dieser Browser, ist der
// Schnappschuss aus dem letzten Seiten-Load überholt — der Banner muss fallen,
// unabhängig davon, welcher Save-Pfad geschrieben hat (alle rücken
// `currentPage.updated_at` vor). Deckt genau das ab; `pageLastEditor` selbst
// bleibt dabei unangetastet (unverfälschte Server-Antwort).

import test from 'node:test';
import assert from 'node:assert/strict';
import { rootGetterDescriptors } from '../../public/js/app/app-root-getters.js';

const T0 = '2026-09-10T08:00:00.000Z';
const T1 = '2026-09-10T08:05:00.000Z';

// Minimal-Root: nur die zwei Felder, die der Getter liest.
function makeCtx({ lastEditor = null, updatedAt = null } = {}) {
  const ctx = {
    pageLastEditor: lastEditor,
    currentPage: updatedAt === null ? null : { id: 7, updated_at: updatedAt },
  };
  Object.defineProperties(ctx, rootGetterDescriptors);
  return ctx;
}

const fromDeviceA = (at = T0) => ({ device_name: 'MacBook', updated_at: at });

test('Hint zeigt, solange der Schnappschuss der aktuelle Stand ist', () => {
  const ctx = makeCtx({ lastEditor: fromDeviceA(T0), updatedAt: T0 });
  assert.equal(ctx.pageLastEditorHint?.device_name, 'MacBook');
});

test('Eigener Save rueckt updated_at vor und laesst den Hint fallen', () => {
  const ctx = makeCtx({ lastEditor: fromDeviceA(T0), updatedAt: T0 });
  assert.ok(ctx.pageLastEditorHint, 'Vorbedingung: Hint steht');
  // Das tut jeder Save-Pfad nach erfolgreichem PUT.
  ctx.currentPage.updated_at = T1;
  assert.equal(ctx.pageLastEditorHint, null);
  // Schnappschuss bleibt unberuehrt — nur die Anzeige urteilt.
  assert.equal(ctx.pageLastEditor?.updated_at, T0);
});

test('Kein Schnappschuss, kein Hint', () => {
  assert.equal(makeCtx({ updatedAt: T1 }).pageLastEditorHint, null);
});

test('Fremdes Geraet speichert erneut: Refetch setzt beide Werte, Hint bleibt', () => {
  const ctx = makeCtx({ lastEditor: fromDeviceA(T0), updatedAt: T0 });
  // _applyPageData setzt p.updated_at und pageLastEditor aus DERSELBEN Antwort.
  ctx.currentPage.updated_at = T1;
  ctx.pageLastEditor = fromDeviceA(T1);
  assert.equal(ctx.pageLastEditorHint?.device_name, 'MacBook');
});

test('Ohne Stempel auf einer der beiden Seiten wird nicht ausgeblendet', () => {
  // Lieber ein Hinweis zu lang als einer, der bei fehlendem Stempel verschwindet.
  assert.ok(makeCtx({ lastEditor: { device_name: 'Pixel', updated_at: null }, updatedAt: T1 }).pageLastEditorHint);
  assert.ok(makeCtx({ lastEditor: fromDeviceA(T0), updatedAt: null }).pageLastEditorHint);
});
