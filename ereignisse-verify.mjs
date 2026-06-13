import { chromium } from 'playwright';
const URL = 'http://localhost:3737/#book/1000011/ereignisse';
const OUT = '/tmp/ereignisse-shots';
import { mkdirSync } from 'node:fs';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });

const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

const t0 = Date.now();
await page.goto(URL, { waitUntil: 'domcontentloaded' });

// Sample band height + marker count over ~3s to confirm no late jump.
const rows = [];
for (let i = 0; i < 60; i++) {
  const d = await page.evaluate(() => {
    const band = document.querySelector('.gz-band');
    const track = document.querySelector('.gz-band-track');
    return {
      bandH: band ? Math.round(band.getBoundingClientRect().height) : null,
      trackH: track ? Math.round(track.getBoundingClientRect().height) : null,
      markers: document.querySelectorAll('.gz-band-marker').length,
      moreChips: document.querySelectorAll('.gz-band-marker--more').length,
      ticks: document.querySelectorAll('.gz-band-tick').length,
      lanesVar: track ? getComputedStyle(track).getPropertyValue('--gz-band-lanes').trim() : null,
    };
  }).catch(() => ({}));
  rows.push({ t: Date.now() - t0, ...d });
  await page.waitForTimeout(50);
}

let last = '';
console.log('t(ms)\tbandH\ttrackH\tmarkers\tmore\tticks\tlanes');
for (const r of rows) {
  const sig = `${r.bandH}|${r.trackH}|${r.markers}|${r.moreChips}|${r.ticks}|${r.lanesVar}`;
  if (sig !== last) { console.log(`${r.t}\t${r.bandH}\t${r.trackH}\t${r.markers}\t${r.moreChips}\t${r.ticks}\t${r.lanesVar}`); last = sig; }
}

// Interaction: click first marker → list entry scrolled + selected class.
const clickRes = await page.evaluate(() => {
  const m = document.querySelector('.gz-band-marker:not(.gz-band-marker--more)');
  if (!m) return { ok: false };
  m.click();
  const id = m.getAttribute('data-ev-id');
  const sel = document.querySelector('.gz-band-marker--selected');
  return { ok: true, clickedId: id, selectedAfter: sel?.getAttribute('data-ev-id') ?? null };
});
console.log('marker click:', JSON.stringify(clickRes));

await page.waitForTimeout(200);
await page.screenshot({ path: `${OUT}/band-final.png` });
// Tight crop of just the band area for detail.
const bandBox = await page.locator('.gz-band').boundingBox().catch(() => null);
if (bandBox) await page.screenshot({ path: `${OUT}/band-crop.png`, clip: { x: bandBox.x, y: Math.max(0, bandBox.y - 4), width: bandBox.width, height: bandBox.height + 8 } });

console.log('console errors:', errors.length ? JSON.stringify(errors, null, 1) : 'none');
await browser.close();
