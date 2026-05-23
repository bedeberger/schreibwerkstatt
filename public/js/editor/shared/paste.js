// Geteilter Paste-/Copy-/Cut-Handler für alle drei Editoren (Notebook, Focus,
// Bucheditor). Behält nur Whitelist-Tags via sanitizePasteHtml; ohne Tag-
// Inhalt fällt auf Plain-Text zurück. Copy/Cut schreiben ausschliesslich
// text/plain — fremde Apps (Outlook, Word) bekommen keine Inline-Styles,
// Lektorat-Marks oder Custom-Klassen ins Clipboard.

import { sanitizePasteHtml } from '../../utils.js';

// Heuristik: Plain-Text mit ≥3 Zeilen, die zu ≥60% wie `key: value` /
// `key = value` aussehen → Konfigurations-/Code-Paste. Wrap in <pre>, damit
// User die Block-Struktur nicht manuell wiederherstellen muss (sonst wird jede
// Zeile zu einem <p> mit Erstzeilen-Einzug).
const _KV_LINE = /^\s*[A-Za-z_][\w.-]*\s*[:=]\s*\S/;

function _looksLikeConfigBlock(text) {
  if (!text || !text.includes('\n')) return false;
  const lines = text.split(/\n/);
  const nonEmpty = lines.filter(l => l.trim().length > 0);
  if (nonEmpty.length < 3) return false;
  const kvCount = nonEmpty.filter(l => _KV_LINE.test(l)).length;
  return kvCount >= 3 && (kvCount / nonEmpty.length) >= 0.6;
}

function _escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Behandelt ein Paste-Event komplett: preventDefault, Sanitize, Insert.
// Rückgabe: true wenn etwas eingefügt wurde, false bei leerem Clipboard.
// Caller markiert anschliessend dirty (kann Block-spezifisch sein).
export function handleEditorPaste(e) {
  const cd = e.clipboardData;
  if (!cd) return false;
  e.preventDefault();

  const plain = cd.getData('text/plain') || '';
  if (_looksLikeConfigBlock(plain)) {
    document.execCommand('insertHTML', false, `<pre>${_escapeHtml(plain)}</pre>`);
    return true;
  }

  const html = cd.getData('text/html');
  if (html) {
    const cleaned = sanitizePasteHtml(html);
    if (cleaned && /<[a-z]/i.test(cleaned)) {
      document.execCommand('insertHTML', false, cleaned);
      return true;
    }
    const text = plain || (cleaned || '');
    if (text) {
      document.execCommand('insertText', false, text);
      return true;
    }
    return false;
  }
  if (plain) {
    document.execCommand('insertText', false, plain);
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
