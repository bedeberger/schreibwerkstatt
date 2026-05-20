const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  
  page.on('console', msg => console.log(`[c:${msg.type()}]`, msg.text()));
  page.on('pageerror', err => console.log('[err]', err.message));
  
  await page.goto('http://localhost:3737/');
  await page.waitForFunction(() => window.__app && typeof window.__app.enterFocusFromPageview === 'function', { timeout: 15000 });
  await page.waitForTimeout(3000);
  
  const bookId = await page.evaluate(() => (window.__app?.books || [])[0]?.id);
  console.log('bookId:', bookId);
  
  if (!bookId) { await browser.close(); return; }
  await page.evaluate((id) => { window.__app.selectedBookId = String(id); }, bookId);
  await page.waitForTimeout(2000);
  
  const firstPage = await page.evaluate(() => (window.__app?.pages || []).find(p => !p.is_folder && p.id));
  console.log('firstPage:', firstPage?.id, firstPage?.name);
  if (!firstPage) { await browser.close(); return; }
  
  await page.evaluate((p) => window.__app.selectPage(p), firstPage);
  await page.waitForTimeout(2500);
  
  // Enter via page-view → enterFocusFromPageview
  await page.evaluate(() => window.__app.enterFocusFromPageview());
  await page.waitForTimeout(2000);
  
  const state = await page.evaluate(() => {
    const focusEl = document.querySelector('.focus-editor');
    const focusElActive = document.querySelector('.focus-editor.is-active');
    const focusC = document.querySelector('.focus-editor.is-active .page-content-view--editing');
    const normalC = document.querySelector('#editor-card .page-content-view--editing');
    let subData = null;
    try {
      const sub = document.querySelector('[x-data="editorFocusCard"]');
      subData = sub ? window.Alpine.$data(sub) : null;
    } catch (e) {}
    return {
      focusActive: window.__app.focusActive,
      editMode: window.__app.editMode,
      bodyClass: document.body.className,
      focusElDisplayCss: focusEl ? getComputedStyle(focusEl).display : '(none)',
      focusElActiveExists: !!focusElActive,
      focusCExists: !!focusC,
      focusCChildren: focusC ? focusC.children.length : 0,
      normalCChildren: normalC ? normalC.children.length : 0,
      subState: subData?._focusState,
      subListenersExist: !!subData?._focusListeners,
      subListenerContainerClass: subData?._focusListeners?.container?.className,
      activeBlockInFocus: document.querySelectorAll('.focus-editor.is-active .focus-paragraph-active').length,
    };
  });
  console.log('STATE after enter:', JSON.stringify(state, null, 2));
  
  // Place caret + type
  const placedOk = await page.evaluate(() => {
    const c = document.querySelector('.focus-editor.is-active .page-content-view--editing');
    if (!c) return 'no container';
    const ps = c.querySelectorAll('p');
    if (ps.length < 5) return 'few ps: ' + ps.length;
    const target = ps[Math.min(20, ps.length - 5)];
    const r = document.createRange();
    r.selectNodeContents(target);
    r.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
    return 'placed at p#' + Math.min(20, ps.length - 5) + ' total=' + ps.length;
  });
  console.log('caret:', placedOk);
  await page.waitForTimeout(300);
  
  const before = await page.evaluate(() => {
    const c = document.querySelector('.focus-editor.is-active .page-content-view--editing');
    return { scrollTop: c?.scrollTop, active: document.querySelectorAll('.focus-paragraph-active').length };
  });
  console.log('Before type:', before);
  
  await page.keyboard.type('xy');
  await page.waitForTimeout(400);
  
  const after = await page.evaluate(() => {
    const c = document.querySelector('.focus-editor.is-active .page-content-view--editing');
    return { scrollTop: c?.scrollTop, active: document.querySelectorAll('.focus-paragraph-active').length, counterW: window.__app.focusCountWords };
  });
  console.log('After type:', after);
  
  await browser.close();
})();
