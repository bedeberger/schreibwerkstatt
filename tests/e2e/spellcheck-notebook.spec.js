// E2E: Spellcheck-Controller im Notebook-Editor-Setup.
// Harness mountet den Controller direkt; LT-Endpoint ist im Test-Server
// gemockt (Walld -> Tippfehler, scheinet -> Grammatik).

const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/fixtures/spellcheck-harness.html?kind=notebook';

test('notebook: squiggle erscheint nach Debounce', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  // Initial-Check: debounce 1.5s nicht noetig, attach loest Sofort-Check aus.
  await page.waitForSelector('.lt-squiggle', { timeout: 5000 });
  const count = await page.locator('.lt-squiggle').count();
  expect(count).toBeGreaterThanOrEqual(2);
});

test('notebook: status-badge zeigt match-count', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-badge[data-state="matches"]', { timeout: 5000 });
  const label = await page.locator('.lt-badge__label').textContent();
  expect(parseInt(label, 10)).toBeGreaterThanOrEqual(2);
});

test('notebook: klick auf squiggle oeffnet popover', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-squiggle');
  await page.locator('.lt-squiggle').first().dispatchEvent('mousedown');
  await page.waitForSelector('.lt-popover');
  const replacements = await page.locator('.lt-popover__replacement').count();
  expect(replacements).toBeGreaterThanOrEqual(1);
});

test('notebook: replacement-klick ersetzt text', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-squiggle');
  await page.locator('.lt-squiggle').first().dispatchEvent('mousedown');
  await page.waitForSelector('.lt-popover');
  await page.locator('.lt-popover__replacement').first().click();
  // Walld -> Wald (erstes Replacement).
  await expect.poll(() => page.locator('#editor').textContent()).not.toContain('Walld');
});
