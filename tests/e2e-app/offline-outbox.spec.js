// Verifikation der Reconnect-Outbox (app-outbox.js) gegen die ECHTE App:
// ein offline gesicherter Entwurf für eine NICHT geöffnete Seite muss beim
// Flush im Hintergrund zum Server synchronisiert werden — genau der Fall, den
// der Per-Seite-Retry (autosave.js) nicht abdeckt.
//
// Der Test seedet den Draft direkt in localStorage (simuliert einen offline
// getippten Edit an Seite X, während der Editor woanders/geschlossen ist),
// triggert _flushOutbox() und prüft: Draft geleert + Server trägt den neuen
// Inhalt + Pending-Zähler 1 → 0.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

async function bootApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null,
    { timeout: 30000 },
  );
}

async function selectSeededBook(page) {
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId,
    { timeout: 20000 },
  );
  return bookId;
}

test('Outbox synct offline-Draft einer nicht geöffneten Seite beim Flush', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  const marker = `OutboxSyncMarker${Date.now()}`;

  // Draft für die erste Seite seeden (Editor ist NICHT offen → editMode false).
  const pageId = await page.evaluate(async (mk) => {
    const pid = window.Alpine.store('nav').pages[0].id;
    // Frischen Server-Stand holen → als 3-Way-Ancestor + expected_updated_at.
    const server = await fetch('/content/pages/' + pid).then((r) => r.json());
    const draft = {
      html: `<p>${mk}</p>` + (server.html || '<p></p>'),
      originalHtml: server.html || '',
      originalUpdatedAt: server.updated_at || null,
      savedAt: Date.now(),
    };
    localStorage.setItem('editor_draft_' + pid, JSON.stringify(draft));
    // draft:changed feuert normalerweise write-seitig; hier direkt setItem →
    // Zähler manuell neu rechnen lassen.
    window.__app._refreshPendingSyncCount();
    return pid;
  }, marker);

  // Pending-Zähler zeigt die wartende Seite.
  expect(await page.evaluate(() => window.Alpine.store('session').pendingSyncCount)).toBe(1);

  // Flush anstossen (wie beim online/focus-Event).
  await page.evaluate(() => window.__app._flushOutbox());

  // Draft ist geleert → als synchronisiert markiert.
  const draftGone = await page.evaluate((pid) => localStorage.getItem('editor_draft_' + pid) === null, pageId);
  expect(draftGone).toBe(true);

  // Zähler zurück auf 0.
  expect(await page.evaluate(() => window.Alpine.store('session').pendingSyncCount)).toBe(0);

  // Server trägt jetzt den Marker.
  const serverHasMarker = await page.evaluate(async (arg) => {
    const p = await fetch('/content/pages/' + arg.pid + '?__fresh=1').then((r) => r.json());
    return (p.html || '').includes(arg.mk);
  }, { pid: pageId, mk: marker });
  expect(serverHasMarker).toBe(true);

  guard.assertClean('Outbox-Flush');
});

test('Outbox überspringt die gerade offene Edit-Seite (kein Dazwischenfunken)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  // Erste Seite im Notebook-Editor öffnen (Edit-Modus).
  await page.evaluate(async () => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
    window.__app.startEdit();
  });
  await page.waitForFunction(() => window.__app.editMode === true, null, { timeout: 10000 });

  // Draft für genau diese offene Seite seeden + flushen. Die Outbox darf ihn
  // NICHT synchronisieren/clearen — die Seite gehört dem Live-Editor.
  const stillThere = await page.evaluate(async () => {
    const pid = window.__app.currentPage.id;
    localStorage.setItem('editor_draft_' + pid, JSON.stringify({
      html: '<p>live edit</p>', originalHtml: '', originalUpdatedAt: null, savedAt: Date.now(),
    }));
    await window.__app._flushOutbox();
    return localStorage.getItem('editor_draft_' + pid) !== null;
  });
  expect(stillThere).toBe(true);

  guard.assertClean('Outbox-Skip-offene-Seite');
});

test('Save-Indicator zeigt `unsaved`, wenn der lokale Draft-Write fehlschlägt (Speicher voll)', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  // Notebook-Seite öffnen + Edit-Modus (Save-Indicator ist nur dort im DOM).
  await page.evaluate(async () => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
    window.__app.startEdit();
  });
  await page.waitForFunction(() => window.__app.editMode === true, null, { timeout: 10000 });

  // Persist-Fehler simulieren (localStorage voll) → höchstpriorer Zustand.
  const { kind, text, expected } = await page.evaluate(() => {
    window.__app.draftPersistFailed = true;
    return {
      kind: window.__app.lastSavedKind(),
      text: window.__app.saveIndicatorText(),
      expected: window.__app.t('edit.status.unsaved'),
    };
  });
  expect(kind).toBe('unsaved');
  expect(text).toBe(expected);

  // Auch im DOM: Klasse + Text am Save-Indicator. Notebook- und Focus-Editor
  // teilen den Root-Zustand → beide Indikatoren tragen die unsaved-Klasse
  // (korrekt); der erste (Notebook) genügt für die Assertion.
  await expect(page.locator('.save-indicator--unsaved .save-indicator__text').first()).toHaveText(expected);

  guard.assertClean('Unsaved-Indicator');
});
