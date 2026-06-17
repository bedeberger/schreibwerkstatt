// E2E: Spellcheck-Controller im Focus-Editor-Setup.

const { test, expect } = require('./_helpers/fixtures');

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

test('focus: ersetzung am absatz-ende lässt caret IM absatz (kein sprung in den leeren folge-<p>)', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  const res = await page.evaluate(() => {
    const root = document.getElementById('editor');
    // Typo als LETZTES Wort im Absatz + leerer Folge-<p> (wie der Focus-Auto-
    // Trailing-Slot). Genau diese Geometrie liess den Caret früher hinter den
    // Absatz in den leeren <p> rutschen (setStartAfter(range.endContainer) →
    // Boundary auf <p> → Caret nach dem Block → Normalisierung in den nächsten).
    root.innerHTML = '<p>Das ist wunderbra</p><p><br></p>';
    const paras = Array.from(root.querySelectorAll('p'));
    const tn = paras[0].firstChild;
    const range = document.createRange();
    range.setStart(tn, 'Das ist '.length);
    range.setEnd(tn, tn.length);
    window.__applySpellcheckReplacement(range, 'wunderbar');
    const sel = window.getSelection();
    const n = sel.anchorNode;
    const el = n && (n.nodeType === 3 ? n.parentElement : n);
    const block = el && el.closest('p');
    return {
      firstText: paras[0].textContent,
      caretInFirstParagraph: block === paras[0],
      caretInTrailingEmpty: block === paras[1],
    };
  });
  expect(res.firstText).toBe('Das ist wunderbar');
  expect(res.caretInFirstParagraph).toBe(true);
  expect(res.caretInTrailingEmpty).toBe(false);
});

test('focus: detach raeumt highlights + badge', async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
  await waitForSquiggles(page);
  await page.evaluate(() => window.__spellcheckCtl.detach());
  await expect.poll(() => squiggleCount(page)).toBe(0);
  await expect.poll(() => page.locator('.lt-badge').count()).toBe(0);
});
