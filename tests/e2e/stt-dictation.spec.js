// E2E: STT-Diktat im Notebook-Editor (Harness mit gemocktem getUserMedia/
// MediaRecorder/AudioContext; /stt/transcribe ist im Test-Server gemockt und
// liefert "Hallo Welt"). Prueft: Button nur bei sttEnabled, VAD-Segment ->
// Text am Cursor + Autosave-Trigger, Stop gibt Mic frei, Permission-Denial ->
// i18n-Fehler ohne Crash.

const { test, expect } = require('./_helpers/fixtures');

const HARNESS = '/tests/fixtures/stt-harness.html';

async function ready(page, url = HARNESS) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);
}

// Caret ans Ende des Editor-Inhalts setzen.
async function placeCaret(page) {
  await page.evaluate(() => {
    const el = document.getElementById('editor');
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(false);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  });
}

test('Button nur bei sttEnabled vorhanden', async ({ page }) => {
  await ready(page, HARNESS + '?enabled=false');
  await expect(page.locator('#stt-mic')).toHaveCount(0);

  await ready(page, HARNESS + '?enabled=true');
  await expect(page.locator('#stt-mic')).toHaveCount(1);
});

test('VAD-Segment fuegt Transkript am Cursor ein + triggert Autosave', async ({ page }) => {
  await ready(page);
  await placeCaret(page);

  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.sttRecording === true);
  await expect(page.locator('#stt-mic')).toHaveAttribute('aria-pressed', 'true');

  // Sprechen simulieren, dann Stille -> VAD schneidet das Segment.
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__voice = false; });

  // Eingefuegter Text erscheint + Autosave (dirty) getriggert.
  await page.waitForFunction(() => document.getElementById('editor').textContent.includes('Hallo Welt'));
  const dirty = await page.evaluate(() => window.__dirtyCount);
  expect(dirty).toBeGreaterThan(0);

  // Aufnahme laeuft weiter (naechstes Segment) — Button bleibt gedrueckt.
  await expect(page.locator('#stt-mic')).toHaveAttribute('aria-pressed', 'true');
});

test('Stop gibt Mikrofon frei (kein Leak)', async ({ page }) => {
  await ready(page);
  await placeCaret(page);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.sttRecording === true);

  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.sttRecording === false);
  const stopped = await page.evaluate(() => window.__micStopped);
  expect(stopped).toBeGreaterThan(0);
  await expect(page.locator('#stt-mic')).toHaveAttribute('aria-pressed', 'false');
});

test('Mic-Permission verweigert -> i18n-Fehler, kein Crash', async ({ page, consoleGuard }) => {
  await ready(page, HARNESS + '?deny=true');
  await placeCaret(page);
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__toasts.length > 0);
  const toast = await page.evaluate(() => window.__toasts[0]);
  expect(toast.message).toBe('stt.error.permission');
  // Recording wurde nicht gestartet.
  expect(await page.evaluate(() => window.__sttApp.sttRecording)).toBe(false);
});
