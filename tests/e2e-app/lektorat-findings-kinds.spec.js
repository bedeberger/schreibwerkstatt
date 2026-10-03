// Befund-Klassen (hart / weich / redaktionell) in der Befundliste der
// Notebook-Leseansicht, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: die Klassen hängen am Alpine-Template
// (public/partials/editor-findings.html) und an der Sub-Komponente
// `lektoratFindingsCard`. Ein Tippfehler im Template-Ausdruck verschluckt Alpine
// still — sichtbar nur im echten Template-Baum mit vollem CSS.
//
// Geprüfte Invarianten (docs/lektorat.md, „Befund-Klassen"):
//   1. Jede Klasse rendert ihre eigene Kanten-Klasse und ihr eigenes Badge.
//   2. Redaktionelle Befunde tragen den Erklär-Tooltip, die anderen nicht.

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp, selectSeededBook } = require('./_helpers/app');

test('Befundliste: hart, weich und redaktionell sind unterscheidbar', async ({ page }) => {
  await bootApp(page);
  await selectSeededBook(page);
  await page.evaluate(async () => {
    await window.__app.selectPage(window.Alpine.store('nav').pages[0]);
  });
  await page.evaluate(() => {
    const app = window.__app;
    app.lektoratFindings = [
      { typ: 'rechtschreibung', original: 'Fhler', korrektur: 'Fehler', erklaerung: 'Tippfehler.' },
      { typ: 'fuellwort', original: 'eigentlich', korrektur: '', erklaerung: 'Füllwort.' },
      { typ: 'unbelegt', original: 'Die Zahl stieg stark.', korrektur: 'Die Zahl stieg.', erklaerung: 'Ohne Beleg.' },
    ];
    app.selectedFindings = [true, false, false];
    app.checkDone = true;
  });

  const rows = page.locator('.lektorat-split-findings label.finding');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toHaveClass(/\berror\b/);
  await expect(rows.nth(1)).toHaveClass(/\bstyle\b/);
  await expect(rows.nth(2)).toHaveClass(/\beditorial\b/);
  await expect(rows.nth(2)).not.toHaveClass(/\berror\b|\bstyle\b/);

  const badges = rows.locator('> .badge');
  await expect(badges.nth(0)).toHaveClass(/badge-err/);
  await expect(badges.nth(1)).toHaveClass(/badge-warn/);
  await expect(badges.nth(2)).toHaveClass(/badge-neutral/);
  await expect(badges.nth(2)).toHaveAttribute('data-tip', /.+/);
  await expect(badges.nth(0)).not.toHaveAttribute('data-tip', /.*/);
});
