// HTML-Escape-Atome. Basis für die XSS-Escape-Invariante (siehe CLAUDE.md
// „x-html nur mit vorab-escaptem Content").

export function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// escHtml + Markdown-Fett-Marker entfernen. Lokale Modelle (v.a. ministral)
// streuen `**...**` inflationär in JSON-Felder; Rendern als <strong> wirkt
// überladen + Pairing bricht regelmässig. Darum nur strippen.
export function escMd(s) {
  return escHtml(String(s ?? '').replace(/\*\*/g, ''));
}

// Escapt alles außer <strong>…</strong> (BookStack-Search-Highlight).
// Verhindert XSS über preview_html, falls ein BookStack-User böswilligen
// HTML-Seitentitel/-Inhalt einschleust.
export function escPreserveStrong(s) {
  if (!s) return '';
  return escHtml(s)
    .replace(/&lt;strong&gt;/g, '<strong>')
    .replace(/&lt;\/strong&gt;/g, '</strong>');
}
