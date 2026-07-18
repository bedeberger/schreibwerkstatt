// Lokale Draft-Persistenz für unsaved Edits im contenteditable-Editor.
// Eigenes Modul ohne browser-only Top-Level-Imports (page-view.js triggert
// `window.matchMedia` beim Laden) — so können auch reine Logik-Module wie
// app-view.js die Helper importieren, ohne dass Node-Tests am Window-Stub
// scheitern.
import { EVT } from '../events.js';

const DRAFT_PREFIX = 'editor_draft_';
const DRAFT_KEY = (pageId) => `${DRAFT_PREFIX}${pageId}`;

// Best-Effort-Signal für die Reconnect-Outbox + den Pending-Sync-Zähler, damit
// die App den Draft-Bestand nicht pollen muss. Laufzeit-guarded (nicht am
// Modul-Top-Level), damit reine Node-Tests dieses Modul ohne window importieren
// können.
function _emitDraftChanged() {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent(EVT.DRAFT_CHANGED));
    }
  } catch {}
}

export function readDraft(pageId) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(pageId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// Liefert true, wenn der Entwurf lokal persistiert wurde, sonst false (i.d.R.
// QuotaExceededError bei vollem localStorage). Der Aufrufer MUSS das Ergebnis
// prüfen und false sichtbar machen — ein still verworfener Offline-Entwurf ist
// echter Datenverlust (kein Server-Fallback, wenn offline).
export function writeDraft(pageId, html, originalHtml, originalUpdatedAt) {
  try {
    localStorage.setItem(DRAFT_KEY(pageId), JSON.stringify({
      html, originalHtml, originalUpdatedAt: originalUpdatedAt || null, savedAt: Date.now(),
    }));
    _emitDraftChanged();
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(pageId) {
  try {
    localStorage.removeItem(DRAFT_KEY(pageId));
    _emitDraftChanged();
  } catch {}
}

// Alle Seiten-IDs mit einem lokal gesicherten Entwurf. Ein vorhandener Draft
// bedeutet: lokaler Inhalt, der (noch) nicht bestätigt auf dem Server liegt —
// erfolgreiche Saves rufen clearDraft. Basis für die Reconnect-Outbox und den
// „N Seiten warten auf Sync"-Zähler.
export function listDraftPageIds() {
  const ids = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(DRAFT_PREFIX)) continue;
      const id = Number(key.slice(DRAFT_PREFIX.length));
      if (Number.isFinite(id) && id > 0) ids.push(id);
    }
  } catch {}
  return ids;
}
