// Plot-Werkstatt gegen die echte App: „Beat verschieben ohne Drag" (Beat-Edit →
// nach oben/unten + Akt-Combobox) und die Ein-Klick-Aktion eines Konsistenz-
// Befunds. Beide müssen serverseitig landen — geprüft über GET /plot, nicht nur
// am DOM. Der Drag-Pfad selbst liegt in plot-dnd.spec.js; hier geht es um die
// Tastatur-/Touch-Alternative, die dieselbe _dropBeat-Mechanik nutzt.
const { test, expect } = require('../e2e/_helpers/fixtures');

const BOARD = '#partial-plot-board-flat';

// Alle Specs teilen die Smoke-DB: die hier angelegten Akte (Beats kaskadieren)
// danach wieder entfernen, sonst zählt plot-dnd.spec.js fremde Beats mit.
let seededActs = [];
test.afterEach(async ({ page }) => {
  const acts = seededActs;
  seededActs = [];
  await page.evaluate(async (ids) => {
    for (const id of ids) await fetch(`/plot/acts/${id}`, { method: 'DELETE' });
  }, acts).catch(() => {});
});

async function seed(page) {
  await page.goto('/');
  await page.waitForFunction(() => window.__app && window.Alpine.store('nav').selectedBookId);
  const bookId = await page.evaluate(() => window.Alpine.store('nav').selectedBookId);
  const ids = await page.evaluate(async (bookId) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());
    const a1 = await post('/plot/acts', { book_id: bookId, name: 'Move-Akt 1' });
    const a2 = await post('/plot/acts', { book_id: bookId, name: 'Move-Akt 2' });
    const b1 = await post('/plot/beats', { book_id: bookId, act_id: a1.id, titel: 'Move A' });
    const b2 = await post('/plot/beats', { book_id: bookId, act_id: a1.id, titel: 'Move B' });
    const b3 = await post('/plot/beats', { book_id: bookId, act_id: a1.id, titel: 'Move C' });
    return { a1: a1.id, a2: a2.id, b1: b1.id, b2: b2.id, b3: b3.id };
  }, bookId);
  seededActs = [ids.a1, ids.a2];
  await page.evaluate(() => window.__app.togglePlotCard());
  await page.waitForSelector(`${BOARD} .plot-beat[data-beat-id="${ids.b3}"]`);
  return { bookId, ids };
}

const serverOrder = (page, bookId, actId) => page.evaluate(async (a) => {
  const data = await fetch(`/plot?book_id=${a.bookId}`).then(r => r.json());
  return data.beats.filter(b => b.act_id === a.actId)
    .sort((x, y) => x.sort_order - y.sort_order).map(b => b.id);
}, { bookId, actId });

test('plot: Beat ohne Drag verschieben — oben/unten + Akt-Wechsel persistiert', async ({ page }) => {
  const { bookId, ids } = await seed(page);
  const beat = (id) => page.locator(`${BOARD} .plot-beat[data-beat-id="${id}"]`);

  // Titel ist ein echter Button → öffnet den Beat-Edit.
  await beat(ids.b1).locator('button.plot-beat-title').click();
  const down = beat(ids.b1).locator('[data-beat-move="down"]');
  const up = beat(ids.b1).locator('[data-beat-move="up"]');
  await expect(down).toBeVisible();
  await expect(up).toBeDisabled(); // erster Beat der Zelle

  await down.click();
  await expect.poll(() => serverOrder(page, bookId, ids.a1)).toEqual([ids.b2, ids.b1, ids.b3]);
  // Der Edit bleibt offen und der Fokus folgt dem Knopf.
  await expect(beat(ids.b1).locator('[data-beat-move="down"]')).toBeFocused();

  // Akt-Combobox: in Akt 2 verschieben.
  await beat(ids.b1).locator('.plot-beat-move-act .combobox-trigger').click();
  await page.locator('.plot-beat-move-act .combobox-option', { hasText: 'Move-Akt 2' }).first().click();
  await expect.poll(() => serverOrder(page, bookId, ids.a2)).toEqual([ids.b1]);
  await expect.poll(() => serverOrder(page, bookId, ids.a1)).toEqual([ids.b2, ids.b3]);
  await expect(page.locator(`${BOARD} .plot-column`).filter({ hasText: 'Move-Akt 2' })
    .locator(`.plot-beat[data-beat-id="${ids.b1}"]`)).toHaveCount(1);
});

test('plot: Befund-Aktion „verwerfen" läuft über den Beat-Pfad und blendet sich aus', async ({ page }) => {
  const { bookId, ids } = await seed(page);
  // Einen Prüflauf mit dem Job-Vertrag (typ/aktion/seit_letztem_lauf) ins Panel
  // legen — der KI-Lauf selbst ist hier nicht Gegenstand.
  await page.evaluate((ids) => {
    const card = window.Alpine.$data(document.querySelector('.card--plot'));
    card.consistencyResult = {
      fazit: 'Test',
      erledigt: ['Alter Befund'],
      konflikte: [{
        beat: 'Move C', beat_id: ids.b3, schwere: 'stark', problem: 'Doppelt',
        vorschlag: 'Streichen', typ: 'logik', seit_letztem_lauf: 'neu',
        aktion: { art: 'verwerfen' },
      }],
    };
  }, ids);
  const row = page.locator('.plot-konflikt').first();
  await expect(row.locator('.plot-konflikt-typ')).toBeVisible();
  // stark = zweitschwerster Befund → rote Plakette (kritisch-Ton), nicht grün.
  await expect(row.locator('.severity-tag')).toHaveClass(/severity-tag--kritisch/);
  const action = row.locator('.plot-konflikt-action');
  await expect(action).toBeVisible();
  await action.click();
  await expect.poll(() => page.evaluate(async (a) => {
    const data = await fetch(`/plot?book_id=${a.bookId}`).then(r => r.json());
    return !!data.beats.find(b => b.id === a.id)?.verworfen;
  }, { bookId, id: ids.b3 })).toBe(true);
  await expect(action).toBeHidden();
  await expect(page.locator('.plot-konflikt-erledigt')).toBeVisible();
});
