// Werkbank-Matrix: die Raster-GEOMETRIE gegen die echte App.
//
// Warum hier und nicht als Fixture-Harness: jede Aussage dieses Specs haengt an
// der CSS-Hoehenkette und der Malreihenfolge des echten Template-Baums —
// `max-height` am Scroll-Container (ohne den klebt `position: sticky; top: 0`
// an NICHTS, weil der Container dann nie vertikal scrollt), die z-index-
// Staffelung der Ecke gegen die Akt-Koepfe, und der Deckel der Zeilenkopf-
// Spalte, den `max-width` an der ZELLE bei `table-layout: auto` nicht einloest.
// Ein Harness mit Minimal-CSS bliebe gruen, waehrend das Raster abdriftet.
//
// Beide Sticky-Aussagen werden per `elementFromPoint` geprueft, nicht per
// Rechteck-Vergleich: ob die Ecke ueber dem Akt-Kopf LIEGT, ist eine Frage der
// Malreihenfolge, und nur der Hit-Test beantwortet sie. Mutationsprobe: setzt
// man die Ecke zurueck auf denselben z-index wie die Akt-Koepfe, faellt genau
// dieser Test.
const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

// Genug Spalten, dass das Raster bei 900px Viewport sicher horizontal
// ueberlaeuft (Zeilenkopf 12rem + 8 × 9rem = 1344px), und genug Zeilen fuer den
// vertikalen Ueberlauf gegen `max-height: 70vh` bei 420px Hoehe (= 294px).
const ACT_COUNT = 8;
const FIG_COUNT = 14;
// Ein Name ohne Leerzeichen: bricht nur, wenn `overflow-wrap: anywhere` greift —
// sonst sprengt er jeden Deckel.
const LONG_NAME = 'Donaudampfschifffahrtsgesellschaftskapitaenswitwe' + 'x'.repeat(40);
const ROWHEAD_MAX_PX = 18 * 16; // --werkbank-rowhead-max: 18rem

let bookId = null;
let createdActIds = [];
let originalFiguren = null;

// Der Lauf teilt EINEN Seed-Stand (playwright.app.config.js: `workers: 1`).
// Was dieses Spec anlegt, raeumt es darum weg: die Akte einzeln (CASCADE nimmt
// ihre Beats mit), die Figuren durch Zuruecklegen des urspruenglichen Katalogs —
// `PUT /figures/:book_id` ist ein Full-Replace, ein leeres Array waere hier also
// kein Cleanup, sondern ein Loeschen fremder Daten.
test.afterAll(async ({ browser }) => {
  if (!bookId) return;
  const page = await browser.newPage();
  try {
    await bootApp(page);
    await page.evaluate(async (args) => {
      if (args.figuren) {
        await fetch(`/figures/${args.bookId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ figuren: args.figuren }),
        });
      }
      await Promise.all(args.actIds.map(id => fetch(`/plot/acts/${id}`, { method: 'DELETE' })));
    }, { bookId, figuren: originalFiguren, actIds: createdActIds });
  } finally {
    await page.close();
  }
});

test('werkbank: Kopfzeile klebt, Ecke liegt ueber den Akt-Koepfen, Zeilenkopf ist gedeckelt', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.setViewportSize({ width: 900, height: 420 });
  await bootApp(page);
  bookId = await selectSeededBook(page);

  // Raster seeden: Akte = Spalten, Figuren = Zeilen. Beats braucht die Geometrie
  // nicht — eine leere Zelle ist im Raster eine vollwertige Zelle.
  const seeded = await page.evaluate(async (args) => {
    const post = (url, body) => fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then(r => r.json());

    const before = await fetch(`/figures/${args.bookId}`).then(r => r.json());
    const bestand = (before && before.figuren) || [];

    const neu = [];
    for (let i = 0; i < args.figCount; i++) {
      neu.push({ id: `wb-geo-${i}`, name: i === 0 ? args.longName : `WB-Figur ${i}` });
    }
    await fetch(`/figures/${args.bookId}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figuren: bestand.concat(neu) }),
    });

    const actIds = [];
    for (let i = 0; i < args.actCount; i++) {
      const a = await post('/plot/acts', { book_id: args.bookId, name: `WB-Akt ${i + 1}` });
      actIds.push(a.id);
    }
    return { actIds, bestand };
  }, { bookId, actCount: ACT_COUNT, figCount: FIG_COUNT, longName: LONG_NAME });

  createdActIds = seeded.actIds;
  originalFiguren = seeded.bestand;

  await page.evaluate(() => window.__app.toggleWerkbankCard());
  await page.waitForSelector('.card--werkbank .werkbank-table tbody tr');
  // `>=`, nicht `===`: das Seed-Buch kann aus frueheren Specs desselben Laufs
  // schon eigene Akte tragen — hier zaehlt nur, dass MEINE Spalten da sind.
  await page.waitForFunction(
    (n) => document.querySelectorAll('.card--werkbank .werkbank-table thead th').length >= n,
    ACT_COUNT + 1,
  );

  // ── 1. Der Container scrollt ueberhaupt — in BEIDE Richtungen ──────────────
  // Ohne diesen Deckel haette `top: 0` keinen Scrollport, und die Kopfzeile
  // waere reine Dekoration.
  const overflow = await page.$eval('.card--werkbank .werkbank-scroll', (el) => ({
    vertical: el.scrollHeight - el.clientHeight,
    horizontal: el.scrollWidth - el.clientWidth,
  }));
  expect(overflow.vertical).toBeGreaterThan(0);
  expect(overflow.horizontal).toBeGreaterThan(0);

  // In beide Richtungen scrollen und das Raster ins Bild holen. Getrennt vom
  // Messen: `elementFromPoint` hittestet sonst gegen den Layout-Stand VOR dem
  // Scroll, waehrend `getBoundingClientRect` schon den neuen liefert — der
  // Treffer waere dann `<html>`, und der Test misslaenge aus dem falschen Grund.
  await page.evaluate(() => {
    const box = document.querySelector('.card--werkbank .werkbank-scroll');
    box.scrollIntoView({ block: 'center' });
    box.scrollTop = Math.floor((box.scrollHeight - box.clientHeight) / 2);
    box.scrollLeft = Math.min(300, box.scrollWidth - box.clientWidth);
  });
  await page.waitForTimeout(250);

  const geo = await page.evaluate(() => {
    const box = document.querySelector('.card--werkbank .werkbank-scroll');
    const r = box.getBoundingClientRect();
    const corner = document.querySelector('.card--werkbank .werkbank-table thead th.werkbank-rowhead');
    const cr = corner.getBoundingClientRect();
    const bodyHead = document.querySelector('.card--werkbank .werkbank-table tbody th.werkbank-rowhead');
    const topHit = document.elementFromPoint(r.left + r.width * 0.6, r.top + 4);
    const cornerHit = document.elementFromPoint(cr.left + cr.width / 2, cr.top + cr.height / 2);
    return {
      stickyTopDelta: document.querySelector('.card--werkbank .werkbank-table thead th')
        .getBoundingClientRect().top - r.top,
      topHitInThead: !!(topHit && topHit.closest('thead')),
      cornerIsOnTop: !!(cornerHit && (cornerHit === corner || corner.contains(cornerHit))),
      cornerZ: Number(getComputedStyle(corner).zIndex),
      actZ: Number(getComputedStyle(
        document.querySelector('.card--werkbank .werkbank-table thead th:not(.werkbank-rowhead)'),
      ).zIndex),
      rowheadDrift: Math.abs(bodyHead.getBoundingClientRect().left - r.left),
      scrolledLeft: box.scrollLeft,
    };
  });

  // ── 2. Kopfzeile klebt beim Runterscrollen ─────────────────────────────────
  expect(geo.stickyTopDelta).toBeLessThan(2);
  expect(geo.topHitInThead).toBe(true);

  // ── 3. Die Ecke liegt ueber den Akt-Koepfen, die unter ihr durchscrollen ───
  expect(geo.scrolledLeft).toBeGreaterThan(0);
  expect(geo.cornerIsOnTop).toBe(true);
  expect(geo.cornerZ).toBeGreaterThan(geo.actZ);

  // ── 4. Der Zeilenkopf klebt links, waehrend die Akte weiterscrollen ────────
  expect(geo.rowheadDrift).toBeLessThan(2);

  // ── 5. Die Kante gehoert der ZELLE, nicht der Tabelle ──────────────────────
  // Bei `border-collapse: collapse` wanderte die rechte Kante der klebenden
  // Spalte beim H-Scroll mit dem Inhalt weg.
  const borders = await page.evaluate(() => {
    const table = document.querySelector('.card--werkbank .werkbank-table');
    const th = document.querySelector('.card--werkbank .werkbank-table tbody th.werkbank-rowhead');
    return {
      collapse: getComputedStyle(table).borderCollapse,
      rightWidth: parseFloat(getComputedStyle(th).borderRightWidth),
    };
  });
  expect(borders.collapse).toBe('separate');
  expect(borders.rightWidth).toBeGreaterThan(0);

  // ── 6. Die Zeilenkopf-Spalte bleibt schmal, auch bei einem Namen ohne Fuge ──
  // Der urspruengliche Deckel sass als `max-width` an der ZELLE und war damit
  // bei `table-layout: auto` nur ein Vorschlag. Jetzt tragen ihn die Kinder,
  // und `overflow-wrap: anywhere` sorgt dafuer, dass ein 88-Zeichen-Name ohne
  // Leerzeichen ueberhaupt brechen KANN — ohne das zoege er die Spalte auf
  // seine volle Laufweite, und die Akte verloeren ihren Platz.
  const capped = await page.evaluate(() => {
    const figur = document.querySelector('.card--werkbank .werkbank-table tbody .werkbank-figur');
    return {
      figurWidth: figur.getBoundingClientRect().width,
      thWidth: figur.closest('th').getBoundingClientRect().width,
    };
  });
  expect(capped.figurWidth).toBeLessThanOrEqual(ROWHEAD_MAX_PX + 1);
  // Die Zelle darf um ihr Padding breiter sein als der Deckel, nicht mehr.
  expect(capped.thWidth).toBeLessThan(ROWHEAD_MAX_PX + 48);

  expect(errors).toEqual([]);
});
