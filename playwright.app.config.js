// Full-SPA-Smoke gegen die ECHTE App (im Gegensatz zu playwright.config.js,
// das nur isolierte Fixture-Harnesses gegen einen Mock-Server faehrt).
//
// Bootet `node server.js` mit LOCAL_DEV_MODE=true: OAuth wird uebersprungen,
// eine Dev-Admin-Session automatisch gesetzt (server.js), und lib/dev-seed.js
// legt auf der frischen Wegwerf-DB ein Kafka-Testbuch mit Kapiteln/Seiten an.
// So laeuft die komplette SPA inkl. Alpine-Template-Baum ohne Login- oder
// KI-Key-Infrastruktur. Der Smoke oeffnet jede Karte + alle drei Editoren und
// prueft, dass dabei kein unbehandelter Alpine-/Library-Fehler auftritt.
//
// DB_PATH zeigt auf eine Wegwerf-Datei unter tests/.tmp/ (vorab geloescht →
// jeder Lauf seedet frisch). PORT/SESSION_SECRET sind smoke-eigene Werte,
// damit ein parallel laufender Dev-Server (3737) unberuehrt bleibt.

const DB = './tests/.tmp/smoke.db';
const PORT = 8766;

module.exports = {
  testDir: './tests/e2e-app',
  testMatch: '**/*.spec.js',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1280, height: 900 },
    navigationTimeout: 45000,
    actionTimeout: 30000,
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
  webServer: {
    // DB vor dem Boot loeschen (inkl. -wal/-shm), damit dev-seed greift.
    command: `rm -f ${DB} ${DB}-wal ${DB}-shm && DB_PATH=${DB} LOCAL_DEV_MODE=true LOCAL_DEV_SEED=true PORT=${PORT} SESSION_SECRET=smoke-secret-do-not-use-in-prod node server.js`,
    // Kein dedizierter Health-Endpoint — in LOCAL_DEV_MODE liefert `/` die SPA
    // (Auth-Guard via Dev-Session gebypasst), reicht als Readiness-Signal.
    url: `http://localhost:${PORT}/`,
    timeout: 60000,
    reuseExistingServer: !process.env.CI,
    stdout: 'pipe',
    stderr: 'pipe',
  },
};
