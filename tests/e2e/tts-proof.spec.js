// E2E: TTS / Proof-Listening im Notebook-Editor (Read-Modus). Harness mit
// gemocktem Audio (kein echtes Media-Decoding), gemocktem /tts/speak (liefert
// ein winziges Audio-Blob) und gezaehlten Object-URLs. Prueft: Dock nur bei
// $store.tts.enabled, Start -> satzweiser Highlight (CSS Custom Highlight API) +
// Fortschritt, durchlesen bis Ende, Pause/Resume am Media-Element, Skip,
// Stop (Highlight + Object-URLs aufgeraeumt), leerer Text -> Toast, 404/401 ->
// Session-Stop, Synthese-Fehler -> ein Toast pro Session.
//
// Deckt die Luecke, die der Refactor von Root-God-State auf Alpine.store('tts')
// (this.$store.tts.*) hinterlassen hat — Unit deckt nur die pure Segmentierung,
// Integration nur den Proxy; der Browser-Abspiel-Loop war ungetestet.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/tts-harness.html';

// Standard-Routen: /tts/speak liefert ein nicht-leeres Audio-Blob, der
// Telemetrie-Endpunkt wird ruhiggestellt (sonst Netzwerk-Rauschen im Guard).
async function routeOk(page) {
  await page.route('**/telemetry/tts-log', (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('**/tts/speak*', (r) =>
    r.fulfill({ status: 200, contentType: 'audio/mpeg', body: Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00]) }));
}

async function ready(page, url = HARNESS) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
}

const store = (page, getter) =>
  page.evaluate((src) => new Function('s', 'return (' + src + ')(s);')(window.__store), getter);

test.describe('TTS Proof-Listening', () => {
  test.describe.configure({ mode: 'serial' });

  test('Dock nur bei aktiviertem TTS', async ({ page }) => {
    await routeOk(page);
    await ready(page, HARNESS + '?enabled=false');
    await expect(page.locator('#tts-main')).toHaveCount(0);

    await ready(page, HARNESS + '?enabled=true');
    await expect(page.locator('#tts-main')).toHaveCount(1);
  });

  test('Start hebt aktuellen Satz hervor + zaehlt Fortschritt', async ({ page }) => {
    await routeOk(page);
    await ready(page);
    // Audio "ewig" -> Loop bleibt auf Satz 1 stehen, Zustand deterministisch.
    await page.evaluate(() => { window.__ttsBlockEnd = true; });
    await page.locator('#tts-main').click();

    await page.waitForFunction(() => window.__store.playing === true);
    // Der gerade gehoerte Satz ist via CSS Custom Highlight markiert.
    await page.waitForFunction(() => CSS.highlights.has('tts-sentence'));
    const snap = await store(page, 's => ({ index: s.index, total: s.total, playing: s.playing })');
    expect(snap.total).toBeGreaterThan(1);
    expect(snap.index).toBe(1);
    expect(snap.playing).toBe(true);
    await expect(page.locator('#tts-main')).toHaveAttribute('aria-pressed', 'true');

    await page.evaluate(() => window.__ttsApp.stopTtsProof());
  });

  test('Liest bis zum Ende durch und stoppt selbst', async ({ page }) => {
    await routeOk(page);
    await ready(page);
    await page.locator('#tts-main').click();

    // Ende der Wiedergabe: _ttsRun ruft am Schluss selbst _ttsStop.
    await page.waitForFunction(() => window.__store.playing === false && window.__store.index === 0, null, { timeout: 8000 });
    // Highlight aufgeraeumt, jedes erzeugte Object-URL wieder revoked (kein Leak).
    expect(await page.evaluate(() => CSS.highlights.has('tts-sentence'))).toBe(false);
    const urls = await page.evaluate(() => ({ c: window.__objUrlCreated, r: window.__objUrlRevoked }));
    expect(urls.c).toBeGreaterThan(0);
    expect(urls.r).toBe(urls.c);
  });

  test('Pause haelt das Media-Element an, Resume spielt weiter', async ({ page }) => {
    await routeOk(page);
    await ready(page);
    await page.evaluate(() => { window.__ttsBlockEnd = true; });
    await page.locator('#tts-main').click();
    await page.waitForFunction(() => window.__store.playing === true && !!window.__ttsApp);

    // Pausieren.
    await page.locator('#tts-main').click();
    await page.waitForFunction(() => window.__store.paused === true);
    await expect(page.locator('#tts-main')).toHaveAttribute('aria-pressed', 'false');
    // Skip ist im pausierten Zustand ausgeblendet.
    await expect(page.locator('#tts-skip')).toBeHidden();

    // Fortsetzen.
    await page.locator('#tts-main').click();
    await page.waitForFunction(() => window.__store.paused === false && window.__store.playing === true);

    await page.evaluate(() => window.__ttsApp.stopTtsProof());
  });

  test('Skip rueckt auf den naechsten Satz', async ({ page }) => {
    await routeOk(page);
    await ready(page);
    await page.evaluate(() => { window.__ttsBlockEnd = true; });
    await page.locator('#tts-main').click();
    await page.waitForFunction(() => window.__store.index === 1);

    await page.locator('#tts-skip').click();
    await page.waitForFunction(() => window.__store.index === 2);

    await page.evaluate(() => window.__ttsApp.stopTtsProof());
  });

  test('Stop raeumt Highlight, Audio und Object-URLs auf', async ({ page }) => {
    await routeOk(page);
    await ready(page);
    await page.evaluate(() => { window.__ttsBlockEnd = true; });
    await page.locator('#tts-main').click();
    await page.waitForFunction(() => CSS.highlights.has('tts-sentence'));

    await page.locator('#tts-stop').click();
    await page.waitForFunction(() => window.__store.playing === false);
    expect(await page.evaluate(() => CSS.highlights.has('tts-sentence'))).toBe(false);
    const urls = await page.evaluate(() => ({ c: window.__objUrlCreated, r: window.__objUrlRevoked }));
    expect(urls.r).toBe(urls.c);
    await expect(page.locator('#tts-stop')).toBeHidden();
  });

  test('Leerer Text -> Toast tts.error.empty, kein Start', async ({ page }) => {
    await routeOk(page);
    await ready(page);
    await page.evaluate(() => { document.getElementById('readview').innerHTML = '<p>   </p>'; });
    await page.locator('#tts-main').click();

    await page.waitForFunction(() => window.__toasts.some((t) => t.message === 'tts.error.empty'));
    expect(await store(page, 's => s.playing')).toBe(false);
  });

  test('404 (Feature aus) stoppt die Session', async ({ page }) => {
    await page.route('**/telemetry/tts-log', (r) => r.fulfill({ status: 204, body: '' }));
    await page.route('**/tts/speak*', (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"tts_disabled"}' }));
    await ready(page);
    await page.locator('#tts-main').click();
    await page.waitForFunction(() => window.__store.playing === false, null, { timeout: 6000 });
    // 404 toastet nicht (Feature serverseitig aus) — nur Session-Stop.
    expect(await page.evaluate(() => window.__toasts.some((t) => t.message === 'tts.error.failed'))).toBe(false);
  });

  test('401 (Session abgelaufen) stoppt die Session ohne Fehler-Toast', async ({ page }) => {
    await page.route('**/telemetry/tts-log', (r) => r.fulfill({ status: 204, body: '' }));
    await page.route('**/tts/speak*', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"error_code":"NOT_LOGGED_IN"}' }));
    await ready(page);
    await page.locator('#tts-main').click();
    await page.waitForFunction(() => window.__store.playing === false, null, { timeout: 6000 });
    expect(await page.evaluate(() => window.__toasts.some((t) => t.message === 'tts.error.failed'))).toBe(false);
  });

  test('Anhaltender Synthese-Fehler -> genau ein Fehler-Toast pro Session', async ({ page }) => {
    await page.route('**/telemetry/tts-log', (r) => r.fulfill({ status: 204, body: '' }));
    // 500 ist retrybar (TTS_MAX_RETRY=1) -> nach dem Retry Aufgabe, ein Toast.
    await page.route('**/tts/speak*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"upstream"}' }));
    await ready(page);
    await page.locator('#tts-main').click();

    // Defekte Saetze werden uebersprungen, Session laeuft ans Ende -> Stop.
    await page.waitForFunction(() => window.__store.playing === false, null, { timeout: 10000 });
    const failToasts = await page.evaluate(() => window.__toasts.filter((t) => t.message === 'tts.error.failed').length);
    expect(failToasts).toBe(1);
  });
});
