// Combobox-Dropdown haengt am Trigger — auch in Karten mit Query-Container.
//
// Warum gegen die ECHTE App und nicht als Fixture-Harness: die Invariante ist
// eine Aussage ueber den CONTAINING BLOCK, und den bestimmt das volle CSS der
// Shell. Das Dropdown ist `position: fixed` und wird von x-anchor (Floating UI)
// am Trigger verankert. Floating UI haelt jeden Vorfahren mit
// `container-type != normal` fuer einen Containing Block und rechnet die
// Koordinaten relativ dazu — der Browser tut das NICHT. Sitzt der
// `container-type` also auf einem Vorfahren der Combobox, klappt die Liste um
// genau den Offset dieses Vorfahren daneben auf (links oben statt am Trigger),
// waehrend jeder Zustand korrekt „offen" sagt. Ein Harness ohne die echte
// Karten-Geometrie saehe davon nichts.
//
// Konsequenz fuer neuen Code: `container-type` gehoert auf einen Wrapper, in dem
// kein Popover aufgeht — nicht auf die Karten-Wurzel.
const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Karten mit Query-Container, die eine Combobox/einen Entity-Picker tragen.
// Waechst eine dazu, gehoert sie hierher.
const CASES = [
  {
    name: 'ideen-board',
    card: '#ideen-board-card',
    wrap: '.ideen-board-add-lane',
    open: async (page, bookId) => page.evaluate((id) => { location.hash = `#book/${id}/ideen`; }, bookId),
  },
  {
    name: 'admin-logs',
    card: '.card--admin-logs',
    wrap: '.admin-logs-filter .combobox-wrap',
    // Der Toggle laedt das Partial nach (feature-registry) — ein blosses Setzen
    // des Flags liesse die Karte ungemountet.
    open: async (page) => page.evaluate(() => window.__app.toggleAdminLogsCard()),
  },
];

for (const c of CASES) {
  test(`combobox-anchoring: ${c.name} — Liste klappt am Trigger auf`, async ({ page }) => {
    await bootApp(page);
    const bookId = await selectSeededBook(page);
    await c.open(page, bookId);

    const card = page.locator(c.card);
    await expect(card).toBeVisible();
    // Die Karten-Einblendung (`cardFadeIn`) laeuft mit einem Transform — waehrend
    // sie laeuft, IST die Karte ein Containing Block und die Messung waere
    // bedeutungslos. Erst messen, wenn sie steht.
    await expect.poll(() => card.evaluate(el => getComputedStyle(el).transform))
      .toBe('none');

    const wrap = card.locator(c.wrap).first();
    const trigger = wrap.locator('.combobox-trigger');
    await trigger.click();
    const dropdown = wrap.locator('.combobox-dropdown');
    await expect(dropdown).toBeVisible();

    const [t, d] = await Promise.all([trigger.boundingBox(), dropdown.boundingBox()]);
    // Linke Kanten buendig, Liste direkt unter dem Trigger. Toleranz deckt das
    // Sub-Pixel-Runden von Floating UI ab, nicht einen Karten-Offset (dreistellig).
    expect(Math.abs(d.x - t.x), `Dropdown-x ${d.x} vs. Trigger-x ${t.x}`).toBeLessThan(2);
    expect(Math.abs(d.y - (t.y + t.height)), `Dropdown-y ${d.y} vs. Trigger-Unterkante ${t.y + t.height}`).toBeLessThan(2);
  });
}
