// Failsafe-Reveal + Boot-Watchdog: löst das data-app-loading-Gate notfalls
// auch ohne erfolgreichen Alpine-Boot. Scheitert ein SW-Reload offline am
// frisch geleerten Modul-Cache, bricht der ESM-Import von app.js ab, init()
// entfernt das Attribut nie → Body bliebe unsichtbar (schwarz im
// Dark-Theme). Script-Load-Fehler (capture) + Timeout-Backstop geben dem
// User stattdessen die gecachte Shell inkl. Offline-Banner.
//
// Boot-Watchdog: bricht ein Modul-Fetch der app.js-Kaskade ab, ist KEINE
// Alpine-Komponente registriert (window.__app fehlt) und jede x-data-Expression
// wirft "X is not defined". Das ist transient (Deploy-/SW-Übergang, Netz-Blip)
// und heilt beim Reload. Darum: bei Boot-Script-Fehler genau EINMAL neu laden
// (sessionStorage-Guard gegen Loop). app.js#init() löscht das Flag nach
// erfolgreichem Boot — ein späterer Lazy-Load-Fehler löst dann keinen Reload aus.
//
// Externe Datei statt Inline-Script, damit CSP ohne 'unsafe-inline' auskommt.
// Klassisches Script (kein module/defer), läuft unabhängig vom ESM-Graphen.
(function () {
  var reveal = function () { document.documentElement.removeAttribute('data-app-loading'); };
  var RELOAD_KEY = 'bootReloadDone';
  setTimeout(reveal, 8000);
  window.addEventListener('error', function (e) {
    if (!(e && e.target && e.target.tagName === 'SCRIPT')) return;
    // Boot noch nicht erfolgt? → einmaliger Reload-Versuch gegen transiente
    // Fetch-Fehler. Beim zweiten Fehlschlag (Flag gesetzt) nur enthüllen.
    var alreadyTried = false;
    try { alreadyTried = !!sessionStorage.getItem(RELOAD_KEY); } catch (_) {}
    if (!window.__app && !alreadyTried) {
      try { sessionStorage.setItem(RELOAD_KEY, '1'); } catch (_) {}
      location.reload();
      return;
    }
    reveal();
  }, true);
})();
