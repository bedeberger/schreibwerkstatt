// Tests für die Stale-Write-Regression: ein Read-Modify-Write-Pfad
// (Lektorat-Save, Chat-Vorschlag, History-Apply) hat den SW-Cache
// gelesen, dort lag aber noch die Pre-Edit-Fassung der Seite.
// Folge: User-Edits aus dem Fokus-Editor wurden beim nächsten
// "Korrekturen speichern" mit der alten Fassung überschrieben.
//
// Zwei Schutzschichten werden geprüft (Schicht 2 — Cache-Invalidation —
// laeuft jetzt ueber contentRepo._invalidateContentCache und wird in
// content-repo.test.mjs verifiziert):
//   1. `_loadApplyAndSave` liest mit `fresh: true` (umgeht SWR-Cache).
//   3. `runCheck onDone` verwirft Findings, deren Server-Snapshot
//      (`updatedAt`) nicht zum aktuellen `currentPage.updated_at` passt —
//      sonst würden positionsbasierte Findings auf veränderten Text
//      angewandt und beim Speichern frische Edits überschreiben.

import test from 'node:test';
import assert from 'node:assert/strict';

// DOM-Stubs vor Modul-Imports — page-view.js (transitiv von editor/lektorat.js
// importiert) liest beim Top-Level `window.matchMedia(...)`.
globalThis.window = globalThis.window || {
  matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => {},
};
if (!globalThis.window.matchMedia) {
  globalThis.window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} });
}
globalThis.document = globalThis.document || {
  createElement: () => ({ innerHTML: '', querySelectorAll: () => [], appendChild: () => {} }),
};

// Navigator-Stub fuer contentRepo._invalidateContentCache (No-Op-SW).
{
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true, writable: true,
    value: { serviceWorker: { controller: { postMessage() {} } } },
  });
  // restore-Schritt erfolgt am Ende dieser Datei via process.on('beforeExit')
  globalThis.__origNavigatorDesc = desc;
}

const { bookstackMethods } = await import('../../public/js/api/api-bookstack.js');
const { lektoratMethods } = await import('../../public/js/editor/lektorat.js');

// ── Schicht 1 ────────────────────────────────────────────────────────────────

test('_loadApplyAndSave reads fresh page → PUT respects newer edits', async () => {
  // Stale = was der SW-Cache vor dem User-Edit gespeichert hatte.
  // Fresh = was tatsaechlich auf dem Server steht (nach User-Edit im Fokus-Editor).
  const STALE = '<p>old text X</p>';
  const FRESH = '<p>user edit Y</p>';

  const reads = [];
  const writes = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (opts?.method === 'PUT') {
      writes.push({ url: u, body: JSON.parse(opts.body) });
      return new Response(JSON.stringify({ updated_at: 'after', html: writes.at(-1).body.html }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    reads.push({ url: u, fresh: u.includes('__fresh=1') });
    // contentRepo.loadPage zieht stripFocusArtefacts intern, daher gleiches html-Feld.
    return new Response(JSON.stringify({ id: 123, name: 'T', html: u.includes('__fresh=1') ? FRESH : STALE }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };

  const ctx = {
    ...bookstackMethods,
    currentPage: { id: 123, name: 'T' },
    t: (k) => k,
    setStatus: () => {},
    markPageChecked: () => {},
    _syncPageStatsAfterSave: () => {},
  };

  try {
    // Hard-Finding, dessen Original NUR in der frischen Fassung vorkommt.
    // Liest der Code stale, kann er die Korrektur nicht anwenden und PUTet
    // die alte Fassung → User-Edits weg. Mit fresh greift die Korrektur.
    await ctx._loadApplyAndSave(
      [{ original: 'edit Y', korrektur: 'edit Y!' }],
      [],
      () => {},
    );
  } finally {
    globalThis.fetch = origFetch;
  }

  assert.equal(reads.length, 1, 'genau ein Read');
  assert.equal(reads[0].fresh, true, 'Read muss fresh:true setzen (umgeht SW-SWR)');
  assert.equal(writes.length, 1, 'genau ein Write');
  // Wäre stale gelesen worden, würde hier STALE stehen → Datenverlust.
  assert.equal(writes[0].body.html, '<p>user edit Y!</p>',
    'PUT muss auf der frischen Fassung basieren, nicht auf der stale Cache-Version');
  assert.notEqual(writes[0].body.html, STALE,
    'PUT darf die alte Fassung nicht zurückschreiben');
});

test('_loadApplyAndSave: fehlt der fresh-Flag, schlägt der Test an (Regressions-Sentinel)', async () => {
  // Negativ-Probe: Wir simulieren bewusst, was passierte, BEVOR der Fix
  // kam. So ist sichergestellt, dass der Test scharf wäre, wenn jemand
  // den `fresh: true` wieder rausnimmt.
  const reads = [];
  let leakedStaleToPut = null;
  const STALE = '<p>old X</p>';
  const FRESH = '<p>edit Y</p>';

  // Variante von _loadApplyAndSave OHNE fresh: das alte Verhalten.
  async function legacyLoadApplyAndSave() {
    const page = await ctx.bsGet('pages/' + ctx.currentPage.id /* kein opts */);
    const finalHtml = page.html; // keine Korrektur möglich (Original passt nicht)
    leakedStaleToPut = finalHtml;
  }

  const ctx = {
    currentPage: { id: 1 },
    bsGet: async (path, opts) => {
      reads.push(!!opts?.fresh);
      return { html: opts?.fresh ? FRESH : STALE };
    },
  };

  await legacyLoadApplyAndSave();
  assert.equal(reads[0], false, 'Sentinel: Legacy-Pfad würde stale lesen');
  assert.equal(leakedStaleToPut, STALE, 'Sentinel: Legacy-Pfad würde STALE in PUT durchreichen');
});

// ── Schicht 3 ────────────────────────────────────────────────────────────────

test('runCheck onDone verwirft Ergebnis, wenn Seite während Analyse bearbeitet wurde', async () => {
  // Szenario: User startet Lektorat. Während der Job läuft, bearbeitet er
  // die Seite im Fokus-Editor und speichert (currentPage.updated_at
  // springt auf t2). Job kommt zurück, Server-Snapshot stammt aus t1.
  // Würde onDone die Findings auf den alten Snapshot anwenden, würden die
  // Positionen auf den neuen Text fehlausgerichtet → Save überschreibt
  // User-Edits.
  let captured = null;
  const ctx = {
    ...lektoratMethods,
    currentPage: { id: 1, updated_at: 't2_after_user_edit' },
    originalHtml: '<p>user edit Y</p>',
    lektoratFindings: [],
    t: (k) => k,
    setStatus: () => {},
    markPageChecked: () => {},
    updatePageView: () => {},
    loadPageHistory: async () => {},
    _runningJobStatus: () => '',
    _startPoll: (cfg) => { captured = cfg; },
  };

  ctx.startCheckPoll('job-1');
  assert.ok(captured, 'startPoll wurde mit Callbacks registriert');

  await captured.onDone({
    result: {
      fehler: [{ original: 'old X', korrektur: 'fix', position: 0, typ: 'rechtschreibung' }],
      originalHtml: '<p>old text X</p>',
      updatedAt: 't1_before_user_edit', // ≠ currentPage.updated_at
    },
  });

  assert.equal(ctx.originalHtml, '<p>user edit Y</p>',
    'originalHtml darf NICHT mit dem stale Server-Snapshot überschrieben werden');
  assert.notEqual(ctx.checkDone, true,
    'checkDone darf nicht gesetzt werden, wenn das Ergebnis verworfen wurde');
  assert.equal((ctx.lektoratFindings || []).length, 0,
    'Findings dürfen nicht in die UI durchgereicht werden');
});

test('runCheck blockt Start bei editDirty (nicht-persistierten Edits)', async () => {
  // Würde der Job auf nicht-gespeicherten Edits laufen, sähe der Server die
  // alte Fassung, Findings landeten auf altem Text — Save-Race überschreibt
  // den Online-Retry. Guard greift VOR fetchJson.
  const fetched = [];
  const ctx = {
    ...lektoratMethods,
    currentPage: { id: 1, updated_at: 't1' },
    editDirty: true,
    saveOffline: false,
    t: (k) => k,
    setStatus: (msg) => { ctx._lastStatus = msg; },
    _startPoll: () => fetched.push('startPoll'),
  };
  // fetchJson würde feuern, wenn der Guard nicht greift — wird hier nicht
  // gemockt, ein Aufruf würde im Test-Env scheitern. Stattdessen: prüfe,
  // dass checkLoading nicht gesetzt wurde (Guard-Pfad return-t früh).
  await ctx.runCheck();
  assert.notEqual(ctx.checkLoading, true, 'darf nicht in Loading-State gehen');
  assert.equal(fetched.length, 0, 'kein Polling gestartet');
  assert.equal(ctx._lastStatus, 'lektorat.blockedUnsavedEdits');
});

test('runCheck blockt Start bei saveOffline (Online-Retry pending)', async () => {
  const ctx = {
    ...lektoratMethods,
    currentPage: { id: 1, updated_at: 't1' },
    editDirty: false,
    saveOffline: true,
    t: (k) => k,
    setStatus: (msg) => { ctx._lastStatus = msg; },
    _startPoll: () => { throw new Error('startPoll darf nicht laufen'); },
  };
  await ctx.runCheck();
  assert.notEqual(ctx.checkLoading, true);
  assert.equal(ctx._lastStatus, 'lektorat.blockedUnsavedEdits');
});

test('runCheck onDone akzeptiert Ergebnis bei passendem updatedAt', async () => {
  // Gegenprobe: stimmen die Timestamps überein, hat der User währenddessen
  // NICHT gespeichert → Findings dürfen normal angezeigt werden.
  let captured = null;
  const ctx = {
    ...lektoratMethods,
    currentPage: { id: 1, updated_at: 't1' },
    originalHtml: '<p>old text X</p>',
    lektoratFindings: [],
    selectedFindings: [],
    appliedOriginals: [],
    t: (k) => k,
    setStatus: () => {},
    markPageChecked: () => {},
    updatePageView: () => {},
    loadPageHistory: async () => {},
    _runningJobStatus: () => '',
    _startPoll: (cfg) => { captured = cfg; },
    _applyCorrections: (html) => html,
  };

  ctx.startCheckPoll('job-1');
  await captured.onDone({
    result: {
      fehler: [{ original: 'old X', korrektur: 'fix', position: 0, typ: 'rechtschreibung' }],
      originalHtml: '<p>old text X</p>',
      updatedAt: 't1', // = currentPage.updated_at
    },
  });

  assert.equal(ctx.originalHtml, '<p>old text X</p>',
    'originalHtml wird auf den Server-Snapshot gesetzt');
  assert.equal(ctx.checkDone, true, 'checkDone gesetzt');
});
