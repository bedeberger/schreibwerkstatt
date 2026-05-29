// Unit-Tests für Notebook-Editor Pre-Save-Pfade aus
// public/js/editor/notebook/edit.js:
//   - `_checkPageConflict` — Read-Modify-Write-Konflikterkennung. Kritisch ist
//     der `fresh: true`-Read (SW-SWR-Cache würde sonst Cross-User-Edits
//     verschlucken) und dass kein Modal bei fehlendem/gleichem Stand auslöst.
//   - `_filterFindingsAfterSave` — nach jedem Save fliegen Findings raus, deren
//     `original`-Text nicht mehr im HTML steht; Selektion der Überlebenden bleibt.
//
// Setup: linkedom liefert window/document; `contentRepo.loadPage` wird am
// Singleton gemockt (gleiche Modulinstanz wie edit.js). Test-HTML sind statische
// Literale im Source — kein XSS-Risiko.

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const { window } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = window.document;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;

const { contentRepo } = await import('../../public/js/repo/content.js');
const { notebookEditMethods } = await import('../../public/js/editor/notebook/edit.js');

function mockLoadPage(impl) { contentRepo.loadPage = impl; }

// --- _checkPageConflict -----------------------------------------------------

test('_checkPageConflict: kein expectedUpdatedAt → null (kein Read)', async () => {
  let called = false;
  mockLoadPage(async () => { called = true; return {}; });
  const r = await notebookEditMethods._checkPageConflict(1, null);
  assert.equal(r, null);
  assert.equal(called, false);
});

test('_checkPageConflict: liest IMMER fresh (SW-Cache-Bypass-Invariante)', async () => {
  let opts;
  mockLoadPage(async (id, o) => { opts = o; return { updated_at: '2026-01-01T00:00:00Z' }; });
  await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(opts?.fresh, true);
});

test('_checkPageConflict: gleicher Stand → null (kein Konflikt)', async () => {
  mockLoadPage(async () => ({ updated_at: '2026-01-01T00:00:00Z' }));
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(r, null);
});

test('_checkPageConflict: abweichender Stand → Konfliktobjekt', async () => {
  mockLoadPage(async () => ({ updated_at: '2026-02-02T10:00:00Z', updated_by_name: 'Bob', html: '<p>remote</p>' }));
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.deepEqual(r, {
    remoteUpdatedAt: '2026-02-02T10:00:00Z',
    remoteUserName: 'Bob',
    remoteHtml: '<p>remote</p>',
  });
});

test('_checkPageConflict: fehlender updated_by_name/html → null/leer normalisiert', async () => {
  mockLoadPage(async () => ({ updated_at: '2026-02-02T10:00:00Z' }));
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(r.remoteUserName, null);
  assert.equal(r.remoteHtml, '');
});

test('_checkPageConflict: Read wirft → null (kein irreführendes Modal)', async () => {
  mockLoadPage(async () => { throw Object.assign(new Error('boom'), { status: 500 }); });
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(r, null);
});

test('_checkPageConflict: Remote ohne updated_at → null', async () => {
  mockLoadPage(async () => ({ html: '<p>x</p>' }));
  const r = await notebookEditMethods._checkPageConflict(1, '2026-01-01T00:00:00Z');
  assert.equal(r, null);
});

// --- _filterFindingsAfterSave -----------------------------------------------

function setApp(extra) {
  const app = {
    lektoratFindings: [],
    selectedFindings: [],
    appliedOriginals: [],
    checkDone: true,
    correctedHtml: '<x>',
    hasErrors: true,
    _recomputeCorrectedHtml() { this._rcCalled = true; },
    ...extra,
  };
  window.__app = app;
  return app;
}

test('_filterFindingsAfterSave: ohne Findings → no-op', () => {
  const app = setApp({ lektoratFindings: [], selectedFindings: [] });
  notebookEditMethods._filterFindingsAfterSave('<p>egal</p>');
  assert.equal(app.lektoratFindings.length, 0);
  assert.notEqual(app._rcCalled, true);
});

test('_filterFindingsAfterSave: behält Finding mit vorhandenem original + Selektion', () => {
  const f1 = { original: 'bleibt', pos: 0 };
  const f2 = { original: 'verschwunden', pos: 1 };
  const app = setApp({
    lektoratFindings: [f1, f2],
    selectedFindings: [true, true],
    appliedOriginals: ['bleibt', 'verschwunden'],
  });
  notebookEditMethods._filterFindingsAfterSave('<p>bleibt drin</p>');
  assert.equal(app.lektoratFindings.length, 1);
  assert.equal(app.lektoratFindings[0], f1);
  assert.deepEqual(app.selectedFindings, [true]);
  assert.deepEqual(app.appliedOriginals, ['bleibt']);
  assert.equal(app._rcCalled, true);
});

test('_filterFindingsAfterSave: alle weg → Prüfmodus-Reset', () => {
  const app = setApp({
    lektoratFindings: [{ original: 'weg' }],
    selectedFindings: [true],
    appliedOriginals: ['weg'],
  });
  notebookEditMethods._filterFindingsAfterSave('<p>nichts</p>');
  assert.equal(app.lektoratFindings.length, 0);
  assert.equal(app.checkDone, false);
  assert.equal(app.correctedHtml, null);
  assert.equal(app.hasErrors, false);
});
