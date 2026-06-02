// Playwright-Test-Wrapper mit automatischem Console-Fehler-Guard.
//
// Drop-in-Ersatz fuer `require('@playwright/test')`: Specs importieren `test`
// und `expect` von hier statt direkt. Eine Auto-Fixture haengt vor jedem Test
// den Guard (console-guard.js) an die Page und ruft nach dem Test
// `assertClean()` — jeder unbehandelte Alpine-/Library-Fehler macht den Test
// rot, ohne dass jede Spec das selbst verdrahten muss.
//
// Zugriff im Test ueber die `consoleGuard`-Fixture, z.B. fuer Negativ-Tests:
//   test('...', async ({ page, consoleGuard }) => { consoleGuard.skip(); ... })
// oder zum Erlauben bekannter Meldungen:
//   consoleGuard.ignore(/erwartete Meldung/);

'use strict';

const base = require('@playwright/test');
const { attachConsoleGuard } = require('./console-guard');

const test = base.test.extend({
  consoleGuard: [
    async ({ page }, use, testInfo) => {
      const guard = attachConsoleGuard(page);
      await use(guard);
      // Nur asserten, wenn der Test bis hierher nicht ohnehin schon scheitert —
      // sonst ueberdeckt der Guard-Fehler die eigentliche Ursache.
      if (testInfo.status === testInfo.expectedStatus) {
        guard.assertClean();
      }
    },
    { auto: true },
  ],
});

module.exports = { test, expect: base.expect };
