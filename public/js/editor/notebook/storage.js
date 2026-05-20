// Snapshot des Notebook-Modus im sessionStorage. Pendant zu focus/storage.js:
// nach Reload (z.B. nach Session-Banner-Relogin oder manuelles F5) soll der
// Normal-Editor wieder geöffnet werden, wenn die ursprüngliche Seite geladen
// ist. sessionStorage = pro Tab/Fenster, überlebt F5 und OIDC-Redirect-
// Roundtrip, nicht aber Tab-Close.
//
// Der Snapshot enthält ausschliesslich `{ pageId, ts }` — er triggert das
// erneute Mounten der Editor-Session, nicht die Content-Wiederherstellung.
// Letztere läuft über den localStorage-Draft in `editor/draft-storage.js`
// (separater Mechanismus für unsavable Inhalte; persistiert pro Page).

const NORMAL_SNAPSHOT_KEY = 'normal.snapshot';
const NORMAL_SNAPSHOT_TTL_MS = 60 * 60 * 1000;

export function writeNormalSnapshot(pageId) {
  if (!pageId) return;
  try {
    sessionStorage.setItem(NORMAL_SNAPSHOT_KEY, JSON.stringify({ pageId, ts: Date.now() }));
  } catch {}
}

export function clearNormalSnapshot() {
  try { sessionStorage.removeItem(NORMAL_SNAPSHOT_KEY); } catch {}
}

export function readNormalSnapshot() {
  try {
    const raw = sessionStorage.getItem(NORMAL_SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !snap.pageId || !snap.ts) return null;
    if (Date.now() - snap.ts > NORMAL_SNAPSHOT_TTL_MS) {
      clearNormalSnapshot();
      return null;
    }
    return snap;
  } catch { return null; }
}
