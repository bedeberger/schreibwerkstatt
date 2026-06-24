const { test, expect } = require('./_helpers/fixtures');

// Verifiziert, dass die Share-Reader-Kommentare die GETEILTE Karten-Optik
// (components/comment-rail.css, `.comment-rail__*`) tatsächlich rendern und die
// --cr-*-Theming-Brücke auf das Share-Token-Universum auflöst. Treibt das echte
// share-reader.js gegen einen Fetch-Stub (Mock-Threads), prüft also Markup +
// CSS-Bridge in einem Zug. Der Console-Guard (fixtures.js) macht den Test rot,
// falls der Bootstrap (Optionen-Menü, Composer, Layout …) einen Fehler wirft.
const URL = 'http://localhost:8765/tests/fixtures/share-reader-harness.html';

// Share-Light-Palette (share.css :root): Surface #fff, Akzent #1d4b73.
const SURFACE_LIGHT = 'rgb(255, 255, 255)';
const SURFACE_DARK = 'rgb(42, 39, 34)';   // #2a2722 (html[data-theme=dark])
const ACCENT_LIGHT = 'rgb(29, 75, 115)';  // #1d4b73

test('share-reader: verankerter Thread rendert als geteilte comment-rail-Karte', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // share-reader.js fetcht async und rendert dann — auf die Karte warten.
  const thread = page.locator('.share-comments__list .comment-rail__thread');
  await expect(thread).toHaveCount(1);

  // Quote-Snippet ohne literale Anführungszeichen (= SPA-Optik).
  const quote = thread.locator('.comment-rail__quote');
  await expect(quote).toHaveText('anchored passage');

  // Avatar-Pip mit Initialen.
  const avatar = thread.locator('.comment-rail__avatar').first();
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveText('LM'); // Lena Muster

  // Brücke aufgelöst: Karte hat Share-Surface-Hintergrund + Elevation (kein
  // transparenter/unstyled Block, was ein gebrochenes --cr-Mapping wäre).
  const bg = await thread.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(SURFACE_LIGHT);
  const shadow = await thread.evaluate(el => getComputedStyle(el).boxShadow);
  expect(shadow).not.toBe('none');
});

test('share-reader: Autor-Antwort bekommt den Akzent-Balken (--cr-accent)', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  const reply = page.locator('.share-comments__list .comment-rail__comment--reply.comment-rail__comment--author');
  await expect(reply).toHaveCount(1);
  const borderColor = await reply.evaluate(el => getComputedStyle(el).borderLeftColor);
  expect(borderColor).toBe(ACCENT_LIGHT);
});

test('share-reader: allgemeine Kommentare erben die Brücke (body-weit)', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });

  // Nicht-verankerter Thread landet in der getrennten .share-general-Sektion —
  // die Brücke auf body.share-page muss auch dort greifen.
  const general = page.locator('.share-general__list .comment-rail__thread');
  await expect(general).toHaveCount(1);
  const bg = await general.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(SURFACE_LIGHT);
});

test('share-reader: Dark-Mode flippt die Karten-Surface über die Brücke', async ({ page }) => {
  await page.goto(URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.share-comments__list .comment-rail__thread')).toHaveCount(1);

  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  const bg = await page.locator('.share-comments__list .comment-rail__thread')
    .evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).toBe(SURFACE_DARK);
});
