// Lokale Draft-Persistenz für unsaved Edits im contenteditable-Editor.
// Eigenes Modul ohne browser-only Top-Level-Imports (page-view.js triggert
// `window.matchMedia` beim Laden) — so können auch reine Logik-Module wie
// app-view.js die Helper importieren, ohne dass Node-Tests am Window-Stub
// scheitern.

const DRAFT_KEY = (pageId) => `editor_draft_${pageId}`;

export function readDraft(pageId) {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(pageId));
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function writeDraft(pageId, html, originalHtml, originalUpdatedAt) {
  try {
    localStorage.setItem(DRAFT_KEY(pageId), JSON.stringify({
      html, originalHtml, originalUpdatedAt: originalUpdatedAt || null, savedAt: Date.now(),
    }));
  } catch { /* quota – ignoriert */ }
}

export function clearDraft(pageId) {
  try { localStorage.removeItem(DRAFT_KEY(pageId)); } catch {}
}
