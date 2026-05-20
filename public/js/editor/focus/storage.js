// Focus-Snapshot (sessionStorage): persistiert beim Eintritt in den Fokusmodus,
// damit ein Reload (z.B. nach Klick auf "neu verbinden" im Session-Banner) die
// Karte wieder öffnet, sobald die ursprüngliche Seite geladen ist.
// sessionStorage = pro Tab/Fenster, überlebt F5 und OIDC-Redirect-Roundtrip,
// nicht aber Tab-Close.

const FOCUS_SNAPSHOT_KEY = 'focus.snapshot';
const FOCUS_SNAPSHOT_TTL_MS = 60 * 60 * 1000;

export function writeFocusSnapshot(pageId) {
  if (!pageId) return;
  try {
    sessionStorage.setItem(FOCUS_SNAPSHOT_KEY, JSON.stringify({ pageId, ts: Date.now() }));
  } catch {}
}

export function clearFocusSnapshot() {
  try { sessionStorage.removeItem(FOCUS_SNAPSHOT_KEY); } catch {}
}

export function readFocusSnapshot() {
  try {
    const raw = sessionStorage.getItem(FOCUS_SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !snap.pageId || !snap.ts) return null;
    if (Date.now() - snap.ts > FOCUS_SNAPSHOT_TTL_MS) {
      clearFocusSnapshot();
      return null;
    }
    return snap;
  } catch { return null; }
}

