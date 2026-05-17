const { test, expect } = require('@playwright/test');
test('lektorat reproducible bug', async ({ page }) => {
  test.setTimeout(120000);
  const errs = [];
  const reqs = [];
  page.on('console', m => { errs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[pageerror] ${e.message}`));
  page.on('request', r => { if (r.url().includes('/jobs/') || r.url().includes('/check')) reqs.push(r.method() + ' ' + r.url()); });
  page.on('response', async r => { if (r.url().includes('/jobs/') || r.url().includes('/check')) reqs.push(' ← ' + r.status() + ' ' + r.url()); });

  await page.goto('http://localhost:3737/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  console.log('initial:', await page.evaluate(() => JSON.stringify({
    hasApp: !!window.__app,
    bookId: window.__app?.selectedBookId,
    pages: window.__app?.pages?.length,
  })));

  await page.evaluate(() => { window.__app.selectedBookId = 102; });
  await page.waitForTimeout(2500);
  console.log('after book select:', await page.evaluate(() => JSON.stringify({
    bookId: window.__app.selectedBookId,
    pageCount: window.__app.pages?.length,
    firstPageId: window.__app.pages?.[0]?.id,
  })));

  await page.evaluate(async () => { await window.__app.selectPage(104); });
  await page.waitForTimeout(2000);
  console.log('after selectPage:', await page.evaluate(() => JSON.stringify({
    currentPageId: window.__app.currentPage?.id,
    currentPageName: window.__app.currentPage?.name,
    showEditorCard: window.__app.showEditorCard,
    saveOffline: window.__app.saveOffline,
    editDirty: window.__app.editDirty,
    currentPageEmpty: window.__app.currentPageEmpty,
  })));

  console.log('calling runCheck()...');
  await page.evaluate(async () => {
    try { await window.__app.runCheck(); window.__runCheckOk = true; }
    catch (e) { window.__runCheckErr = e.message + '\n' + e.stack; }
  });
  console.log('runCheckErr:', await page.evaluate(() => window.__runCheckErr || null));
  console.log('runCheckOk:', await page.evaluate(() => window.__runCheckOk || null));
  await page.waitForTimeout(2000);
  console.log('after runCheck:', await page.evaluate(() => JSON.stringify({
    checkLoading: window.__app.checkLoading,
    checkDone: window.__app.checkDone,
    checkStatus: (window.__app.checkStatus||'').slice(0, 200),
    analysisOut: (window.__app.analysisOut||'').slice(0, 200),
  })));

  console.log('--- requests ---');
  for (const r of reqs) console.log(r);
  console.log('--- console (last 30) ---');
  for (const e of errs.slice(-30)) console.log(e);
});
