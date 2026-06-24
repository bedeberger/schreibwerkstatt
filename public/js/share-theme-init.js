// Reader-Theme vor erstem Paint setzen (FOUC-Schutz). Eigener localStorage-Key,
// weil der Reader anonym/standalone ist (kein App-Login). Präferenz:
// 'auto' (folgt System via prefers-color-scheme), 'light', 'dark'.
// Bei 'auto' wird KEIN data-theme gesetzt → die CSS-Media-Query greift.
// Externe Datei statt Inline-Script, damit CSP ohne 'unsafe-inline' auskommt.
(function () {
  var KEY = 'sw_share_theme';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  var pref = (stored === 'light' || stored === 'dark') ? stored : 'auto';
  if (pref === 'light' || pref === 'dark') document.documentElement.setAttribute('data-theme', pref);
  else document.documentElement.removeAttribute('data-theme');
  window.__shareThemePref = pref;
})();
