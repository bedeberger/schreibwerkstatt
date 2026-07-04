const { test, expect } = require('./_helpers/fixtures');
const BASE = 'http://localhost:8765';

test('pageNumberFirstVisible field edit propagates', async ({ page }) => {
  await page.request.post(`${BASE}/__mock/pdf-reset`);
  await page.goto(`${BASE}/tests/fixtures/pdf-export-harness.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__harnessReady === true);

  await page.locator('.export-profile-bar button:has(use[href$="#plus"])').click();
  await page.locator('.export-create-row:not(.export-rename-row) .card-form-input').fill('P');
  await page.locator('.export-create-row button.primary', { hasText: 'Anlegen' }).click();
  await expect(page.locator('.export-tabs')).toBeVisible();

  // Activate pagination tab via model
  await page.evaluate(() => {
    const root = document.querySelector('.pdf-export-card');
    window.Alpine.$data(root).activeTab = 'pagination';
  });
  await page.waitForTimeout(120);

  // Set config to 9
  await page.evaluate(() => {
    const root = document.querySelector('.pdf-export-card');
    window.Alpine.$data(root).activeProfile.config.layout.pageNumberFirstVisible = 9;
  });
  await page.waitForTimeout(120);

  const field = page.locator('input[x-model="activeProfile.config.layout.pageNumberFirstVisible"]');
  console.log('field count:', await field.count());
  console.log('field value before:', await field.inputValue());

  // Edit to 7 like a user: focus, select all, type 7, blur
  await field.click();
  await field.press('Control+a');
  await field.fill('7');
  await field.blur();
  await page.waitForTimeout(120);

  const model = await page.evaluate(() => {
    const root = document.querySelector('.pdf-export-card');
    return window.Alpine.$data(root).activeProfile.config.layout.pageNumberFirstVisible;
  });
  console.log('MODEL after edit:', model);
  console.log('field value after:', await field.inputValue());
});
