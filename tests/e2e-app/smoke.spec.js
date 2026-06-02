// Full-SPA-Smoke gegen die echte App (siehe playwright.app.config.js).
//
// Zweck: Alpine-/Library-Laufzeitfehler abfangen, die Unit-/Integration-Tests
// nie sehen, weil sie kein Browser-DOM rendern, und die die Fixture-Harnesses
// nur fuer einzeln gemountete Karten abdecken. Hier laeuft der KOMPLETTE
// Template-Baum: jede Hauptkarte wird geoeffnet und alle drei Editoren
// (Notebook/Focus/Bucheditor) betreten. Tritt dabei irgendein unbehandelter
// Fehler auf (Alpine wirft Expression-Fehler asynchron via setTimeout →
// pageerror, plus console-Spur), schlaegt der Smoke fehl.
//
// Die Karten-Liste wird zur Laufzeit aus dem Root-Alpine-Proxy abgeleitet
// (alle `toggleXxxCard`-Methoden) — kein Drift gegen feature-registry.js:
// neue Karte ⇒ automatisch im Smoke.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

// App-Boot abwarten: Alpine-Root in window.__app verfuegbar + Buecher geladen.
async function bootApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.__app.books) && window.__app.books.length > 0,
    null,
    { timeout: 30000 },
  );
}

// Seed-Buch auswaehlen + Seiten laden (via Hash-Deeplink → _applyHash).
async function selectSeededBook(page) {
  const bookId = await page.evaluate(() => window.__app.books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.__app.selectedBookId) === String(id)
            && Array.isArray(window.__app.pages) && window.__app.pages.length > 0,
    bookId,
    { timeout: 20000 },
  );
  return bookId;
}

test.describe.configure({ mode: 'serial' });

test('SPA bootet ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);
  await page.waitForTimeout(500);
  guard.assertClean('Boot + Buchauswahl');
});

test('jede Hauptkarte oeffnet ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  // Toggle-Namen aus der Feature-Registry (SSoT EXCLUSIVE_CARDS) ziehen — kein
  // Drift, neue Karte ⇒ automatisch dabei. Nur Toggles, die am Root als
  // Funktion existieren (bespoke/admin inkl.).
  const toggles = await page.evaluate(async () => {
    const reg = await import('/js/cards/feature-registry.js');
    return reg.EXCLUSIVE_CARDS
      .map((c) => c.toggle)
      .filter((t) => typeof window.__app[t] === 'function')
      .sort();
  });
  expect(toggles.length, 'mind. eine Toggle-Karte gefunden').toBeGreaterThan(5);

  const failures = [];
  for (const name of toggles) {
    // Vorherige Karte schliessen, damit Exklusivitaet sauber durchlaeuft.
    await page.evaluate(() => window.__app._closeOtherMainCards?.(null));
    await page.waitForTimeout(80);
    const before = guard.unmatched().length;
    try {
      await page.evaluate((n) => Promise.resolve(window.__app[n]()), name);
    } catch (e) {
      failures.push(`${name}: toggle warf ${e.message}`);
      continue;
    }
    // Render + Lazy-Partial-Inject + Sub-Mount abwarten.
    await page.waitForTimeout(450);
    const fresh = guard.unmatched().slice(before);
    if (fresh.length) {
      failures.push(`${name}:\n    ${fresh.map((f) => `[${f.channel}] ${f.text}`).join('\n    ')}`);
    }
  }

  expect(failures, `Karten mit Fehlern:\n${failures.join('\n')}`).toEqual([]);
});

test('alle drei Editoren oeffnen ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  const failures = [];

  // Notebook-Editor: erste Seite selektieren (selectPage → Editor-Modus).
  let before = guard.unmatched().length;
  await page.evaluate(async () => { await window.__app.selectPage(window.__app.pages[0]); });
  await page.waitForTimeout(500);
  let fresh = guard.unmatched().slice(before);
  if (fresh.length) failures.push(`Notebook-Editor:\n    ${fresh.map((f) => `[${f.channel}] ${f.text}`).join('\n    ')}`);

  // Focus-Editor: Page-View-Direkteinstieg (realistischer Pfad aus der
  // gerade geoeffneten Seite; Trampoline-Event, editor-focus-card hoert darauf).
  before = guard.unmatched().length;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('editor:focus:enter-from-pageview')));
  await page.waitForTimeout(600);
  fresh = guard.unmatched().slice(before);
  if (fresh.length) failures.push(`Focus-Editor:\n    ${fresh.map((f) => `[${f.channel}] ${f.text}`).join('\n    ')}`);

  // Focus wieder verlassen + Bucheditor (Manuskript-Stream).
  before = guard.unmatched().length;
  await page.evaluate(async () => {
    window.dispatchEvent(new CustomEvent('editor:focus:exit'));
    window.__app._closeOtherMainCards?.(null);
    await Promise.resolve(window.__app.toggleBookEditorCard());
  });
  await page.waitForTimeout(600);
  fresh = guard.unmatched().slice(before);
  if (fresh.length) failures.push(`Bucheditor:\n    ${fresh.map((f) => `[${f.channel}] ${f.text}`).join('\n    ')}`);

  expect(failures, `Editoren mit Fehlern:\n${failures.join('\n')}`).toEqual([]);
});
