import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
const errors = []; page.on('pageerror', e => errors.push(e.message));
await page.goto('http://localhost:3737/#book/1000011/ereignisse', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.gz-band-marker', { timeout: 5000 });

// 1) Marker click → selected class applied (after Alpine tick)
await page.locator('.gz-band-marker:not(.gz-band-marker--more)').first().click();
await page.waitForTimeout(150);
const sel = await page.locator('.gz-band-marker--selected').count();
const selId = await page.locator('.gz-band-marker--selected').first().getAttribute('data-ev-id').catch(() => null);

// 2) List date click → selectTimelineEvent highlights the matching marker
const dateClickable = page.locator('.global-zeitstrahl-body--card .gz-datum.internal-link').first();
await dateClickable.click();
await page.waitForTimeout(200);
const sel2 = await page.locator('.gz-band-marker--selected').count();

// 3) "+N" chip exists with cluster tooltip; never selected
const moreCount = await page.locator('.gz-band-marker--more').count();
let chipTip = null;
if (moreCount) chipTip = await page.locator('.gz-band-marker--more').first().getAttribute('data-tip');

console.log(JSON.stringify({ selAfterMarkerClick: sel, selId, selAfterListClick: sel2, moreCount, chipTip, errors }, null, 1));
await browser.close();
