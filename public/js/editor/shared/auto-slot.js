// Trailing-Paragraph-Slot. Auf frischen Seiten liefert der Server `<p></p>`
// ohne Kinder; in Chrome ist eine kindlose <p> zero-height, der Caret rendert
// nicht und `beforeinput` routet ins Leere. Der Slot ergänzt `<br>` als
// Schreib-Anker. Single source für Normal-Editor (startEdit) und
// Focus-Editor (jumpToTrailingParagraph) — Phase-2-Konsolidierung der heute
// doppelten Pfade.
//
// `cleanPageHtml` auf der Server-Seite strippt `<p><br></p>` beim Save wieder
// raus, daher kein Persistenz-Effekt.

export function isEmptyParagraph(el) {
  if (!el || el.tagName !== 'P') return false;
  const txt = (el.textContent || '').replace(/ /g, ' ').trim();
  return txt === '';
}

// Stellt sicher, dass der letzte Block ein `<p>` mit einem `<br>` als Caret-
// Slot ist. Recycelt bestehenden leeren `<p>`, hängt sonst einen neuen an.
// Liefert das neu erzeugte Element zurück (oder null bei Recycle) — damit
// der Aufrufer beim Exit gezielt aufräumen kann, ohne blind den letzten
// Block zu killen.
export function ensureTrailingParagraph(container) {
  if (!container) return null;
  const doc = container.ownerDocument || globalThis.document;
  const last = container.lastElementChild;
  if (isEmptyParagraph(last)) {
    if (!last.hasChildNodes()) last.appendChild(doc.createElement('br'));
    return null;
  }
  const p = doc.createElement('p');
  p.appendChild(doc.createElement('br'));
  container.appendChild(p);
  return p;
}

// Entfernt einen zuvor via ensureTrailingParagraph erzeugten Slot wieder,
// sofern er nach wie vor leer ist. Wurde der Slot zwischenzeitlich befüllt
// (User hat in den Slot geschrieben), bleibt er stehen.
export function removeAutoAddedParagraph(added) {
  if (!added) return;
  if (!added.parentNode) return;
  if (added.tagName !== 'P') return;
  const txt = (added.textContent || '').replace(/ /g, ' ').trim();
  if (txt !== '') return;
  added.parentNode.removeChild(added);
}
