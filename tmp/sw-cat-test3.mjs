import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on('console', m => console.log(`[browser ${m.type()}] ${m.text()}`));
const reqs = [];
page.on('request', r => {
  const u = r.url();
  if (u.includes('/category')) reqs.push(`${r.method()} ${u}`);
});
page.on('response', async r => {
  const u = r.url();
  if (u.includes('/category')) {
    let body = '';
    try { body = await r.text(); } catch {}
    reqs.push(`<- ${r.status()} ${u} :: ${body.slice(0,120)}`);
  }
});

await page.goto('http://localhost:3737/', { waitUntil: 'networkidle' });
await page.waitForTimeout(500);
await page.evaluate((bookId) => { window.__app.selectedBookId = String(bookId); }, 102);
await page.waitForTimeout(400);
await page.evaluate(() => window.__app.toggleBookSettingsCard?.());
await page.waitForTimeout(800);

// Patch saveBookCategory to log.
await page.evaluate(() => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  const scope = window.Alpine.$data(card);
  const orig = scope.saveBookCategory.bind(scope);
  scope.saveBookCategory = function(...a) {
    console.log('[saveBookCategory called] bookCategoryId=', this.bookCategoryId);
    return orig(...a);
  };
  // Attach a listener on the wrapper to confirm event bubbles up.
  const labels = [...card.querySelectorAll('.card-form-label')];
  const lbl = labels.find(l => /Kategorie/i.test(l.textContent));
  const wrap = lbl.nextElementSibling;
  wrap.addEventListener('combobox-change', (e) => {
    console.log('[native listener] combobox-change detail=', e.detail, ' target=', e.target.tagName);
  });
  console.log('[wrap attrs]', wrap.outerHTML.slice(0, 200));
});

// Reset cat to TestCat first (to set known state).
await page.evaluate(async () => {
  await fetch('/books/102/category', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ category_id: 1 }) });
});
await page.evaluate(() => window.__app.toggleBookSettingsCard?.());
await page.waitForTimeout(200);
await page.evaluate(() => window.__app.toggleBookSettingsCard?.());
await page.waitForTimeout(800);
// Patch again (scope rebound).
await page.evaluate(() => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  const scope = window.Alpine.$data(card);
  const orig = scope.saveBookCategory.bind(scope);
  scope.saveBookCategory = function(...a) {
    console.log('[saveBookCategory called] bookCategoryId=', this.bookCategoryId);
    return orig(...a);
  };
  const labels = [...card.querySelectorAll('.card-form-label')];
  const lbl = labels.find(l => /Kategorie/i.test(l.textContent));
  const wrap = lbl.nextElementSibling;
  wrap.addEventListener('combobox-change', (e) => {
    console.log('[native listener] combobox-change detail=', e.detail);
  });
});

// Click empty first.
await page.evaluate(async () => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  const labels = [...card.querySelectorAll('.card-form-label')];
  const lbl = labels.find(l => /Kategorie/i.test(l.textContent));
  const wrap = lbl.nextElementSibling;
  wrap.querySelector('.combobox-trigger').click();
  await new Promise(r => setTimeout(r, 200));
  const empty = [...wrap.querySelectorAll('.combobox-option')].find(o => /Keine Kategorien angelegt/.test(o.textContent));
  console.log('[CLICK empty]');
  empty.click();
});
await page.waitForTimeout(600);

// Click TestCat.
await page.evaluate(async () => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  const labels = [...card.querySelectorAll('.card-form-label')];
  const lbl = labels.find(l => /Kategorie/i.test(l.textContent));
  const wrap = lbl.nextElementSibling;
  wrap.querySelector('.combobox-trigger').click();
  await new Promise(r => setTimeout(r, 200));
  const tgt = [...wrap.querySelectorAll('.combobox-option')].find(o => /TestCat/.test(o.textContent));
  console.log('[CLICK testcat]');
  tgt.click();
});
await page.waitForTimeout(600);

console.log('REQS:', JSON.stringify(reqs, null, 2));

await browser.close();
