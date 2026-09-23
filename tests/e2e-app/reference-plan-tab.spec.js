// Plan-Tab des REFERENZ-SLOTS (Begleitpanel neben dem Notebook-Editor), gegen
// die ECHTE App.
//
// WARUM DIESE SCHICHT: der Slot ist kein Eintrag in `EXCLUSIVE_CARDS` — der
// registry-getriebene Smoke-Test öffnet ihn nie. Geprüft wird die Kette, die
// kein Unit-Test abbilden kann: Beat im Board anlegen → Slot lädt GET /plot/ →
// Kontext-Filter nach Kapitel → Klick springt per Beat-Permalink aufs Board.
//
// Geprüfte Invarianten:
//   1. Das Tab erscheint, sobald das Buch einen aktiven Beat hat.
//   2. Seiten-Scope zeigt den Beat des Seiten-KAPITELS, nicht den eines anderen.
//   3. Buch-Scope zeigt beide.
//   4. Klick setzt `#book/:id/plot/<beatId>` und öffnet das Beat-Board.
//   5. Nichts davon erzeugt einen unbehandelten Alpine-/Library-Fehler.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const REF = '#reference-card';
const TITLE_A = 'Referenz-Plan Beat A';
const TITLE_B = 'Referenz-Plan Beat B';

async function postJson(page, url, body) {
  return page.evaluate(async ({ u, b }) => {
    const res = await fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    return res.json();
  }, { u: url, b: body });
}

async function openPlanTab(page, pageIdx) {
  await page.evaluate(async (i) => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[i]);
  }, pageIdx);
  await page.waitForFunction(() => window.__app.showEditorCard === true, null, { timeout: 15000 });
  await page.evaluate(async () => { await window.__app.toggleReferenceCard(); });
  await page.waitForSelector(REF, { state: 'visible', timeout: 15000 });
  const tab = page.locator(`${REF} .tabs-btn`, { hasText: 'Plan' });
  await expect(tab).toBeVisible({ timeout: 15000 });   // Invariante 1
  await tab.click();
}

const rowByTitle = (page, title) => page.locator(`${REF} .reference-row`, { hasText: title });

test('Referenz-Slot: Plan-Tab zeigt die Beats des Kapitels und springt aufs Board', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await bootApp(page);
  const bookId = await selectSeededBook(page);

  const idx = await page.evaluate(() => {
    const pages = window.Alpine.store('nav').pages;
    const first = pages.findIndex(p => p.chapter_id != null);
    const other = pages.findIndex(p => p.chapter_id != null && p.chapter_id !== pages[first].chapter_id);
    return { first, other, chA: pages[first]?.chapter_id, chB: pages[other]?.chapter_id };
  });
  expect(idx.first).toBeGreaterThanOrEqual(0);
  expect(idx.other).toBeGreaterThanOrEqual(0);

  const act = await postJson(page, '/plot/acts', { book_id: bookId, name: 'Referenz-Plan Akt' });
  const beatA = await postJson(page, '/plot/beats', { book_id: bookId, act_id: act.id, titel: TITLE_A, chapter_id: idx.chA, beschreibung: 'Soll im Kapitel A passieren.' });
  const beatB = await postJson(page, '/plot/beats', { book_id: bookId, act_id: act.id, titel: TITLE_B, chapter_id: idx.chB });
  expect(beatA.id).toBeTruthy();
  expect(beatB.id).toBeTruthy();

  // Invariante 2: Seiten-Scope = Kapitel der offenen Seite.
  await openPlanTab(page, idx.first);
  await expect(rowByTitle(page, TITLE_A)).toBeVisible();
  await expect(rowByTitle(page, TITLE_A)).toContainText('Soll im Kapitel A passieren.');
  await expect(rowByTitle(page, TITLE_B)).toHaveCount(0);

  // Invariante 3: Buch-Scope zeigt beide.
  await page.locator(`${REF} .card-actions .icon-btn`).first().click();
  await expect(rowByTitle(page, TITLE_A)).toBeVisible();
  await expect(rowByTitle(page, TITLE_B)).toBeVisible();

  // Invariante 4: Beat-Permalink aufs Board.
  await rowByTitle(page, TITLE_B).click();
  await expect(page).toHaveURL(new RegExp(`#book/${bookId}/plot/${beatB.id}$`));
  await page.waitForFunction(() => window.__app.showPlotCard === true, null, { timeout: 15000 });

  expect(errors).toEqual([]);   // Invariante 5
});
