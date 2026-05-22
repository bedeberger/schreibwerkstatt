// E2E: Spellcheck-Controller im Bucheditor-Setup.

const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/fixtures/spellcheck-harness.html?kind=book';

test('book: overlay traegt data-editor=book', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-overlay[data-editor="book"]');
});

test('book: matches sichtbar nach Initial-Check', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-squiggle');
  expect(await page.locator('.lt-squiggle').count()).toBeGreaterThan(0);
});

test('book: status-badge erscheint', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-badge[data-editor="book"]');
  const state = await page.locator('.lt-badge').first().getAttribute('data-state');
  expect(['matches', 'clean', 'loading']).toContain(state);
});
