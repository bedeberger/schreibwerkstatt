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

// Caret an den Anfang des Editor-Inhalts setzen (collapse to start). `userSet`
// markiert ihn als bewusst gesetzt (sonst gilt er als veraltet -> Editorende).
async function placeCaretStart(page, userSet) {
  await page.evaluate((flag) => {
    const el = document.getElementById('editor');
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(true);
    const sel = document.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    window.__sttApp.sttCaretUserSet = !!flag;
  }, userSet);
}

// Ein VAD-Segment ausloesen (sprechen -> Stille -> Schnitt) und auf das
// eingefuegte Transkript warten.
async function dictateOneSegment(page) {
  await page.locator('#stt-mic').click();
  await page.waitForFunction(() => window.__sttApp.sttRecording === true);
  await page.evaluate(() => { window.__voice = true; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { window.__voice = false; });
  await page.waitForFunction(() => document.getElementById('editor').textContent.includes('Hallo Welt'));
}

test('Mic-Klick ohne bewussten Caret haengt ans Editorende an', async ({ page }) => {
  await ready(page, HARNESS + '?enabled=true');
  // Veralteter Caret am Anfang, NICHT bewusst gesetzt -> muss ans Ende anhaengen.
  await placeCaretStart(page, false);
  await dictateOneSegment(page);

  const text = await page.evaluate(() => document.getElementById('editor').textContent);
  expect(text.startsWith('Start')).toBe(true);
  expect(text.trimEnd().endsWith('Hallo Welt')).toBe(true);
});

test('Bewusst gesetzter Caret: Diktat fuegt dort ein', async ({ page }) => {
  await ready(page, HARNESS + '?enabled=true');
  // Bewusster Caret am Anfang -> Diktat erscheint VOR "Start.".
  await placeCaretStart(page, true);
  await dictateOneSegment(page);

  const text = await page.evaluate(() => document.getElementById('editor').textContent);
  expect(text.startsWith('Hallo Welt')).toBe(true);
  expect(text.includes('Start.')).toBe(true);
});

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
