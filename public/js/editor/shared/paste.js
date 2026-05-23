// Geteilter Paste-/Copy-/Cut-Handler für alle drei Editoren (Notebook, Focus,
// Bucheditor). Behält nur Whitelist-Tags via sanitizePasteHtml; ohne Tag-
// Inhalt fällt auf Plain-Text zurück. Copy/Cut schreiben ausschliesslich
// text/plain — fremde Apps (Outlook, Word) bekommen keine Inline-Styles,
// Lektorat-Marks oder Custom-Klassen ins Clipboard.

import { sanitizePasteHtml } from '../../utils.js';

// Behandelt ein Paste-Event komplett: preventDefault, Sanitize, Insert.
// Rückgabe: true wenn etwas eingefügt wurde, false bei leerem Clipboard.
// Caller markiert anschliessend dirty (kann Block-spezifisch sein).
export function handleEditorPaste(e) {
  const cd = e.clipboardData;
  if (!cd) return false;
  e.preventDefault();

  const html = cd.getData('text/html');
  if (html) {
    const cleaned = sanitizePasteHtml(html);
    if (cleaned && /<[a-z]/i.test(cleaned)) {
      document.execCommand('insertHTML', false, cleaned);
      return true;
    }
    const text = cd.getData('text/plain') || (cleaned || '');
    if (text) {
      document.execCommand('insertText', false, text);
      return true;
    }
    return false;
  }
  const text = cd.getData('text/plain') || '';
  if (text) {
    document.execCommand('insertText', false, text);
    return true;
  }
  return false;
}

// Copy nur als text/plain. Rückgabe: true wenn Override aktiv wurde,
// false wenn keine Selektion (Browser-Default greift dann nicht, weil
// es nichts zu kopieren gibt).
export function handleEditorCopy(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const text = sel.toString();
  if (!text) return false;
  e.preventDefault();
  e.clipboardData.setData('text/plain', text);
  return true;
}

// Cut: text/plain ins Clipboard + Selektion löschen. Caller markiert
// anschliessend dirty.
export function handleEditorCut(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return false;
  const text = sel.toString();
  if (!text) return false;
  e.preventDefault();
  e.clipboardData.setData('text/plain', text);
  document.execCommand('delete');
  return true;
}
