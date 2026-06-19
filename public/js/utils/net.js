// Netzwerk- und Status-Helper: Fetch-Wrapper mit OK-Check + verzögerter
// Status-Reset.

/**
 * Fetch mit Pflicht-OK-Check und JSON-Parsing. Wirft bei HTTP-Fehlern,
 * damit der `.then(r => r.json())`-Pattern nicht stillschweigend HTML-
 * Fehlerseiten als JSON parst. 401 läuft durch den globalen fetch-Wrapper
 * in app.js (dispatcht `session-expired`) und wirft hier dann einen Fehler.
 */
export async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let detail = '';
    try { const e = await r.clone().json(); detail = e.error || e.message || ''; } catch (_) {}
    throw new Error(detail ? `HTTP ${r.status}: ${detail}` : `HTTP ${r.status}`);
  }
  return r.json();
}

/**
 * Löscht eine Alpine-Status-Property nach `delay`, wenn sie dann noch den
 * gesetzten Wert trägt. Verhindert, dass spätere Status-Updates durch einen
 * verzögerten Reset überschrieben werden – eigenes setTimeout-Idiom, das sich
 * an mehreren Stellen wiederholte.
 */
export function clearStatusAfter(obj, prop, expected, delay) {
  setTimeout(() => {
    if (obj[prop] === expected) obj[prop] = '';
  }, delay);
}

export async function fetchText(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
