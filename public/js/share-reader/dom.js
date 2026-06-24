'use strict';
// Geteilte DOM-Mini-Helfer für die Reader-Module (Standalone, kein Alpine).

export function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Reader-lokale Browserzeit (anonymer Leser, keine app.timezone-Setting).
export function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}
