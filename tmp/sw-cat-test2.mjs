import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
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
await page.waitForTimeout(800);

await page.evaluate((bookId) => { window.__app.selectedBookId = String(bookId); }, 102);
await page.waitForTimeout(500);
await page.evaluate(() => window.__app.toggleBookSettingsCard?.());
await page.waitForTimeout(600);

// Scenario A: book has cat=1, select "Keine Kategorien angelegt." (empty value).
const a = await page.evaluate(async () => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  const labels = [...card.querySelectorAll('.card-form-label')];
  const lbl = labels.find(l => /Kategorie/i.test(l.textContent));
  const wrap = lbl.nextElementSibling;
  wrap.querySelector('.combobox-trigger').click();
  await new Promise(r => setTimeout(r, 200));
  const opts = [...wrap.querySelectorAll('.combobox-option')];
  const empty = opts.find(o => /Keine Kategorien angelegt/.test(o.textContent));
  empty.click();
  await new Promise(r => setTimeout(r, 600));
  const scope = window.Alpine.$data(card);
  return { afterEmpty: scope.bookCategoryId };
});
console.log('A (-> empty):', JSON.stringify(a));

// Scenario B: re-select TestCat.
const b = await page.evaluate(async () => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  const labels = [...card.querySelectorAll('.card-form-label')];
  const lbl = labels.find(l => /Kategorie/i.test(l.textContent));
  const wrap = lbl.nextElementSibling;
  wrap.querySelector('.combobox-trigger').click();
  await new Promise(r => setTimeout(r, 200));
  const opts = [...wrap.querySelectorAll('.combobox-option')];
  const target = opts.find(o => /TestCat/.test(o.textContent));
  target.click();
  await new Promise(r => setTimeout(r, 600));
  const scope = window.Alpine.$data(card);
  return { afterReselect: scope.bookCategoryId };
});
console.log('B (-> TestCat):', JSON.stringify(b));

// Scenario C: switch book then back.
await page.evaluate(() => window.__app.toggleBookSettingsCard?.());
await page.waitForTimeout(300);
await page.evaluate(() => { window.__app.selectedBookId = '67'; });
await page.waitForTimeout(400);
await page.evaluate(() => { window.__app.selectedBookId = '102'; });
await page.waitForTimeout(400);
await page.evaluate(() => window.__app.toggleBookSettingsCard?.());
await page.waitForTimeout(800);
const c = await page.evaluate(() => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  const scope = window.Alpine.$data(card);
  return { catId: scope.bookCategoryId, pool: scope.categoryPool.map(p => p.name) };
});
console.log('C (reopen):', JSON.stringify(c));

console.log('REQS:', JSON.stringify(reqs, null, 2));

await browser.close();
