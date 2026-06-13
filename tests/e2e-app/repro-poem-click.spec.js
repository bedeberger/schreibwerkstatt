// TEMP-REPRO (löschbar): reproduziert "letzten leeren Absatz im Gedicht am
// Dokument-Ende nicht anklickbar" im Notebook-Editor gegen die echte App.
// Setzt die exakte gemeldete Struktur (div.poem als letztes Element mit
// trailing <p><br></p>) und prüft, wo der Caret bei Klicks landet.

const { test, expect } = require('@playwright/test');

const EDIT_SEL = '#editor-card .page-content-view--editing';

// Viel Füll-Text davor, damit der Editor (max-height 70vh) scrollt und das
// Gedicht am unteren Ende eines Scroll-Containers liegt — wie in der realen Seite.
const FILLER = Array.from({ length: 40 },
  (_, i) => `<p>Fülltext-Absatz ${i + 1} mit genug Text, damit der Editor scrollt und das Gedicht ans untere Ende rutscht.</p>`).join('');

const POEM_HTML =
  FILLER +
  '<p>Gut so.</p>' +
  '<p>04.06.2026 15:24</p>' +
  '<div class="poem">' +
    '<p>Ich liebe dich\nWeil so muss es sein\nDann bin mich\nWeil so bist dein</p>' +
    '<p>Aber anders nicht.\nVergeiss mein nicht</p>' +
    '<p><br></p>' +
  '</div>';

async function bootAndEnterEditor(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.__app.books) && window.__app.books.length > 0,
    null, { timeout: 30000 },
  );
  const bookId = await page.evaluate(() => window.__app.books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.__app.selectedBookId) === String(id)
            && Array.isArray(window.__app.pages) && window.__app.pages.length > 0,
    bookId, { timeout: 20000 },
  );
  await page.evaluate(async () => { await window.__app.selectPage(window.__app.pages[0]); });
  await page.waitForTimeout(300);
  await page.evaluate(() => window.__app.startEdit());
  await page.waitForSelector(EDIT_SEL, { timeout: 10000 });
  await page.waitForTimeout(200);
}

function caretInfo(page) {
  return page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const s = getSelection();
    if (!s || !s.rangeCount) return { ok: false, reason: 'no selection' };
    const a = s.anchorNode;
    const el = a && a.nodeType === 3 ? a.parentElement : a;
    if (!root.contains(el)) return { ok: false, reason: 'caret outside editor', html: el && el.outerHTML };
    // Beschreibe den Block, in dem der Caret steckt.
    let block = el;
    while (block && block.parentElement !== root && !(block.parentElement && block.parentElement.classList.contains('poem'))) {
      block = block.parentElement;
    }
    return {
      ok: true,
      anchorTag: el && el.tagName,
      inPoem: !!(el && el.closest && el.closest('.poem')),
      isEmptyP: !!(el && el.tagName === 'P' && !el.textContent.trim()),
      offset: s.anchorOffset,
      blockText: (block && block.textContent || '').slice(0, 30),
    };
  }, EDIT_SEL);
}

test('REPRO: leerer Absatz am Ende eines Gedichts am Dokument-Ende', async ({ page }) => {
  await bootAndEnterEditor(page);

  // Steuerzeichen-Anzeige wie im gemeldeten Screenshot einschalten.
  await page.evaluate(() => { window.__app.pageEditorShowMarks = true; });
  await page.evaluate(({ sel, html }) => {
    const root = document.querySelector(sel);
    root.innerHTML = html;
    root.scrollTop = root.scrollHeight; // ans untere Ende scrollen (wie der User)
  }, { sel: EDIT_SEL, html: POEM_HTML });
  await page.waitForTimeout(100);

  // Vergleich: top-level <p><br></p> (white-space normal) vs. im Gedicht
  // (white-space pre-line), beide mit show-marks. Zeigt, ob pre-line die
  // Phantom-Zeile verursacht.
  const cmp = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const top = document.createElement('p'); top.appendChild(document.createElement('br'));
    root.insertBefore(top, root.firstChild);
    const h = Math.round(top.getBoundingClientRect().height);
    top.remove();
    return { topLevelEmptyP_h: h, poemEmptyP_h: Math.round(root.querySelector('.poem').lastElementChild.getBoundingClientRect().height) };
  }, EDIT_SEL);
  console.log('\n=== COMPARE empty <p> heights (show-marks) ===');
  console.log(JSON.stringify(cmp, null, 2));

  // getClientRects der leeren <p>: Element-Box vs. tatsächliche Text-/Caret-
  // Range. Klick-Hit-Test (caretRangeFromPoint) nutzt die Range, nicht die Box.
  const rects = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const emptyP = root.querySelector('.poem').lastElementChild;
    const range = document.createRange();
    range.selectNodeContents(emptyP);
    return {
      elBox: [...emptyP.getClientRects()].map((r) => ({ x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) })),
      rangeBox: [...range.getClientRects()].map((r) => ({ x: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) })),
      brBox: emptyP.firstChild ? (() => { const r = emptyP.firstChild.getClientRects?.(); return r ? [...r].map((x) => ({ x: Math.round(x.left), w: Math.round(x.width) })) : 'no-rects'; })() : 'no-child',
      showMarksClass: root.className,
    };
  }, EDIT_SEL);
  console.log('\n=== RECTS (empty <p>) ===');
  console.log(JSON.stringify(rects, null, 2));

  // Geometrie der letzten leeren <p> im Gedicht ermitteln.
  const geo = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    const poem = root.querySelector('.poem');
    const emptyP = poem.lastElementChild;
    const rEditor = root.getBoundingClientRect();
    const rEmpty = emptyP.getBoundingClientRect();
    const rPoem = poem.getBoundingClientRect();
    return {
      emptyP: { x: Math.round(rEmpty.left), y: Math.round(rEmpty.top), w: Math.round(rEmpty.width), h: Math.round(rEmpty.height) },
      poemBottom: Math.round(rPoem.bottom),
      editorBottom: Math.round(rEditor.bottom),
      editorScrollH: root.scrollHeight,
      editorClientH: root.clientHeight,
      emptyHTML: emptyP.outerHTML,
    };
  }, EDIT_SEL);
  console.log('\n=== GEOMETRY ===');
  console.log(JSON.stringify(geo, null, 2));

  // Klick 1: direkt auf den Caret-Slot links (br-Position).
  await page.mouse.click(geo.emptyP.x + 5, geo.emptyP.y + Math.max(2, geo.emptyP.h / 2));
  await page.waitForTimeout(50);
  console.log('\n=== CLICK on empty <p> caret slot (left) ===');
  console.log(JSON.stringify(await caretInfo(page), null, 2));

  // Klick 1b: weit rechts auf der leeren Zeile (Dead-Space, kein Text/br dort).
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.click(geo.emptyP.x + geo.emptyP.w - 30, geo.emptyP.y + Math.max(2, geo.emptyP.h / 2));
  await page.waitForTimeout(50);
  console.log('\n=== CLICK on empty <p> far-right dead space ===');
  console.log(JSON.stringify(await caretInfo(page), null, 2));

  // Klick 1c: unterste Pixelzeile der leeren <p> (h=51 → zweite "Zeilenhälfte").
  await page.evaluate(() => getSelection().removeAllRanges());
  await page.mouse.click(geo.emptyP.x + 30, geo.emptyP.y + geo.emptyP.h - 3);
  await page.waitForTimeout(50);
  console.log('\n=== CLICK on empty <p> bottom pixel row ===');
  console.log(JSON.stringify(await caretInfo(page), null, 2));

  // Klick 2: in den Leerraum unter dem Gedicht (typischer "ans Ende klicken").
  if (geo.poemBottom + 20 < geo.editorBottom) {
    await page.mouse.click(geo.emptyP.x + 5, geo.poemBottom + 15);
    await page.waitForTimeout(50);
    console.log('\n=== CLICK below poem (empty space) ===');
    console.log(JSON.stringify(await caretInfo(page), null, 2));
  } else {
    console.log('\n(kein Leerraum unter dem Gedicht — Editor endet am Gedicht)');
  }

  // --- Delete-Versuche: Caret in die leere <p> setzen, dann Backspace / Enter ---
  async function setCaretInEmptyP(page) {
    await page.evaluate((sel) => {
      const root = document.querySelector(sel);
      const emptyP = root.querySelector('.poem').lastElementChild;
      const r = document.createRange();
      r.setStart(emptyP, 0);
      r.collapse(true);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      root.focus();
    }, EDIT_SEL);
  }

  function dumpHtml(page, label) {
    return page.evaluate((sel) => document.querySelector(sel).innerHTML, EDIT_SEL)
      .then((h) => console.log(`\n=== ${label} ===\n${h}`));
  }

  await setCaretInEmptyP(page);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(50);
  await dumpHtml(page, 'nach Backspace in leerer <p>');

  // Reset + Enter (Doppel-Enter-Handler soll aus dem Gedicht raus).
  await page.evaluate(({ sel, html }) => { document.querySelector(sel).innerHTML = html; }, { sel: EDIT_SEL, html: POEM_HTML });
  await setCaretInEmptyP(page);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(50);
  await dumpHtml(page, 'nach Enter in leerer <p>');

  expect(true).toBe(true);
});
