// Unit-Tests für public/js/editor/notebook/history.js — Notebook-Undo/Redo.
//
// Session-scoped Stack: Baseline → Push (debounced) → Undo/Redo → Clear.
// Tests greifen direkt auf `notebookHistoryMethods` zu, mocken `_getEditEl`,
// `_scheduleDraftSave`, `_scheduleAutosave` + `window.__app`.
// Test-Fixtures setzen `innerHTML` mit statischen, im Test-Source eingebetteten
// HTML-Literalen — keine externen Daten, kein XSS-Risiko.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body><div id="ed" contenteditable="true"><p>start</p></div></body></html>');
globalThis.window = window;
globalThis.document = window.document;
globalThis.NodeFilter = window.NodeFilter || { SHOW_TEXT: 4 };

const { notebookHistoryMethods } = await import('../../public/js/editor/notebook/history.js');

function makeCtx() {
  const el = window.document.getElementById('ed');
  el.innerHTML = '<p>start</p>'; // Reset zwischen Tests (shared DOM)
  const app = { editMode: true, focusActive: false, editDirty: false };
  window.__app = app;
  const ctx = {
    _getEditEl: () => el,
    _scheduleDraftSave: () => { ctx._draftCalls++; },
    _scheduleAutosave: () => { ctx._autosaveCalls++; },
    _draftCalls: 0,
    _autosaveCalls: 0,
    ...notebookHistoryMethods,
  };
  return { ctx, el, app };
}

function setHtml(el, html) { el.innerHTML = html; }

test('_historyReset legt Baseline mit idx=0', () => {
  const { ctx } = makeCtx();
  ctx._historyReset('<p>a</p>');
  assert.equal(ctx._undoStack.length, 1);
  assert.equal(ctx._undoIdx, 0);
  assert.equal(ctx._undoStack[0].html, '<p>a</p>');
  assert.equal(ctx.notebookCanUndo(), false);
  assert.equal(ctx.notebookCanRedo(), false);
});

test('_historyPushNow dedupt gegen Top', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  ctx._historyPushNow();
  assert.equal(ctx._undoStack.length, 1, 'kein Dup-Push bei unverändertem HTML');
});

test('_historyPushNow pusht neue Variante + bewegt idx', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>start a</p>');
  ctx._historyPushNow();
  assert.equal(ctx._undoStack.length, 2);
  assert.equal(ctx._undoIdx, 1);
  assert.equal(ctx.notebookCanUndo(), true);
  assert.equal(ctx.notebookCanRedo(), false);
});

test('notebookUndo restored vorherigen Snapshot', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>edited</p>');
  ctx._historyPushNow();
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>start</p>');
  assert.equal(ctx._undoIdx, 0);
  assert.equal(ctx.notebookCanRedo(), true);
});

test('notebookRedo bewegt idx vor + restored', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  ctx.notebookUndo();
  ctx.notebookRedo();
  assert.equal(el.innerHTML, '<p>v2</p>');
  assert.equal(ctx._undoIdx, 1);
});

test('Push nach Undo droppt Redo-Tail', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  setHtml(el, '<p>v3</p>');
  ctx._historyPushNow();
  ctx.notebookUndo();
  ctx.notebookUndo();
  setHtml(el, '<p>branch</p>');
  ctx._historyPushNow();
  assert.equal(ctx._undoStack.length, 2, 'Redo-Tail gedroppt, neue Spitze');
  assert.equal(ctx.notebookCanRedo(), false);
});

test('Restore markiert dirty + ruft Draft+Autosave', () => {
  const { ctx, el, app } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  app.editDirty = false;
  ctx.notebookUndo();
  assert.equal(app.editDirty, true);
  assert.ok(ctx._draftCalls > 0);
  assert.ok(ctx._autosaveCalls > 0);
});

test('Undo no-op bei !editMode', () => {
  const { ctx, el, app } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  app.editMode = false;
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>v2</p>', 'kein Restore wenn editMode off');
});

test('Undo no-op bei focusActive (Notebook-only)', () => {
  const { ctx, el, app } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  app.focusActive = true;
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>v2</p>', 'Focus-Modus kapselt Notebook-Undo aus');
});

test('Undo normalisiert orphan-Text-Snapshot in <p> (Block-Konsistenz)', () => {
  // Reproduziert den Korruptions-Fall: ein Snapshot fängt einen transienten
  // contenteditable-Stand ohne <p>-Wrapper ein (z.B. nach Select-all+Tippen).
  // Restore muss den Block normalisieren statt orphan-Text zu reinstanzieren.
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, 'orphan ohne block');
  ctx._historyPushNow();
  setHtml(el, '<p>danach</p>');
  ctx._historyPushNow();
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>orphan ohne block</p>', 'orphan-Text in <p> gewrapt');
});

test('Restore ergänzt Caret-Slot <br> in leerem trailing <p>', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>text</p><p></p>');
  ctx._historyPushNow();
  setHtml(el, '<p>weiter</p>');
  ctx._historyPushNow();
  ctx.notebookUndo();
  assert.equal(el.innerHTML, '<p>text</p><p><br></p>', 'leerer trailing <p> bekommt Caret-Slot');
});

test('_historyClear setzt idx=-1', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset(el.innerHTML);
  setHtml(el, '<p>v2</p>');
  ctx._historyPushNow();
  ctx._historyClear();
  assert.equal(ctx._undoStack.length, 0);
  assert.equal(ctx._undoIdx, -1);
  assert.equal(ctx.notebookCanUndo(), false);
});

test('Cap auf 100 — älteste fallen raus', () => {
  const { ctx, el } = makeCtx();
  ctx._historyReset('<p>0</p>');
  for (let i = 1; i <= 150; i++) {
    setHtml(el, `<p>v${i}</p>`);
    ctx._historyPushNow();
  }
  assert.equal(ctx._undoStack.length, 100);
  assert.equal(ctx._undoStack[ctx._undoStack.length - 1].html, '<p>v150</p>');
});
