// E2E: Spellcheck-Controller im Focus-Editor-Setup.

const { test, expect } = require('@playwright/test');

const HARNESS = '/tests/fixtures/spellcheck-harness.html?kind=focus';

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

async function clickFirstSquiggle(page) {
  const pt = await page.evaluate(() => {
    for (const k of ['lt-typo', 'lt-grammar', 'lt-style']) {
      const h = CSS.highlights.get(k);
      if (!h || !h.size) continue;
      const range = h.values().next().value;
      const r = range.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    return null;
  });
  if (!pt) throw new Error('no squiggle present');
  await page.mouse.click(pt.x, pt.y);
}

test('focus: squiggle erscheint, badge sichtbar', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await page.waitForSelector('.lt-badge[data-editor="focus"]');
});

test('focus: ignore entfernt squiggle bis zur naechsten Pruefung', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  const initial = await squiggleCount(page);
  await clickFirstSquiggle(page);
  await page.waitForSelector('.lt-popover');
  await page.locator('.lt-popover__ignore').click();
  await expect.poll(() => squiggleCount(page)).toBeLessThan(initial);
});

test('focus: detach raeumt highlights + badge', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await page.evaluate(() => window.__spellcheckCtl.detach());
  await expect.poll(() => squiggleCount(page)).toBe(0);
  await expect.poll(() => page.locator('.lt-badge').count()).toBe(0);
});
