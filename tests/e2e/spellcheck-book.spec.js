// E2E: Spellcheck-Controller im Bucheditor-Setup.

const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/fixtures/spellcheck-harness.html?kind=book';

async function squiggleCount(page) {
  return page.evaluate(() => {
    return ['lt-typo', 'lt-grammar', 'lt-style'].reduce((sum, k) => {
      const h = CSS.highlights.get(k);
      return sum + (h ? h.size : 0);
    }, 0);
  });
}

async function waitForSquiggles(page, timeout = 5000) {
  await page.waitForFunction(() => {
    return ['lt-typo', 'lt-grammar', 'lt-style'].some((k) => {
      const h = CSS.highlights.get(k);
      return h && h.size > 0;
    });
  }, null, { timeout });
}

test('book: badge traegt data-editor=book', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-badge[data-editor="book"]');
});

test('book: matches sichtbar nach Initial-Check', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  expect(await squiggleCount(page)).toBeGreaterThan(0);
});

test('book: status-badge erscheint', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-badge[data-editor="book"]');
  const state = await page.locator('.lt-badge').first().getAttribute('data-state');
  expect(['matches', 'clean', 'loading']).toContain(state);
});
