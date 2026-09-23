const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    try { localStorage.setItem('sw', '1'); } catch {}
    window.__t = [];
    const mark = (s) => window.__t.push(s + ' @' + Math.round(performance.now()));
    window.addEventListener('load', () => mark('window.load'));
    const orig = navigator.serviceWorker.register.bind(navigator.serviceWorker);
    navigator.serviceWorker.register = async (...a) => {
      mark('register()'); const reg = await orig(...a);
      const w = reg.installing || reg.waiting || reg.active;
      if (w) { mark('worker ' + w.state); w.addEventListener('statechange', () => mark('worker ' + w.state)); }
      return reg;
    };
  });
  const page = await ctx.newPage();
  await page.goto('http://localhost:8790/');
  await page.waitForFunction(() => window.__t.some(s => s.startsWith('worker activated')), null, { timeout: 90000 });
  console.log((await page.evaluate(() => window.__t)).join('\n'));
  await browser.close();
})();
