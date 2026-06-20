// Verifiziert die SortableJS-Beat-DnD der Plot-Werkstatt end-to-end gegen die echte
// App (Smoke-Layer): Board per API seeden, Beat per Drag umsortieren, persistierte
// sort_order prüfen. Deckt den Drag-Pfad ab, den der reine Card-Open-Smoke nicht testet.
const { test, expect } = require('@playwright/test');

test('plot: Beat per SortableJS-Drag umsortieren persistiert', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.__app.selectedBookId);
  const bookId = await page.evaluate(() => window.__app.selectedBookId);

  // Board seeden: 1 Akt + 3 Beats via API (im Page-Kontext, mit Session-Cookie).
  const ids = await page.evaluate(async (bookId) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const act = await post('/plot/acts', { book_id: bookId, name: 'DnD-Akt' });
    const b1 = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Beat A' });
    const b2 = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Beat B' });
    const b3 = await post('/plot/beats', { book_id: bookId, act_id: act.id, titel: 'Beat C' });
    return { actId: act.id, b1: b1.id, b2: b2.id, b3: b3.id };
  }, bookId);

  // Plot-Karte öffnen + Board laden.
  await page.evaluate(() => window.__app.togglePlotCard());
  await page.waitForSelector('.card--plot .plot-beat[data-beat-id]');
  await page.waitForFunction((n) => document.querySelectorAll('.card--plot .plot-board .plot-beat').length === n, 3);

  // Reihenfolge vor dem Drag (Board-Lesereihenfolge A,B,C).
  const before = await page.$$eval('.card--plot .plot-board .plot-beat', els => els.map(e => e.dataset.beatId));
  expect(before).toEqual([String(ids.b1), String(ids.b2), String(ids.b3)]);

  // Beat C (3.) per Drag über Beat A (1.) ziehen → erwartet C,A,B.
  const src = page.locator(`.card--plot .plot-board .plot-beat[data-beat-id="${ids.b3}"]`);
  const dst = page.locator(`.card--plot .plot-board .plot-beat[data-beat-id="${ids.b1}"]`);
  const s = await src.boundingBox();
  const d = await dst.boundingBox();
  // Am Beschreibungs-/Padding-Bereich greifen (Titel/Badges sind drag-gefiltert).
  await page.mouse.move(s.x + s.width / 2, s.y + s.height - 6);
  await page.mouse.down();
  // Mehrere Schritte > fallbackTolerance(5px), damit SortableJS den Drag startet.
  await page.mouse.move(s.x + s.width / 2, s.y + s.height - 20, { steps: 4 });
  await page.mouse.move(d.x + d.width / 2, d.y + 4, { steps: 8 });
  await page.mouse.move(d.x + d.width / 2, d.y + 2, { steps: 3 });
  await page.mouse.up();

  // Persistierte Server-Reihenfolge prüfen (sort_order pro Zelle).
  await page.waitForFunction(async (args) => {
    const data = await fetch(`/plot?book_id=${args.bookId}`).then(r => r.json());
    const inAct = data.beats.filter(b => b.act_id === args.actId).sort((a, b) => a.sort_order - b.sort_order);
    return inAct.length === 3 && inAct[0].id === args.b3;
  }, { bookId, actId: ids.actId, b3: ids.b3 }, { timeout: 10000 });

  const order = await page.evaluate(async (args) => {
    const data = await fetch(`/plot?book_id=${args.bookId}`).then(r => r.json());
    return data.beats.filter(b => b.act_id === args.actId)
      .sort((a, b) => a.sort_order - b.sort_order).map(b => b.id);
  }, { bookId, actId: ids.actId });
  expect(order).toEqual([ids.b3, ids.b1, ids.b2]);
  expect(errors).toEqual([]);
});
