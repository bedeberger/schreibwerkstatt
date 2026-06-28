import { EVT } from '../../events.js';

// Globaler fetch-Wrapper: fängt 401-Antworten ab und signalisiert Session-Ablauf
// via SESSION_EXPIRED-Event. Alpine zeigt daraufhin einen Banner. Kein Auto-
// Redirect – User soll ungespeicherte Änderungen (Editor, Chat) retten können.
export function installFetchGuard() {
  const origFetch = window.fetch.bind(window);
  window.fetch = async function(...args) {
    const res = await origFetch(...args);
    if (res.status === 401 && !window.__sessionExpiredNotified) {
      window.__sessionExpiredNotified = true;
      window.dispatchEvent(new CustomEvent(EVT.SESSION_EXPIRED));
    }
    return res;
  };
}
