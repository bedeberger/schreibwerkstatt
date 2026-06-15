// Interaktions-Regressionsguard für die radioGroup-Komponente gegen die echte
// App (playwright.app.config.js). Der Smoke-Test prüft nur Konsolenfehler, NICHT
// Interaktivität — diese Schicht klickt durch:
//   1. book-settings: Region-Optionen reagieren reaktiv auf den Sprachwechsel
//      (inline x-effect liest bookSettingsLanguage), Region ist wählbar.
//   2. folder-import: das per-Option `disabled`-Flag (Card-Variante) reagiert
//      reaktiv auf $app.selectedBookId.
// Warum nötig: `:disabled="opt.disabled"` mit undefined sperrt in Alpine JEDE
// Option (Boolean-Attr wird bei undefined nicht entfernt) — ein Bug, der ohne
// echten Klick unsichtbar bleibt.
const { test, expect } = require('@playwright/test');

async function bootApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.__app.books) && window.__app.books.length > 0,
    null, { timeout: 30000 });
  const bookId = await page.evaluate(() => window.__app.books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.__app.selectedBookId) === String(id)
            && Array.isArray(window.__app.pages) && window.__app.pages.length > 0,
    bookId, { timeout: 20000 });
}

test('book-settings: Region-Gruppe reagiert reaktiv auf Sprachwechsel', async ({ page }) => {
  await bootApp(page);
  await page.evaluate(() => window.__app.toggleBookSettingsCard());
  await page.waitForTimeout(600);

  const vis = (val) => page.locator(`input[type="radio"][value="${val}"]:visible`);

  // Sprache → englisch: Region-Optionen müssen US/GB sein, NICHT CH/DE.
  await vis('en').first().click();
  await page.waitForTimeout(250);
  expect(await vis('US').count(), 'US sichtbar nach en').toBe(1);
  expect(await vis('GB').count(), 'GB sichtbar nach en').toBe(1);
  expect(await vis('CH').count(), 'CH weg nach en').toBe(0);
  expect(await vis('DE').count(), 'DE weg nach en').toBe(0);

  // Sprache → deutsch: jetzt CH/DE, NICHT US/GB.
  await vis('de').first().click();
  await page.waitForTimeout(250);
  expect(await vis('CH').count(), 'CH sichtbar nach de').toBe(1);
  expect(await vis('DE').count(), 'DE sichtbar nach de').toBe(1);
  expect(await vis('US').count(), 'US weg nach de').toBe(0);
  expect(await vis('GB').count(), 'GB weg nach de').toBe(0);

  // Region wählbar → schreibt zurück in den Karten-State.
  await vis('DE').first().click();
  await page.waitForTimeout(150);
  expect(await vis('DE').first().isChecked(), 'DE checked nach Klick').toBe(true);
});

test('folder-import: Merge-Option disabled reagiert reaktiv auf selectedBookId', async ({ page }) => {
  await bootApp(page);
  await page.evaluate(() => window.__app.toggleFolderImportCard());
  await page.waitForTimeout(600);

  const merge = page.locator('input[type="radio"][value="merge"]:visible');
  // Card-Variante muss gerendert sein.
  expect(await page.locator('.form-radio-group--card').count(), 'card-Variante gerendert')
    .toBeGreaterThan(0);

  // Buch gewählt → Merge aktivierbar.
  expect(await merge.isDisabled(), 'Merge enabled bei gewähltem Buch').toBe(false);

  // Buch entfernen → Merge wird disabled (reaktiv via inline $app.selectedBookId).
  await page.evaluate(() => { window.__app.selectedBookId = ''; });
  await page.waitForTimeout(250);
  expect(await merge.isDisabled(), 'Merge disabled ohne Buch').toBe(true);
});
