// Collab über den Event-Stream, gegen die ECHTE App.
//
// WARUM DIESE SCHICHT: die Kette reicht vom Facade-Save über den Buch-Bus, das
// SSE-Abo mit Echo-Filter und ACL-Check bis zum Anstoss in app-collab-stream.js,
// der den bestehenden /changes-Read auslöst. Unit-Tests decken die Serverhälfte
// ab; ob der Browser das Abo wirklich hält und auf den Anstoss reagiert, sieht
// nur die gebootete App.
//
// Beweis, dass der STREAM geliefert hat und nicht ein Poll-Tick: die Collab-
// Timer werden vor dem Save angehalten (der Poll-Timer-Slot bleibt belegt,
// damit die Glue den Voll-Poll-Zweig nimmt). Ohne Stream käme die Änderung nie an.

const { test, expect } = require('@playwright/test');
const { bootApp, selectSeededBook } = require('./_helpers/app');

const OTHER_DEVICE = '9d0c3f4e-2b1a-4c5d-8e7f-0a1b2c3d4e5f';

test.describe('Collab: Event-Stream', () => {
  test.beforeEach(async ({ page }) => {
    await bootApp(page);
    await selectSeededBook(page);
  });

  test('Save eines Zweitgeräts erscheint ohne Poll-Tick als Baum-Marker', async ({ page }) => {
    const { bookId, pageId } = await page.evaluate(() => {
      const nav = window.Alpine.store('nav');
      const current = window.__app.currentPage?.id;
      const target = nav.pages.find(p => p.id !== current);
      return { bookId: Number(nav.selectedBookId), pageId: target.id };
    });

    // Buch-Abo bestätigt (`hello`) — dieselbe Modul-Instanz wie die App.
    await page.waitForFunction(async (id) => {
      const m = await import('/js/event-stream.js');
      return m.bookStreamOpen(id);
    }, bookId, { timeout: 15000 });

    // Zweitgerät meldet sich am Buch → Presence-Anstoss → Geräte-Zähler > 1 →
    // Voll-Poll startet und holt seine Baseline. Gleich auf der Zielseite: der
    // PUT unten pingt book_presence mit derselben page_id, das ist dann kein
    // Zustandswechsel mehr — übrig bleibt allein der `changed`-Anstoss.
    const ping = await page.request.post(`/content/books/${bookId}/device-ping`, {
      data: { device_id: OTHER_DEVICE, page_id: pageId },
    });
    expect(ping.ok()).toBeTruthy();
    await page.waitForFunction(() => {
      const c = window.Alpine.store('collab');
      return !!c._collabPollTimer && !!c._collabSince;
    }, null, { timeout: 15000 });

    // Timer anhalten: ab hier kann nur der Stream liefern.
    await page.evaluate(() => {
      const c = window.Alpine.store('collab');
      clearInterval(c._collabPollTimer);
      clearInterval(c._bookDevicePingTimer);
    });

    const save = await page.request.put(`/content/pages/${pageId}`, {
      data: { html: '<p>Vom Zweitgerät geschrieben.</p>', device_id: OTHER_DEVICE },
    });
    expect(save.ok()).toBeTruthy();

    await page.waitForFunction(
      (pid) => window.Alpine.store('collab').recentRemoteEdits.has(pid),
      pageId, { timeout: 5000 },
    );
    const meta = await page.evaluate((pid) => window.Alpine.store('collab').recentRemoteEdits.get(pid), pageId);
    expect(meta.isSelf).toBe(true);
  });
});
