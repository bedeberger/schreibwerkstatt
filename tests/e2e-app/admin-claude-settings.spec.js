// Claude-Tab der Admin-Settings gegen die ECHTE App: oben nur Standard-Felder,
// Per-Job-Modelle/Limits/Komplett-Tuning im eingeklappten „Erweitert"-Bereich.
// Der Zähler am Toggle darf eine aktive Abweichung nicht hinter dem Einklappen
// verstecken — das hängt am echten Alpine-Baum (collapsible + adminSettingsForm).

const { test, expect } = require('../e2e/_helpers/fixtures');
const { bootApp } = require('./_helpers/app');

async function openClaudeTab(page) {
  await page.evaluate(async () => { await window.__app.toggleAdminSettingsCard(); });
  const card = page.locator('[x-show="$app.showAdminSettingsCard"]').first();
  await expect(card).toBeVisible();
  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    c.adminSettingsTab = 'provider';
    c.adminSettingsProviderSubtab = 'claude';
  });
  return card;
}

const fieldOf = (card, key) => card.locator('.setting-field').filter({ hasText: key }).first();

test('Claude-Tab: Erweitert eingeklappt, Zähler zeigt Abweichungen, Felder aufklappbar', async ({ page }) => {
  await bootApp(page);
  const card = await openClaudeTab(page);

  await expect(fieldOf(card, 'ai.claude.model')).toBeVisible();
  await expect(fieldOf(card, 'ai.claude.effort.lektorat')).toBeVisible();
  await expect(fieldOf(card, 'ai.claude.model.lektorat')).toBeHidden();
  await expect(fieldOf(card, 'ai.claude.context_window')).toBeHidden();

  const toggle = card.locator('.admin-settings-advanced > .collapsible-toggle');
  const badge = toggle.locator('.admin-settings-active-badge');
  await expect(badge).toBeHidden();

  await page.evaluate(() => {
    const c = window.Alpine.$data(document.querySelector('[x-data="adminSettingsCard"]'));
    c.adminSettingsForm['ai.claude.model.lektorat'] = 'claude-opus-5-5';
    c.adminSettingsForm['ai.claude.context_window.komplett'] = 1000000;
  });
  await expect(badge).toBeVisible();
  await expect(badge).toContainText('2');

  await toggle.click();
  for (const key of ['ai.claude.model.lektorat', 'ai.claude.model.bookchat', 'ai.claude.context_window',
    'ai.claude.timeout_ms.komplett', 'ai.komplett.factcheck', 'ai.claude.phase1_concurrency']) {
    await expect(fieldOf(card, key)).toBeVisible();
  }
});
