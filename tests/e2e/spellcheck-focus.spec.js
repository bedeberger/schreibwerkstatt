// E2E: Spellcheck-Controller im Focus-Editor-Setup.

const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/fixtures/spellcheck-harness.html?kind=focus';

test('focus: squiggle erscheint, badge sichtbar', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-overlay[data-editor="focus"]', { timeout: 5000 });
  await page.waitForSelector('.lt-squiggle');
  await page.waitForSelector('.lt-badge[data-editor="focus"]');
});

test('focus: ignore entfernt squiggle bis zur naechsten Pruefung', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-squiggle');
  const initial = await page.locator('.lt-squiggle').count();
  await page.locator('.lt-squiggle').first().dispatchEvent('mousedown');
  await page.waitForSelector('.lt-popover');
  await page.locator('.lt-popover__ignore').click();
  await expect.poll(() => page.locator('.lt-squiggle').count()).toBeLessThan(initial);
});

test('focus: detach raeumt overlay + badge', async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => window.__harnessReady === true);
  await page.waitForSelector('.lt-squiggle');
  await page.evaluate(() => window.__spellcheckCtl.detach());
  await expect.poll(() => page.locator('.lt-overlay').count()).toBe(0);
  await expect.poll(() => page.locator('.lt-badge').count()).toBe(0);
});
