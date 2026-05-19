import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('console', m => console.log(`[b ${m.type()}] ${m.text()}`));
const reqs = [];
page.on('request', r => {
  const u = r.url();
  if (u.includes('/category')) reqs.push(`> ${r.method()} ${u}`);
});
page.on('response', async r => {
  const u = r.url();
  if (u.includes('/category')) {
    let b = ''; try { b = await r.text(); } catch {}
    reqs.push(`< ${r.status()} :: ${b.slice(0,80)}`);
  }
});

await page.goto('http://localhost:3737/', { waitUntil: 'networkidle' });
await page.evaluate(async () => {
  await fetch('/books/102/category', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ category_id: null }) });
});
await page.waitForTimeout(500);
await page.evaluate(() => { window.__app.selectedBookId = '102'; });
await page.waitForTimeout(400);
await page.evaluate(() => window.__app.toggleBookSettingsCard?.());
await page.waitForTimeout(800);

// Patch
await page.evaluate(() => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  const scope = window.Alpine.$data(card);
  const orig = scope.saveBookCategory.bind(scope);
  scope.saveBookCategory = function(...a) {
    console.log('[saveBookCategory called] bookCategoryId=', JSON.stringify(this.bookCategoryId), ' selectedBookId=', window.__app.selectedBookId);
    return orig(...a);
  };
  const labels = [...card.querySelectorAll('.card-form-label')];
  const lbl = labels.find(l => /Kategorie/i.test(l.textContent));
  const wrap = lbl.nextElementSibling;
  wrap.addEventListener('combobox-change', (e) => {
    console.log('[native combobox-change] detail=', JSON.stringify(e.detail));
  }, true); // capture
  // Also normal phase listener.
  wrap.addEventListener('combobox-change', (e) => {
    console.log('[native bubble combobox-change] detail=', JSON.stringify(e.detail));
  });
  console.log('[init] bookCategoryId=', JSON.stringify(scope.bookCategoryId));
});

// State now null.
console.log('--- CLICK TESTCAT ---');
await page.evaluate(async () => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  const labels = [...card.querySelectorAll('.card-form-label')];
  const lbl = labels.find(l => /Kategorie/i.test(l.textContent));
  const wrap = lbl.nextElementSibling;
  wrap.querySelector('.combobox-trigger').click();
  await new Promise(r => setTimeout(r, 200));
  const tgt = [...wrap.querySelectorAll('.combobox-option')].find(o => /TestCat/.test(o.textContent));
  if (!tgt) { console.log('NO TARGET, opts=', [...wrap.querySelectorAll('.combobox-option')].map(o => o.textContent)); return; }
  tgt.click();
});
await page.waitForTimeout(800);

console.log('REQS:', JSON.stringify(reqs, null, 2));
await browser.close();
