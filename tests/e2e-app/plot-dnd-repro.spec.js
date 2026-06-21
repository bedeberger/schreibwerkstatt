// TEMP: instrument ONE cross-act drag in the delete→recreate→loadBoard scenario.
const { test } = require('@playwright/test');

test('plot: instrument failing cross-act', async ({ page }) => {
  const logs = [];
  page.on('console', m => { const t = m.text(); if (t.startsWith('SORT:')) logs.push(t); });
  page.on('pageerror', e => logs.push('ERR ' + String(e)));
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.__app.selectedBookId);
  const bookId = await page.evaluate(() => window.__app.selectedBookId);

  await page.evaluate(() => window.__app.togglePlotCard());
  await page.waitForTimeout(200);

  // delete→recreate→loadBoard (the 0/5 scenario)
  const ids = await page.evaluate(async (bookId) => {
    const board = await fetch(`/plot?book_id=${bookId}`).then(r => r.json());
    for (const a of board.acts) await fetch(`/plot/acts/${a.id}`, { method: 'DELETE' });
    const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
    const a1 = await post('/plot/acts', { book_id: bookId, name: 'Akt 1' });
    const a2 = await post('/plot/acts', { book_id: bookId, name: 'Akt 2' });
    const b1 = await post('/plot/beats', { book_id: bookId, act_id: a1.id, titel: 'Beat A' });
    const b3 = await post('/plot/beats', { book_id: bookId, act_id: a2.id, titel: 'Beat C' });
    return { a1: a1.id, a2: a2.id, b1: b1.id, b3: b3.id };
  }, bookId);
  await page.evaluate(() => window.Alpine.$data(document.querySelector('.card--plot')).loadBoard());
  await page.waitForFunction((n) => document.querySelectorAll('.card--plot .plot-board .plot-beat').length === n, 2);
  await page.waitForTimeout(400);

  // Instrument _onDragOver: log act-id of every container it evaluates + insertions.
  await page.evaluate((b1) => {
    window.__dragItem = document.querySelector(`.plot-board .plot-beat[data-beat-id="${b1}"]`);
    window.__over = [];
    const S = window.Sortable;
    const orig = S.prototype._onDragOver;
    S.prototype._onDragOver = function (evt) {
      const a = this.el?.dataset?.actId;
      const elNull = !this.el;
      const before = window.__dragItem?.parentElement;
      const r = orig.call(this, evt);
      const after = window.__dragItem?.parentElement;
      window.__over.push({ a, elNull, inserted: before !== after, toAct: after?.dataset?.actId });
      return r;
    };
    // Which visible board containers have a live Sortable bound?
    const live = [...document.querySelectorAll('.plot-board [data-plot-cell]')].map(el => {
      const card = window.Alpine.$data(document.querySelector('.card--plot'));
      const inst = (card._sortables || []).find(s => s.el === el);
      return { act: el.dataset.actId, hasLiveInstance: !!inst };
    });
    console.log('SORT: liveBindings ' + JSON.stringify(live));
    console.log('SORT: totalSortables ' + (window.Alpine.$data(document.querySelector('.card--plot'))._sortables || []).length);
  }, ids.b1);

  const src = page.locator(`.card--plot .plot-board .plot-beat[data-beat-id="${ids.b1}"]`);
  const dst = page.locator(`.card--plot .plot-board .plot-beat[data-beat-id="${ids.b3}"]`);
  const s = await src.boundingBox();
  const d = await dst.boundingBox();
  await page.mouse.move(s.x + 8, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + 12, s.y + s.height / 2 + 8, { steps: 3 });
  await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2, { steps: 2 });
  const overSummary = await page.evaluate(() => {
    const counts = {}; let inserted = [];
    for (const o of window.__over) { const k = o.a + (o.elNull ? '(null)' : ''); counts[k] = (counts[k]||0)+1; if (o.inserted) inserted.push(o.toAct); }
    return { counts, inserted, last5: window.__over.slice(-5) };
  });
  console.log('SORT: overSummary ' + JSON.stringify(overSummary));
  await page.mouse.up();
  await page.waitForTimeout(400);
  const final = await page.evaluate(async (args) => {
    const data = await fetch(`/plot?book_id=${args.bookId}`).then(r => r.json());
    return data.beats.find(b => b.id === args.b1)?.act_id;
  }, { bookId, b1: ids.b1 });
  console.log('SORT: final b1 act=' + final + ' expected=' + ids.a2);
  console.log('=== LOGS ===\n' + logs.join('\n'));
});
