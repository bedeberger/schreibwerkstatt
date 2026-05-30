// E2E-Smoke-Test für die epubExportCard (eigene Karte; war früher inline im
// Publikation-Tab der bookSettingsCard). Lädt das Harness, mockt
// /jobs/epub-export* in tests/server.js und prüft, dass der Export-Button den
// Job startet, pollt und die EPUB-Datei als Download auslöst.

const { test, expect } = require('@playwright/test');

test.describe('epub-export-card', () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post('http://localhost:8765/__mock/publication-reset');
    await page.goto('http://localhost:8765/tests/fixtures/epub-export-harness.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__harnessReady === true);
  });

  test('Export-Button löst EPUB-Download aus', async ({ page }) => {
    const exportBtn = page.locator('.card-header button.primary', { hasText: 'Exportieren' });
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15000 }),
      exportBtn.click(),
    ]);
    expect(download.suggestedFilename()).toBe('book.epub');
  });
});
