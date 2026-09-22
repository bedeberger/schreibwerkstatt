// Abbildungs-Block im Seiten-HTML — SSoT fuer Markup, Selektoren, das Auslesen
// und das Zurueckschreiben. Jeder Pfad, der Abbildungen erzeugt, findet oder
// rendert, geht hier durch: das Slash-Menue und der Bild-Dialog im
// Notebook-Editor, der Mount ins contenteditable, die Leseansichten, der
// Share-Reader, die serverseitige Anker-Indexierung und alle Exportwege
// (HTML/EPUB/Markdown/TXT/PDF/DOCX/WP).
//
// Persistiertes Markup:
//
//   <figure data-bid="a1b2c3d4">
//     <img src="/content/page-image/42" alt="Ein Kaefer auf einem Blatt">
//     <figcaption>Der Kaefer</figcaption>
//     <p class="figure-credit">Foto: Keystone</p>
//   </figure>
//
// DREI FELDER MIT DREI AUFGABEN, und darum drei Traeger:
//
//   alt        — Ersatztext fuer alle, die das Bild nicht sehen (Screenreader,
//                EPUB-Accessibility-Metadaten, `<img>`-Fallback). Beschreibt das
//                Bild; steht NIE sichtbar im Satzspiegel.
//   figcaption — die Bildunterschrift. Text des Autors, Teil des Manuskripts,
//                Sprungziel des Querverweises, Eintrag im Abbildungsverzeichnis.
//   .figure-credit — der Bildnachweis („Foto: …", „Quelle: …"). Fachlich eine
//                eigene Angabe: im Journalismus konventionell von der Unterschrift
//                getrennt gesetzt, und im Abbildungsverzeichnis hat er nichts
//                verloren. Als Geschwister-Element der `<figcaption>` faellt er
//                aus `figcaption.textContent` von selbst heraus — die
//                Anker-Lesung (public/js/xrefs/xref-anchor.js) braucht dafuer
//                keine Ausnahme.
//
// DIE NUMMER GEHOERT NICHT IN DIE LEGENDE. In der `<figcaption>` steht der Text
// des Autors, nie „Abb. 3.2:". Die Nummer ist eine Eigenschaft des Ausgabewegs
// und entsteht bei jedem Export neu (lib/xref-render.js) — genau wie bei der
// Tabellenbeschriftung. In den Leseansichten zeigt sie ein Laufzeit-Badge, das
// nie persistiert wird (public/js/xrefs/caption-preview.js).
//
// KEIN MARKER-KLASSENNAME AM `<figure>`: jedes `<figure>` ist eine Abbildung.
// Import-Markup (DOCX/ODT/Blog) bringt `<figure>` ohne Klasse mit, und ein
// Marker haette daraus Buerger zweiter Klasse gemacht.
//
// Modul ist DOM-agnostisch (Browser-DOM wie linkedom auf dem Server) — darum
// genau eine Implementierung fuer beide Seiten, serverseitig per dynamic
// import() ueber lib/esm-bridge.js geladen (Muster wie table-html.js).

import { escHtml } from '../utils/escape.js';

export const FIGURE_SEL = 'figure';
export const FIGURE_CAPTION_SEL = 'figcaption';

// Der Bildnachweis braucht — anders als das `<figure>` selbst — einen Marker:
// ein `<p>` in einer Abbildung koennte sonst alles sein.
export const FIGURE_CREDIT_CLASS = 'figure-credit';
export const FIGURE_CREDIT_SEL = 'p.figure-credit';

/** Auf eine Zeile normalisierter Klartext. */
function _normText(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

/** Markup einer Abbildung aus dem Modell.
 *
 *  `src` ist Pflicht — ohne Bild keine Abbildung. Die `<figcaption>` wird immer
 *  angelegt (auch leer): sie ist der Schreibplatz fuer die Unterschrift, und
 *  ohne sie haette der Autor im Editor keinen Caret-Slot dafuer. Der
 *  Bildnachweis entsteht nur, wenn er gefuellt ist — ein leerer Absatz im
 *  Manuskript waere ein Artefakt. */
export function buildFigureHtml({ src, alt = '', caption = '', credit = '' } = {}) {
  const url = String(src || '').trim();
  if (!url) return '';
  const a = _normText(alt);
  const cap = String(caption ?? '');
  const cred = _normText(credit);
  const parts = ['<figure>'];
  parts.push(`<img src="${escHtml(url)}" alt="${escHtml(a)}">`);
  parts.push(`<figcaption>${cap ? escHtml(cap) : '<br>'}</figcaption>`);
  if (cred) parts.push(`<p class="${FIGURE_CREDIT_CLASS}">${escHtml(cred)}</p>`);
  parts.push('</figure>');
  return parts.join('');
}

/** Ist `el` eine Abbildung? */
export function isFigureEl(el) {
  return !!el && el.nodeType === 1 && el.tagName === 'FIGURE';
}

/** Naechstliegende Abbildung ab `node` aufwaerts, innerhalb von `root`. */
export function closestFigureEl(node, root) {
  let el = node?.nodeType === 1 ? node : node?.parentElement;
  while (el && el !== root) {
    if (isFigureEl(el)) return el;
    el = el.parentElement;
  }
  return null;
}

/** Modell einer bestehenden Abbildung — die Form, die der Bild-Dialog bearbeitet.
 *
 *  Die Unterschrift kommt bewusst NICHT mit: sie wird im Manuskript direkt
 *  getippt, nicht im Dialog. Wer sie hier mitfuehrte, muesste sie beim
 *  Uebernehmen zurueckschreiben und wuerde dabei Auszeichnung, Quellen-Chips und
 *  Querverweise in der Legende plattdruecken. */
export function figureModel(el) {
  if (!isFigureEl(el)) return null;
  const img = el.querySelector('img');
  const credit = el.querySelector(FIGURE_CREDIT_SEL);
  return {
    src: img?.getAttribute('src') || '',
    alt: img?.getAttribute('alt') || '',
    credit: credit ? _normText(credit.textContent) : '',
  };
}

/** Ersatztext und Bildnachweis einer bestehenden Abbildung setzen (in-place).
 *
 *  Der Bildnachweis steht immer als LETZTES Kind der Abbildung — hinter der
 *  Legende, wie er auch gesetzt wird. Ein leerer Nachweis entfernt das Element,
 *  statt es leer stehen zu lassen.
 *
 *  @returns {boolean} true, wenn sich etwas geaendert hat. */
export function applyFigureMeta(el, { alt = '', credit = '' } = {}) {
  if (!isFigureEl(el)) return false;
  const doc = el.ownerDocument || globalThis.document;
  let changed = false;

  const img = el.querySelector('img');
  if (img) {
    const next = _normText(alt);
    if ((img.getAttribute('alt') || '') !== next) {
      img.setAttribute('alt', next);
      changed = true;
    }
  }

  const next = _normText(credit);
  let node = el.querySelector(FIGURE_CREDIT_SEL);
  if (!next) {
    if (node) { node.remove(); changed = true; }
    return changed;
  }
  if (!node) {
    node = doc.createElement('p');
    node.className = FIGURE_CREDIT_CLASS;
    el.appendChild(node);
    changed = true;
  }
  if (_normText(node.textContent) !== next) {
    node.textContent = next;
    changed = true;
  }
  return changed;
}

// ── Editor-Laufzeit ─────────────────────────────────────────────────────────

/** Bildnachweise im contenteditable atomar machen: der Caret springt darueber,
 *  bearbeitet wird ausschliesslich im Bild-Dialog.
 *
 *  Warum nicht frei tippbar, obwohl die Legende daneben es ist: der Nachweis ist
 *  ein Feld mit fester Rolle, kein Fliesstext. Frei bearbeitbar waere er beim
 *  ersten Backspace an seiner Blockgrenze mit der Legende verschmolzen — und
 *  Chromium baeckt dabei die berechneten CSS-Werte als Inline-`style` ein, was
 *  nach der harten Regel „Styles nur in public/css" nicht in die Persistenz darf
 *  (dieselbe Begruendung wie bei Tabelle und Diagramm).
 *
 *  Die `<figcaption>` bleibt bewusst frei bearbeitbar: sie ist Manuskripttext
 *  und traegt Auszeichnung, Quellen-Chips und Querverweise.
 *
 *  Setzt nur Laufzeit-Attribute; `contenteditable` wird beim Speichern von
 *  lib/html-clean.js gestrippt und ist nie persistiert. */
export function markFiguresAtomic(root) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll(FIGURE_CREDIT_SEL)) {
    el.setAttribute('contenteditable', 'false');
  }
}
