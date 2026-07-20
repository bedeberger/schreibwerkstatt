// Motiv-Werkstatt — Interaktions-Smoke gegen die echte App (playwright.app.config.js).
// Deckt die Schreibpfade ab, die der reine Karten-Öffnen-Smoke NICHT prüft:
// Thema/Motiv anlegen, Motiv auswählen, Beziehung setzen, Graph-Aufbau — alles am
// echten Card-/Root-Scope gegen /motifs + Wegwerf-DB, mit Konsolenfehler-Guard.

const { test, expect } = require('@playwright/test');
const { attachConsoleGuard } = require('../e2e/_helpers/console-guard');

async function bootApp(page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__app && Array.isArray(window.Alpine.store('nav').books) && window.Alpine.store('nav').books.length > 0,
    null, { timeout: 30000 },
  );
}
async function selectSeededBook(page) {
  const bookId = await page.evaluate(() => window.Alpine.store('nav').books[0].id);
  await page.evaluate((id) => { location.hash = '#book/' + id; }, bookId);
  await page.waitForFunction(
    (id) => String(window.Alpine.store('nav').selectedBookId) === String(id)
            && Array.isArray(window.Alpine.store('nav').pages) && window.Alpine.store('nav').pages.length > 0,
    bookId, { timeout: 20000 },
  );
  return bookId;
}

test.describe.configure({ mode: 'serial' });

test('Motiv-Werkstatt: anlegen, verknüpfen, Graph — ohne Konsolenfehler', async ({ page }) => {
  const guard = attachConsoleGuard(page);
  await bootApp(page);
  await selectSeededBook(page);

  // Karte öffnen + Sub-Mount abwarten.
  await page.evaluate(() => window.__app.toggleMotivCard());
  await page.waitForFunction(() => !!document.querySelector('.card--motiv'), null, { timeout: 10000 });
  await page.waitForFunction(
    () => { const c = window.Alpine.$data(document.querySelector('.card--motiv')); return c && !c.loading; },
    null, { timeout: 10000 },
  );

  // Thema + zwei Motive anlegen, erstes selektieren, Beziehung setzen — alles am
  // echten Scope gegen das Backend.
  const result = await page.evaluate(async () => {
    const card = window.Alpine.$data(document.querySelector('.card--motiv'));

    card.newThemeName = 'Wasser & Schuld';
    await card.addTheme();

    card.newMotifName = 'Regen';
    await card.addMotif();               // selektiert das neue Motiv
    const firstId = card.selectedMotifId;

    card.newMotifName = 'Spiegel';
    await card.addMotif();
    const secondId = card.selectedMotifId;

    // Beziehung Regen → Spiegel.
    await card.selectMotif(firstId);
    card.newRelationTargetId = String(secondId);
    card.newRelationTyp = 'kontrastiert';
    await card.addRelation();

    return {
      themes: card.themes.length,
      motifs: card.motifs.length,
      relations: card.relations.length,
      relTyp: card.relations[0]?.typ,
      semanticActiveIsBool: typeof card.semanticActive() === 'boolean',
    };
  });

  expect(result.themes, 'ein Thema angelegt').toBe(1);
  expect(result.motifs, 'zwei Motive angelegt').toBe(2);
  expect(result.relations, 'eine Beziehung angelegt').toBe(1);
  expect(result.relTyp).toBe('kontrastiert');
  expect(result.semanticActiveIsBool, 'semanticActive() liefert Boolean (Task 1)').toBe(true);

  // Graph rendert (vis-network lazy) — Netzwerk-Instanz + Motiv-Knoten vorhanden.
  await page.waitForFunction(
    () => { const c = window.Alpine.$data(document.querySelector('.card--motiv')); return !!c._motivNetwork; },
    null, { timeout: 10000 },
  );

  await page.waitForTimeout(300);
  guard.assertClean('Motiv-Werkstatt Interaktion');
});
