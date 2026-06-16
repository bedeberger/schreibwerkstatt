// E2E für den Standalone-Bootstrap (focus/standalone.js): verifiziert, dass die
// Focus-Engine in einer fremden Schale OHNE window.__app/Alpine läuft — nur über
// setEditorHost + einen Bridge-Stub. Das ist der In-Repo-Beweis, bevor die
// WKWebView/Swift-Seite dazukommt.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/standalone-harness.html';

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.standaloneReady === true);
});

test('mountet: aktiver Focus-Editor, Inhalt geladen, focusActive=true', async ({ page }) => {
  const state = await page.evaluate(() => ({
    hasActiveEditor: !!document.querySelector('.focus-editor.is-active'),
    paragraphs: document.querySelectorAll('.focus-editor__content p').length,
    focusActive: window.__standalone.host.focusActive,
    focusState: window.__standalone.controller._focusState,
    listenersInstalled: window.__standalone.controller._focusListeners !== null,
  }));
  expect(state.hasActiveEditor).toBe(true);
  // 60 geladene Absätze + 1 Auto-Trailing-<p> (jumpToTrailingParagraph beim Enter).
  expect(state.paragraphs).toBe(61);
  expect(state.focusActive).toBe(true);
  expect(state.focusState).toBe('active');
  expect(state.listenersInstalled).toBe(true);
});

test('Granularität-Klasse + aktiver Absatz werden gesetzt', async ({ page }) => {
  const cls = await page.evaluate(() => document.querySelector('.focus-editor').className);
  expect(cls).toContain('focus-mode--paragraph');
  // Nach enterFocusMode markiert die Engine den aktiven Block.
  await page.waitForFunction(() => document.querySelectorAll('.focus-paragraph-active').length === 1);
});

test('Tippen markiert dirty und löst Autosave über die Bridge aus', async ({ page }) => {
  await page.evaluate(() => {
    const p = document.querySelector('.focus-editor__content p');
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    document.querySelector('.focus-editor__content').focus();
  });
  await page.keyboard.type(' NEUERTEXT');

  // editDirty wird synchron beim input gesetzt; Save kommt debounced (150ms).
  await page.waitForFunction(() => window.__saveLog.length >= 1, null, { timeout: 3000 });
  const log = await page.evaluate(() => window.__saveLog);
  expect(log[log.length - 1].html).toContain('NEUERTEXT');
  expect(log[log.length - 1].id).toBe(42);

  // Nach erfolgreichem Save ist editDirty wieder false.
  await page.waitForFunction(() => window.__standalone.host.editDirty === false);
});

test('Escape speichert, ohne den Editor abzureißen (kein Lese-Modus)', async ({ page }) => {
  await page.evaluate(() => {
    const c = document.querySelector('.focus-editor__content');
    c.focus();
    const p = c.querySelector('p');
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  });
  await page.keyboard.type(' X');
  await page.evaluate(() => window.__saveLog.length = 0); // Autosave-Eintrag ignorieren
  await page.keyboard.press('Escape');

  await page.waitForFunction(() => window.__saveLog.length >= 1, null, { timeout: 3000 });
  const after = await page.evaluate(() => ({
    stillActive: !!document.querySelector('.focus-editor.is-active'),
    focusState: window.__standalone.controller._focusState,
    listeners: window.__standalone.controller._focusListeners !== null,
  }));
  expect(after.stillActive).toBe(true);
  expect(after.focusState).toBe('active');
  expect(after.listeners).toBe(true);
});

test('destroy() speichert geänderten Inhalt und räumt Engine-Listener ab', async ({ page }) => {
  await page.evaluate(() => {
    const c = document.querySelector('.focus-editor__content');
    c.focus();
    const p = c.querySelector('p');
    const sel = window.getSelection(); const r = document.createRange();
    r.selectNodeContents(p); r.collapse(false); sel.removeAllRanges(); sel.addRange(r);
  });
  await page.keyboard.type(' Y');
  await page.evaluate(() => window.__saveLog.length = 0); // Autosave-Eintrag ignorieren

  await page.evaluate(async () => { await window.__standalone.destroy(); });
  const state = await page.evaluate(() => ({
    saved: window.__saveLog.length >= 1,
    focusState: window.__standalone.controller._focusState,
    listeners: window.__standalone.controller._focusListeners,
  }));
  expect(state.saved).toBe(true);
  expect(state.focusState).toBe('idle');
  expect(state.listeners).toBe(null);
});

test('kein redundanter Save bei ungeänderter Seite (Gate via isNoChange)', async ({ page }) => {
  // Frisch geöffnete Seite: nur die Fokus-Engine hat das DOM normalisiert
  // (Aktiv-Markierung, Auto-Trailing-<p>) — inhaltlich nichts geändert.
  // Weder explizites save() noch destroy() dürfen einen PUT auslösen.
  const result = await page.evaluate(async () => {
    window.__saveLog.length = 0;
    await window.__standalone.save();
    const afterSave = window.__saveLog.length;
    await window.__standalone.destroy();
    return { afterSave, afterDestroy: window.__saveLog.length, dirty: window.__standalone.host.editDirty };
  });
  expect(result.afterSave).toBe(0);
  expect(result.afterDestroy).toBe(0);
  expect(result.dirty).toBe(false);
});
