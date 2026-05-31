import { chromium } from '@playwright/test';
const BASE = 'http://localhost:3737';
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
page.on('console', m => { if (m.type()==='error') console.log('  [browser err]', m.text()); });

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.waitForFunction(() => !!window.__app, null, { timeout: 15000 });

const shape = await page.evaluate(() => {
  const app = window.__app;
  return { sample: (app.pages||[]).slice(0,2), keys: Object.keys((app.pages||[])[0]||{}) };
});
console.log('SHAPE', JSON.stringify(shape));

const open = await page.evaluate(async () => {
  const app = window.__app;
  const pages = app.pages || [];
  const p = pages[0];
  await app.selectPage(p);
  await new Promise(r=>setTimeout(r,800));
  return { pid: p.id, hasOriginal: !!app.originalHtml, len: (app.originalHtml||'').length };
});
console.log('OPEN', JSON.stringify(open));

const inj = await page.evaluate(async () => {
  const app = window.__app;
  app.lektoratFindings = [
    { typ: 'rechtschreibung', original: 'Walld', korrektur: 'Wald', erklaerung: 'Schreibfehler.' },
    { typ: 'stil', original: 'ging schnell', korrektur: 'eilte', erklaerung: 'Praegnanteres Verb verwenden statt Adverb-Konstruktion.' },
  ];
  app.selectedFindings = [true, false];
  app.appliedOriginals = [];
  app.appliedHistoricCorrections = [];
  app.analysisOut = '';
  app.checkDone = true;
  if (app._ensurePartial) { try { await app._ensurePartial('editor-findings'); } catch(e){} }
  app.updatePageView && app.updatePageView();
  await new Promise(r => setTimeout(r, 500));
  const wrap = document.querySelector('.editor-body-wrap');
  const prev = document.querySelector('.lektorat-split-preview');
  const panel = document.querySelector('.lektorat-split-findings');
  return {
    wrapClass: wrap?.className,
    previewRect: prev?.getBoundingClientRect(),
    panelRect: panel?.getBoundingClientRect(),
    scrollH: document.documentElement.scrollHeight,
    viewportH: window.innerHeight,
  };
});
console.log('LAYOUT', JSON.stringify(inj, null, 2));

// full page screenshot to see order
await page.screenshot({ path: '/Users/bd/ClaudeProjects/schreibwerkstatt/_probe_full.png', fullPage: true });
console.log('shot saved');
await b.close();
