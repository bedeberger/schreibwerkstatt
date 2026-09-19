'use strict';
// Reichweitenmessung: Nutzlast-Aufbereitung fuer Plausible.
//
// Beide Funktionen sind BEWUSST geschlossen (keine Referenz auf Modul-Scope,
// keine Pfeilfunktionen, ES5-Syntax): server.js bettet ihren Quelltext per
// `fn.toString()` woertlich in /js/plausible-init.js ein. Damit laeuft im
// Browser exakt das, was tests/unit/analytics-url.test.mjs hier prueft — eine
// zweite, handgeschriebene Kopie im Template koennte dagegen driften.

// Entfernt IDs aus der URL, die an Plausible gemeldet wird.
//
// Zwei Quellen, beide unbrauchbar bis schaedlich in der Auswertung:
//   - Der App-Hash traegt Buch- und Entitaets-IDs (`#book/42/figur/318`). Ohne
//     Normalisierung ist jede Buch-/Figur-Kombination eine eigene Seite und die
//     Seiten-Auswertung zerfaellt in tausende Ein-Treffer-Zeilen; die Frage,
//     welche Karten benutzt werden, ist daraus nicht zu beantworten.
//   - Der Share-Pfad traegt den Token (`/share/<token>`). Der Token IST der
//     Zugriffsschluessel auf den geteilten Text — er gehoert in keine Statistik.
//
// Was den Hash-Filter passiert, ist alles Nicht-Numerische; die Hash-Grammatik
// (app-hash-router/build.js#_computeHash) setzt ausschliesslich numerische
// Zeilen-IDs ein. Gegated durch die Invariante im Test: nach dem Lauf darf in
// keiner erzeugbaren URL eine Ziffernfolge als eigenes Segment stehen.
function normalizeAnalyticsUrl(raw) {
  var u;
  try { u = new URL(raw); } catch (e) { return raw; }
  u.pathname = u.pathname.replace(/^\/share\/[^/]+/, '/share');
  if (u.hash) {
    var kept = [];
    var segs = u.hash.slice(1).split('/');
    for (var i = 0; i < segs.length; i++) {
      if (segs[i] && !/^\d+$/.test(segs[i])) kept.push(segs[i]);
    }
    u.hash = kept.length ? '#' + kept.join('/') : '';
  }
  return u.toString();
}

// Baut die Properties einer Meldung. `base` kommt aus der Query der
// Bootstrap-URL (Oberflaeche, bei Share zusaetzlich der Umfang) und ist
// serverseitig allowlisted; `live` ist window.__plausibleProps, das die SPA
// pflegt (Buchtyp/Rolle/Modellklasse). Leere Werte fallen raus, statt als
// "(none)"-Zeile die Auswertung zu verwaessern.
function analyticsProps(base, live, doc, win) {
  var p = {};
  var k;
  for (k in base) { if (base[k]) p[k] = String(base[k]); }
  try {
    var lang = (doc.documentElement.getAttribute('lang') || '').slice(0, 2).toLowerCase();
    if (lang) p.sprache = lang;
  } catch (e) { /* noop */ }
  try {
    var standalone = (win.matchMedia && win.matchMedia('(display-mode: standalone)').matches)
      || win.navigator.standalone === true;
    p.anzeige = standalone ? 'pwa' : 'browser';
  } catch (e) { /* noop */ }
  if (live && typeof live === 'object') {
    for (k in live) {
      if (live[k] !== null && live[k] !== undefined && live[k] !== '') p[k] = String(live[k]);
    }
  }
  return p;
}

module.exports = { normalizeAnalyticsUrl, analyticsProps };
