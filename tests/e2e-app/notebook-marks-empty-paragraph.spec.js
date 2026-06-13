// Regression: Steuerzeichen-Anzeige (pageEditorShowMarks) im Notebook-Editor.
// Ein leerer Absatz (<p><br></p>) — typisch am Ende eines Gedichts — darf NICHT
// doppelt hoch werden: die ¶-Marke darf nicht via CSS-::after hinter den <br>
// auf eine Phantom-Zweitzeile rutschen (entkoppelt die sichtbare Marke vom
// Caret-Slot → leerer Absatz wirkt unklickbar). Stattdessen lässt CSS Blöcke mit
// direktem <br> aus (`:not(:has(> br))`) und das Overlay (format-marks.js)
// zeichnet die ¶ gemessen auf der richtigen Zeile. Siehe
// public/css/page/page-view.css + public/js/editor/notebook/format-marks.js.

const { test, expect } = require('@playwright/test');

const EDIT_SEL = '#editor-card .page-content-view--editing';

const HTML =
  '<p>Klartext-Absatz</p>' +
  '<p>Weich<br>umbruch</p>' +
  '<p>Trailing<br></p>' +
  '<div class="poem">' +
    '<p>Ich liebe dich\nWeil so muss es sein</p>' +
    '<p>Aber anders nicht.\nVergeiss mein nicht</p>' +
    '<p><br></p>' +
  '</div>';

async function bootAndEnterEditor(page) {
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
  await page.evaluate(async () => { await window.__app.selectPage(window.__app.pages[0]); });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 10000 });
  await page.waitForTimeout(200);
}

test('Fix: leerer Absatz im Gedicht ist einzeilig, markiert + klickbar', async ({ page }) => {
  await bootAndEnterEditor(page);

  await page.evaluate(({ sel, html }) => {
    const root = document.querySelector(sel);
    root.innerHTML = html;
    window.__app.pageEditorShowMarks = false;
    window.__notebookCard.togglePageEditorShowMarks(); // → an, installiert Overlay
    window.__notebookCard._renderFormatMarks();
  }, { sel: EDIT_SEL, html: HTML });
  await page.waitForTimeout(120);

  const data = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const lineH = parseFloat(getComputedStyle(root).lineHeight) || 24;
    const poem = root.querySelector('.poem');
    const emptyP = poem.lastElementChild;
    const plain = root.querySelector('p'); // erster: Klartext (kein <br>)
    const layer = root.parentElement.querySelector('.page-editor-marks-layer');
    const pilcrows = [...layer.querySelectorAll('.format-mark--pilcrow')];
    const emptyRect = emptyP.getBoundingClientRect();
    // Pilcrow, der auf der leeren <p>-Zeile sitzt (top ~ emptyP.top).
    const onEmpty = pilcrows.some((m) => {
      const r = m.getBoundingClientRect();
      return Math.abs(r.top - emptyRect.top) < lineH;
    });
    return {
      lineH: Math.round(lineH),
      emptyP_h: Math.round(emptyRect.height),
      emptyP_html: emptyP.outerHTML,
      plainHasCssMark: !!plain && !/<br/.test(plain.innerHTML), // CSS ::after greift
      pilcrowCount: pilcrows.length,
      pilcrowOnEmptyLine: onEmpty,
    };
  }, EDIT_SEL);
  console.log('\n=== FIX CHECK ===\n' + JSON.stringify(data, null, 2));

  // 1) Leerer Absatz ist wieder EINZEILIG (vorher ~2× lineHeight wegen Phantom-Zeile).
  expect(data.emptyP_h).toBeLessThan(Math.round(data.lineH * 1.6));
  // 2) Overlay markiert die <br>-Blöcke: leerer <p>, Weichumbruch, Trailing-<br> → 3.
  expect(data.pilcrowCount).toBe(3);
  // 3) Eine ¶-Marke sitzt auf der Zeile des leeren Absatzes.
  expect(data.pilcrowOnEmptyLine).toBe(true);

  // 4) Klick auf den leeren Absatz platziert den Caret darin.
  const er = await page.evaluate((sel) => {
    const r = document.querySelector(sel).querySelector('.poem').lastElementChild.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, EDIT_SEL);
  await page.mouse.click(er.x, er.y);
  await page.waitForTimeout(50);
  const caretOk = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const s = getSelection();
    if (!s || !s.rangeCount) return false;
    const el = s.anchorNode && s.anchorNode.nodeType === 3 ? s.anchorNode.parentElement : s.anchorNode;
    return !!(el && el.closest && el.closest('.poem') && el.tagName === 'P' && !el.textContent.trim());
  }, EDIT_SEL);
  expect(caretOk).toBe(true);

  // 5) Backspace entfernt den leeren Absatz aus dem Gedicht.
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(50);
  const afterBs = await page.evaluate((sel) => document.querySelector(sel).querySelector('.poem').lastElementChild.outerHTML, EDIT_SEL);
  console.log('Poem-Ende nach Backspace:', afterBs);
  expect(afterBs).not.toContain('<br>');
});
