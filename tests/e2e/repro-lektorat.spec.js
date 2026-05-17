const { test, expect } = require('@playwright/test');
test('lektorat reproducible bug', async ({ page }) => {
  test.setTimeout(180000);
  const errs = [];
  const reqs = [];
  page.on('console', m => { errs.push(`[${m.type()}] ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[pageerror] ${e.message}`));
  page.on('request', r => { if (r.url().includes('/jobs/') || r.url().includes('/check')) reqs.push(r.method() + ' ' + r.url()); });
  page.on('response', async r => { if (r.url().includes('/jobs/') || r.url().includes('/check')) reqs.push(' ← ' + r.status() + ' ' + r.url()); });

  await page.goto('http://localhost:3737/');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  await page.evaluate(() => { window.__app.selectedBookId = 102; });
  await page.waitForTimeout(2500);

  // Realistic click on page in tree (not direct selectPage call)
  const pageLink = page.locator('text="Morgen am Seeufer"').first();
  await pageLink.scrollIntoViewIfNeeded();
  await pageLink.click();
  await page.waitForTimeout(2500);

  console.log('after click:', await page.evaluate(() => JSON.stringify({
    currentPageId: window.__app.currentPage?.id,
    currentPageName: window.__app.currentPage?.name,
    showEditorCard: window.__app.showEditorCard,
    saveOffline: window.__app.saveOffline,
    editDirty: window.__app.editDirty,
    currentPageEmpty: window.__app.currentPageEmpty,
  })));

  // Click "Prüfen" button (real UI interaction)
  const checkBtn = page.locator('button:has-text("Prüfen"), button:has-text("Check")').first();
  console.log('check button visible:', await checkBtn.isVisible());
  await checkBtn.click();
  console.log('clicked check');

  // Wait briefly to see state right after click
  await page.waitForTimeout(2000);
  console.log('after click runCheck:', await page.evaluate(() => JSON.stringify({
    checkLoading: window.__app.checkLoading,
    checkDone: window.__app.checkDone,
    checkStatus: (window.__app.checkStatus||'').slice(0, 200),
    analysisOut: (window.__app.analysisOut||'').slice(0, 200),
  })));

  // Wait for completion
  let lastState = '';
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const s = await page.evaluate(() => {
      const a = window.__app;
      return JSON.stringify({
        loading: a.checkLoading, done: a.checkDone,
        findings: a.lektoratFindings?.length, status: (a.checkStatus||'').slice(0,60), analysis: (a.analysisOut||'').slice(0,80),
      });
    });
    if (s !== lastState) { console.log(i+': '+s); lastState = s; }
    if (s.includes('"done":true')) break;
    if (s.includes('error-msg')) break;
  }
  console.log('--- requests ---');
  for (const r of reqs) console.log(r);
  console.log('--- console errors only ---');
  for (const e of errs) if (e.startsWith('[error]') || e.startsWith('[pageerror]')) console.log(e);
});
