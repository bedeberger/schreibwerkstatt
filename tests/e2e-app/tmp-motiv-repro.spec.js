// TEMP-Repro (wird nach Diagnose geloescht): Motiv-Werkstatt Save-Handling.
const { test, expect } = require('@playwright/test');

async function bootApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
}
async function selectSeededBook(page) {
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 },
  );
  return bookId;
}

test('REPRO: createMotifAt-Rename → Graph-Label + Combobox-Link → Dirty', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);

  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => {
    const el = document.querySelector('.card--motiv');
    if (!el) return false;
    const c = window.Alpine.$data(el);
    return c && !c.loading;
  }, null, { timeout: 15000 });

  // Motiv frisch anlegen wie im Graph-Kontextmenü (Default-Name).
  await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));
    await card.createMotifAt(null);
  });

  await page.waitForFunction(() => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    return !!c._motivNetwork && !c.busy;
  }, null, { timeout: 15000 });

  // ── Bug 1: Umbenennen über die UI (Enter im Namensfeld) ──
  const nameInput = page.locator('.motiv-name-input');
  await nameInput.fill('Feuer');
  await nameInput.press('Enter');
  await page.waitForFunction(() => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    return !c.busy;
  }, null, { timeout: 15000 });
  await page.waitForTimeout(600);

  const graphState = await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    const id = c.selectedMotifId;
    const node = c._motivNodes ? c._motivNodes.get('m' + id) : null;
    return {
      motifName: c.motifById(id)?.name,
      nodeLabel: node ? node.label : '(kein node)',
      err: c.errorMessage,
    };
  });
  console.log('BUG1 graphState:', JSON.stringify(graphState));

  // ── Bug 2: Kapitel-Verknüpfung über die echte Combobox wählen ──
  const chapGroup = page.locator('.motiv-link-group').nth(2);
  await chapGroup.locator('.combobox-trigger').scrollIntoViewIfNeeded();
  await chapGroup.locator('.combobox-trigger').click();
  const opt = chapGroup.locator('.combobox-option').first();
  await expect(opt).toBeVisible();
  await opt.click();
  await page.waitForTimeout(300);

  const linkState = await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    return {
      editChapters: c.editChapters.map(x => x.name),
      dirty: c.motifDirty(),
      linkChapTmp: c.linkChapTmp,
    };
  });
  console.log('BUG2 linkState (nach 1. Auswahl):', JSON.stringify(linkState));

  // Zweite Auswahl — landet jetzt die ERSTE (stale) Auswahl im Puffer?
  await chapGroup.locator('.combobox-trigger').click();
  const opt2 = chapGroup.locator('.combobox-option').nth(1);
  await expect(opt2).toBeVisible();
  await opt2.click();
  await page.waitForTimeout(300);
  const linkState2 = await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('.card--motiv'));
    return { editChapters: c.editChapters.map(x => x.name), dirty: c.motifDirty() };
  });
  console.log('BUG2 linkState (nach 2. Auswahl):', JSON.stringify(linkState2));

  console.log('GRAPH-LABEL-CHECK:', graphState.nodeLabel === 'Feuer' ? 'OK' : 'STALE');
});
