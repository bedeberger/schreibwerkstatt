// Hilfe-Reiter „Funktionen" gegen die echte App — der Katalog kommt aus der
// Feature-Registry (public/js/cards/help-catalog.js). Der Unit-Test prueft die
// Keys und die Filterlogik; hier geht es um das, was nur die gebootete App
// zeigt: dass jede Kachel uebersetzt rendert (kein Rohkey), die Suche filtert
// und „Oeffnen" ueber den Root-Toggle tatsaechlich die Zielkarte oeffnet.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');
const { bootApp } = require('./_helpers/app');

async function openFeaturesTab(page) {
  await page.locator('.header-help-btn').click();
  await expect(page.locator('.card--help')).toBeVisible();
  // Bei ungelesenen Notizen oeffnet die Hilfe auf „Neuigkeiten" — erster Reiter
  // ist immer „Funktionen".
  await page.locator('.card--help .tabs-btn').first().click();
  const panel = page.locator('.card--help .help-tab-panel').first();
  await expect(panel).toBeVisible();
  return panel;
}

test('Funktionen: gruppiert, uebersetzt, ohne Rohkeys', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const panel = await openFeaturesTab(page);

  const groups = panel.locator('.help-group');
  expect(await groups.count()).toBeGreaterThan(3);
  expect(await panel.locator('.help-feature').count()).toBeGreaterThan(30);

  const texts = await panel.locator('.help-group-title, .help-feature-title, .help-feature p, .help-feature .badge')
    .allInnerTexts();
  const raw = texts.filter(t => /^(help|tile|palette|mystats|mybooks|autorenprofil)\.[a-zA-Z.]+$/.test(t.trim()));
  expect(raw).toEqual([]);

  guard.assertClean('Hilfe-Funktionen rendern');
});

test('Funktionen: Suche filtert, „Oeffnen" oeffnet die Karte', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  const panel = await openFeaturesTab(page);

  const title = await page.evaluate(() => window.__app.t('tile.search'));
  await panel.locator('.filter-search-input').fill(title);
  const hits = panel.locator('.help-feature', { has: page.locator('.help-feature-title', { hasText: title }) });
  await expect(hits.first()).toBeVisible();
  expect(await panel.locator('.help-feature').count()).toBeLessThan(10);

  await panel.locator('.filter-search-input').fill('zzzz-kein-treffer');
  await expect(panel.locator('.help-feature')).toHaveCount(0);
  await expect(panel.locator('p', { hasText: await page.evaluate(() => window.__app.t('help.noResults')) })).toBeVisible();

  await panel.locator('.filter-search-input').fill(title);
  await hits.first().locator('.help-feature-open').click();
  await expect.poll(() => page.evaluate(() => !!window.__app.showSearchCard)).toBe(true);
  await expect.poll(() => page.evaluate(() => !!window.__app.showHelpCard)).toBe(false);

  guard.assertClean('Hilfe-Suche + Oeffnen');
});
