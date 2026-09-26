// Schliessen bei Scroll/Resize für JS-positionierte Popover und Kontextmenüs.
//
// Die Menüs sind `position: fixed` und am Trigger bzw. Cursor verankert — sie
// scrollen nicht mit ihrem Ziel mit. Beim Scrollen (Capture: auch in inneren
// Scroll-Containern) oder Resize stünden sie sonst über einem fremden Eintrag.
//
//   open()  { this._menuDismiss ??= attachDismiss(() => this.closeMenu()); }
//   close() { this._menuDismiss?.abort(); this._menuDismiss = null; }
//
// Rückgabe ist der AbortController: `abort()` meldet alle Listener in einem
// Schritt ab. Optionen:
//   scroll: false — nur Resize (z.B. Picker mit Combobox: deren Listen-Scroll
//                   würde den Picker sonst mitten in der Auswahl schliessen)
//   events: [EVT.X, …] — zusätzliche Window-Events, die ebenfalls schliessen

export function attachDismiss(onClose, { scroll = true, events = [] } = {}) {
  const ctrl = new AbortController();
  const { signal } = ctrl;
  const handler = () => onClose();
  if (scroll) window.addEventListener('scroll', handler, { capture: true, passive: true, signal });
  window.addEventListener('resize', handler, { signal });
  for (const type of events) window.addEventListener(type, handler, { signal });
  return ctrl;
}

/** Controller in `ctx[key]` abbrechen und das Feld leeren. */
export function detachDismiss(ctx, key) {
  if (!ctx[key]) return;
  ctx[key].abort();
  ctx[key] = null;
}
