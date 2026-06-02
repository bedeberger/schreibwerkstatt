// Console-/Runtime-Fehler-Guard fuer Playwright. Sammelt waehrend eines Tests
// alle unbehandelten Browser-Fehler und macht den Test rot, wenn welche
// uebrig bleiben, die nicht auf der Allowlist stehen.
//
// Warum das die wichtigste Sicherung gegen Alpine-/Library-Brueche ist:
// Alpine 3 wirft Expression-Fehler (Tippfehler in x-data, undefinierte
// Methode im Template, kaputte x-effect-Expression) NICHT hart — es loggt
// "Alpine Expression Error" via console.warn und re-throwt via
// `setTimeout(() => { throw error })`. Dieser asynchrone Throw landet als
// uncaught error → `page.on('pageerror')`. Zusaetzlich faengt die console.warn-
// Spur den Fall ab, falls ein Browser den Re-Throw mal nicht als pageerror
// meldet. Beide Kanaele werden hier abgehoert.
//
// Default-Allowlist deckt Netzwerk-Rauschen ab (fehlende Mock-Routen, 401 aus
// Fire-and-forget-Telemetrie, benigne ResizeObserver-Schleifen). Specs koennen
// die Liste pro Lauf erweitern (`guard.ignore(/.../)`) oder die Assertion
// fuer Negativ-Tests abschalten (`guard.skip()`).

'use strict';

const DEFAULT_ALLOW = [
  /favicon/i,
  /Failed to load resource/i,
  /net::ERR_/i,
  /the server responded with a status of (401|403|404)/i,
  /ResizeObserver loop/i,
  // Service-Worker-Registrierung scheitert ueber file/mock-Server — irrelevant.
  /ServiceWorker|service worker/i,
];

// Marker, an denen Alpine seine (sonst stillen) Expression-/Warn-Fehler
// in der Konsole ausgibt. console.warn-Eintraege ohne diese Marker zaehlen
// NICHT als Fehler (sonst wuerde jede legitime Warnung den Test brechen).
const ALPINE_WARN_MARKERS = [
  /Alpine Expression Error/i,
  /Alpine Warn/i,
  /Alpine Error/i,
];

function attachConsoleGuard(page, opts = {}) {
  const allow = [...DEFAULT_ALLOW, ...(opts.allow || [])];
  const errors = [];
  let enabled = true;

  function record(channel, text, detail) {
    if (!enabled) return;
    errors.push({ channel, text: String(text || ''), detail });
  }

  page.on('pageerror', (err) => {
    record('pageerror', err && err.message ? err.message : String(err), err && err.stack);
  });

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      record('console.error', text);
    } else if (type === 'warning' && ALPINE_WARN_MARKERS.some((re) => re.test(text))) {
      record('alpine.warn', text);
    }
  });

  function unmatched() {
    return errors.filter((e) => !allow.some((re) => re.test(e.text)));
  }

  return {
    errors,
    allow,
    ignore(re) { allow.push(re); return this; },
    skip() { enabled = false; return this; },
    resume() { enabled = true; return this; },
    unmatched,
    assertClean(label = '') {
      if (!enabled) return;
      const bad = unmatched();
      if (bad.length === 0) return;
      const lines = bad.map((e) => `  [${e.channel}] ${e.text}${e.detail ? '\n    ' + String(e.detail).split('\n').slice(0, 4).join('\n    ') : ''}`);
      throw new Error(
        `${bad.length} unerwartete(r) Browser-Fehler${label ? ' bei ' + label : ''}:\n${lines.join('\n')}`,
      );
    },
  };
}

module.exports = { attachConsoleGuard, DEFAULT_ALLOW, ALPINE_WARN_MARKERS };
