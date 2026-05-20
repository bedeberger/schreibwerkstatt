// Active-Editor-Lookup. Damit mode-agnostische Sub-Komponenten (Synonyme,
// Figuren-Lookup) den Ziel-Container finden, ohne `app.focusMode` abzufragen.
//
// Phase-1: liefert den heutigen Container-Pfad zurück — `#editor-card
// .page-content-view--editing`. Solange Focus und Normal-Editor denselben
// DOM-Container teilen, ist `getActiveEditorMode` ein dünner Adapter auf das
// bestehende `focusMode`-Flag.
//
// Phase-4: wenn Focus seinen eigenen Cardroot bekommt, wählt diese Funktion
// dynamisch zwischen `.normal-editor .page-content-view--editing` und
// `.focus-editor .page-content-view--editing`. Sub-Komponenten ändern sich
// dadurch nicht.

const NORMAL_SELECTOR = '#editor-card .page-content-view--editing';

// Liefert das contenteditable des aktiven Editors oder null, wenn kein
// Editor offen ist.
export function getActiveEditorContainer() {
  return document.querySelector(NORMAL_SELECTOR);
}

// 'normal' | 'focus' | null. Phase-1 liest das globale `window.__app`.
// Phase-4 wechselt auf eine DOM-getriebene Erkennung (welcher Cardroot ist
// gemountet), sodass kein Karten-übergreifender Lookup mehr nötig ist.
export function getActiveEditorMode() {
  const app = typeof window !== 'undefined' ? window.__app : null;
  if (!app) return null;
  if (!app.editMode && !app.focusMode) return null;
  return app.focusMode ? 'focus' : 'normal';
}
