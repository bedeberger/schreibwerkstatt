// Active-Editor-Lookup. Damit mode-agnostische Sub-Komponenten (Synonyme,
// Figuren-Lookup) den Ziel-Container finden, ohne `app.focusMode` abzufragen.
//
// Smart-Switch: wenn ein Focus-Cardroot (`.focus-editor`) im DOM existiert
// und der App-State `focusActive` meldet, gewinnt der Focus-Container.
// Sonst → Normal-Editor-Container. Solange Phase-4f den Focus-Cardroot noch
// nicht aktiviert hat, ist der Lookup verhaltens-identisch zum Pre-Refactor-
// Stand (`#editor-card .page-content-view--editing`).

const NORMAL_SELECTOR = '#editor-card .page-content-view--editing';
// Phase 4f-Marker: solange `.focus-editor` ohne `.is-active`, ist der
// Cardroot nur Skeleton (default x-show=false) und der Switch greift nicht.
const FOCUS_SELECTOR = '.focus-editor.is-active .page-content-view--editing';

// Liefert das contenteditable des aktiven Editors oder null, wenn kein
// Editor offen ist.
export function getActiveEditorContainer() {
  const app = typeof window !== 'undefined' ? window.__app : null;
  if (app?.focusActive) {
    const focusEl = document.querySelector(FOCUS_SELECTOR);
    if (focusEl) return focusEl;
  }
  return document.querySelector(NORMAL_SELECTOR);
}

// 'normal' | 'focus' | null. Beruht auf `focusActive` (Mirror auf focusMode,
// wird in Phase 4g zum alleinigen Flag). Bei aktivem Focus immer 'focus',
// auch wenn die Cardroot-Trennung (Phase 4f) noch nicht durchgezogen ist.
export function getActiveEditorMode() {
  const app = typeof window !== 'undefined' ? window.__app : null;
  if (!app) return null;
  if (app.focusActive) return 'focus';
  if (app.editMode) return 'normal';
  return null;
}
