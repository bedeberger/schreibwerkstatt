// Werfensfreier Zugriff auf localStorage. Jeder Griff kann werfen: Safari
// Private Mode und blockierte Site-Daten schon beim Lesen von `localStorage`
// selbst, ein voller Speicher (QuotaExceededError) beim Schreiben — und der
// Speicher füllt sich hier real, weil Offline-Entwürfe ganze Seiten-HTMLs
// halten (editor/draft-storage.js). Ein ungeschützter Griff in einer
// Alpine-`data()`-Factory lässt die ganze Karte ausfallen, einer direkt nach
// einem Job-Start bricht das Polling ab, obwohl der Job auf dem Server läuft.
//
// Persistenz ist hier immer Komfort: wer nicht schreiben kann, verliert eine
// Ansichtswahl, nie einen Arbeitsstand. Wo ein fehlgeschlagener Write echter
// Datenverlust ist (Entwürfe), prüft der Aufrufer den Rückgabewert von lsSet.

function store() {
  try { return globalThis.localStorage || null; } catch { return null; }
}

export function lsGet(key) {
  try { return store()?.getItem(key) ?? null; } catch { return null; }
}

// true = geschrieben, false = kein Speicher / Quota voll.
export function lsSet(key, value) {
  const s = store();
  if (!s) return false;
  try { s.setItem(key, String(value)); return true; } catch { return false; }
}

export function lsRemove(key) {
  try { store()?.removeItem(key); } catch { /* nichts zu räumen */ }
}

export function lsGetJSON(key, fallback = null) {
  const raw = lsGet(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function lsSetJSON(key, value) {
  let raw;
  try { raw = JSON.stringify(value); } catch { return false; }
  return lsSet(key, raw);
}

// Alle Schlüssel mit `prefix`. Snapshot statt Live-Iteration, damit ein
// Aufrufer während der Schleife entfernen darf.
export function lsKeys(prefix = '') {
  const s = store();
  const out = [];
  if (!s) return out;
  try {
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* Teilergebnis reicht */ }
  return out;
}
