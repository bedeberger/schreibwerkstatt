import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
const logs = [];
page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
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

// Select test book 102 via root scope.
const ok = await page.evaluate(async (bookId) => {
  const app = window.__app;
  if (!app) return { err: 'no __app' };
  app.selectedBookId = String(bookId);
  // Wait briefly for watcher to load pages etc.
  await new Promise(r => setTimeout(r, 400));
  return { selectedBookId: app.selectedBookId, books: app.books.map(b => b.id) };
}, 102);
console.log('SELECT:', JSON.stringify(ok));

// Open book settings card.
await page.evaluate(() => window.__app.toggleBookSettingsCard?.());
await page.waitForTimeout(600);

// Inspect card scope.
const inspect = await page.evaluate(() => {
  const el = document.querySelector('[x-data="bookSettingsCard"]');
  if (!el) return { err: 'card el missing' };
  const scope = window.Alpine.$data(el);
  return {
    showFlag: window.__app.showBookSettingsCard,
    pool: scope.categoryPool,
    catId: scope.bookCategoryId,
  };
});
console.log('CARD:', JSON.stringify(inspect, null, 2));

// Click category combobox.
const cat = await page.evaluate(async () => {
  const card = document.querySelector('[x-data="bookSettingsCard"]');
  if (!card) return { err: 'no card' };
  // Find combobox-wrap inside taxonomy section by label text.
  const labels = [...card.querySelectorAll('.card-form-label')];
  const lbl = labels.find(l => /Kategorie/i.test(l.textContent));
  const wrap = lbl?.nextElementSibling;
  if (!wrap) return { err: 'no wrap' };
  const trig = wrap.querySelector('.combobox-trigger');
  trig.click();
  await new Promise(r => setTimeout(r, 200));
  const opts = [...wrap.querySelectorAll('.combobox-option')];
  const optInfo = opts.map(o => o.textContent.trim());
  // Click the option that isn't empty placeholder.
  const target = opts.find(o => /TestCat/.test(o.textContent));
  if (!target) return { err: 'no testcat option', optInfo };
  target.click();
  await new Promise(r => setTimeout(r, 800));
  const scope = window.Alpine.$data(card);
  return { optInfo, catIdAfter: scope.bookCategoryId };
});
console.log('SELECT_RESULT:', JSON.stringify(cat, null, 2));
console.log('REQS:', reqs);
console.log('--- last 30 console logs ---');
console.log(logs.slice(-30).join('\n'));

await browser.close();
