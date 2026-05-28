// Failsafe-Reveal: löst das data-app-loading-Gate notfalls auch ohne
// erfolgreichen Alpine-Boot. Scheitert ein SW-Reload offline am frisch
// geleerten Modul-Cache, bricht der ESM-Import von app.js ab, init()
// entfernt das Attribut nie → Body bliebe unsichtbar (schwarz im
// Dark-Theme). Script-Load-Fehler (capture) + Timeout-Backstop geben dem
// User stattdessen die gecachte Shell inkl. Offline-Banner.
//
// Externe Datei statt Inline-Script, damit CSP ohne 'unsafe-inline' auskommt.
// Klassisches Script (kein module/defer), läuft unabhängig vom ESM-Graphen.
(function () {
  var reveal = function () { document.documentElement.removeAttribute('data-app-loading'); };
  setTimeout(reveal, 8000);
  window.addEventListener('error', function (e) {
    if (e && e.target && e.target.tagName === 'SCRIPT') reveal();
  }, true);
})();
