// E2E-Smoke der Tagebuch-Rückblick-Karte.
//
// Mountet `tagebuchRueckblickCard` mit Mock-__app (datierte + nicht-datierte
// Seiten) gegen ein Minimal-Root. Prüft: Zeitraum-Optionen aus Eintrags-Daten,
// Default-Zeitraum, Render des Struktur-Ergebnisses, Tag-Navigation (selectPage),
// Leerzustand. Job-Lauf wird nicht durchgespielt (fetch ist gestubbt); das
// Struktur-Ergebnis wird über Alpine.$data gesetzt (simuliert onDone).

const { test, expect } = require('./_helpers/fixtures');

test.beforeEach(async ({ page }) => {
  await page.goto('http://localhost:8765/tests/fixtures/tagebuch-rueckblick-harness.html', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
});

test('Zeitraum-Optionen nur aus datierten Einträgen (Monate + Jahre)', async ({ page }) => {
  const values = await page.locator('[data-test="zeitraum"] option').evaluateAll(
    opts => opts.map(o => o.value).filter(Boolean),
  );
  // Monate: 2024-04, 2024-03, 2023-12 ; Jahre: 2024, 2023. 'Über mich' ignoriert.
  expect(values).toContain('2024-03');
  expect(values).toContain('2024-04');
  expect(values).toContain('2023-12');
  expect(values).toContain('2024');
  expect(values).toContain('2023');
  // Kein Eintrag für die nicht-datierte Seite.
  expect(values.some(v => v.includes('Über'))).toBe(false);
});

test('Default-Zeitraum ist gesetzt (jüngster Monat), Run-Button aktiv', async ({ page }) => {
  const z = await page.locator('[data-test="zeitraum"]').inputValue();
  expect(z).toBe('2024-04');
  await expect(page.locator('[data-test="run"]')).toBeEnabled();
});

test('Struktur-Ergebnis rendert Themen + bemerkenswerte Tage; Leerzustand aus', async ({ page }) => {
  await page.evaluate(() => {
    const data = window.Alpine.$data(document.querySelector('#root'));
    data.rueckblickResult = {
      themen: [{ label: 'Arbeit', haeufigkeit: 3, belege: ['2024-03-04'] }, { label: 'Familie', haeufigkeit: 1, belege: ['2024-03-15'] }],
      personen: [{ name: 'Anna', haeufigkeit: 2 }],
      orte: [{ name: 'Zürich', haeufigkeit: 1 }],
      bemerkenswerteTage: [{ datum: '2024-03-15', begruendung: 'großer Tag' }],
      zusammenfassung: 'Erster Absatz.\n\nZweiter Absatz.',
    };
    data.rueckblickEmpty = false;
  });

  await expect(page.locator('[data-test="result"]')).toBeVisible();
  await expect(page.locator('[data-test="empty"]')).not.toBeVisible();
  // Zwei Themen-Badges.
  await expect(page.locator('[data-test="themen"] .rb-theme')).toHaveCount(2);
  await expect(page.locator('[data-test="themen"] .rb-theme').first()).toContainText('Arbeit');
  // Zusammenfassung in zwei Absätze gesplittet.
  await expect(page.locator('[data-test="summary"] p')).toHaveCount(2);
  // Bemerkenswerter Tag.
  await expect(page.locator('[data-test="tag-2024-03-15"]')).toHaveText('2024-03-15');
});

test('Klick auf bemerkenswerten Tag ruft selectPage mit der Tagebuch-Seite', async ({ page }) => {
  await page.evaluate(() => {
    const data = window.Alpine.$data(document.querySelector('#root'));
    data.rueckblickResult = {
      themen: [], personen: [], orte: [],
      bemerkenswerteTage: [{ datum: '2024-03-04', begruendung: 'Start' }],
      zusammenfassung: 'Text.',
    };
  });
  await page.locator('[data-test="tag-2024-03-04"]').click();
  const selected = await page.evaluate(() => window.__selectedTag);
  expect(selected).toBe('2024-03-04');
});

test('Klick auf Thema öffnet Belege-Popover; Klick auf Beleg navigiert + schliesst', async ({ page }) => {
  await page.evaluate(() => {
    const data = window.Alpine.$data(document.querySelector('#root'));
    data.rueckblickResult = {
      themen: [{ label: 'Arbeit', haeufigkeit: 2, belege: ['2024-03-15', '2024-03-04'] }],
      personen: [], orte: [], bemerkenswerteTage: [], zusammenfassung: 'Text.',
    };
  });
  await page.locator('[data-test="theme-Arbeit"]').click();
  await expect(page.locator('[data-test="popover"]')).toBeVisible();
  // Popover richtet sich am Anker-Element aus (unter dem Badge, linke Kanten nah,
  // vollständig im Viewport) — nicht an Klick-Koordinaten.
  const anchorBox = await page.locator('[data-test="theme-Arbeit"]').boundingBox();
  const popBox = await page.locator('[data-test="popover"]').boundingBox();
  expect(popBox.y).toBeGreaterThanOrEqual(anchorBox.y + anchorBox.height - 1);
  expect(Math.abs(popBox.x - anchorBox.x)).toBeLessThan(4);
  expect(popBox.x).toBeGreaterThanOrEqual(0);
  expect(popBox.x + popBox.width).toBeLessThanOrEqual(await page.evaluate(() => window.innerWidth));
  // Belege dedupliziert + aufsteigend sortiert → erstes Item ist 2024-03-04.
  await expect(page.locator('[data-test="beleg-2024-03-04"]')).toBeVisible();
  await page.locator('[data-test="beleg-2024-03-15"]').click();
  expect(await page.evaluate(() => window.__selectedTag)).toBe('2024-03-15');
  await expect(page.locator('[data-test="popover"]')).not.toBeVisible();
});

test('History-Suche filtert nach Inhalt der gespeicherten Rückblicke', async ({ page }) => {
  await expect(page.locator('[data-test="history"] .history-item')).toHaveCount(2);
  await page.locator('[data-test="history-search"]').fill('April');
  await expect(page.locator('[data-test="history"] .history-item')).toHaveCount(1);
  await expect(page.locator('[data-test="hist-11"]')).toBeVisible();
  await page.locator('[data-test="history-search"]').fill('xyz-nope');
  await expect(page.locator('[data-test="history"] .history-item')).toHaveCount(0);
});

test('History: frühere Rückblicke werden beim Öffnen geladen + gelistet', async ({ page }) => {
  await expect(page.locator('[data-test="history"]')).toBeVisible();
  await expect(page.locator('[data-test="history"] .history-item')).toHaveCount(2);
  await expect(page.locator('[data-test="hist-11"]')).toContainText('April');
});

test('History: Klick auf Eintrag lädt den gespeicherten Rückblick (kein Job)', async ({ page }) => {
  await page.locator('[data-test="hist-12"]').click();
  await expect(page.locator('[data-test="result"]')).toBeVisible();
  await expect(page.locator('[data-test="summary"]')).toContainText('März-Rückblick.');
  // Zeitraum übernommen.
  expect(await page.locator('[data-test="zeitraum"]').inputValue()).toBe('2024-03');
});

test('History: Eintrag löschen entfernt ihn aus der Liste', async ({ page }) => {
  await expect(page.locator('[data-test="history"] .history-item')).toHaveCount(2);
  await page.locator('[data-test="hist-del-11"]').click();
  await expect(page.locator('[data-test="history"] .history-item')).toHaveCount(1);
  await expect(page.locator('[data-test="hist-11"]')).toHaveCount(0);
});

test('Leerzustand sichtbar, wenn rueckblickEmpty', async ({ page }) => {
  await page.evaluate(() => {
    const data = window.Alpine.$data(document.querySelector('#root'));
    data.rueckblickResult = null;
    data.rueckblickEmpty = true;
  });
  await expect(page.locator('[data-test="empty"]')).toBeVisible();
  await expect(page.locator('[data-test="result"]')).not.toBeVisible();
});
