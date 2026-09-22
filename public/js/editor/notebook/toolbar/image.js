// Bild-Dialog des Notebook-Editors: Ersatztext (alt) und Bildnachweis einer
// bereits eingefuegten Abbildung.
//
// WARUM EIN DIALOG UND KEIN INLINE-FELD: beide Angaben sind Felder mit fester
// Rolle, kein Fliesstext. Der Ersatztext hat im Satzspiegel ueberhaupt keine
// Darstellung (er lebt im `alt`-Attribut) — ohne Dialog gaebe es keinen Weg, ihn
// zu setzen. Der Bildnachweis ist zwar sichtbar, aber als atomarer Block
// (markFiguresAtomic) gegen das Verschmelzen an der Blockgrenze geschuetzt;
// bearbeitet wird er deshalb hier. Die Bildunterschrift dagegen wird NICHT hier
// gepflegt: sie ist Manuskripttext, wird direkt in der `<figcaption>` getippt
// und traegt Auszeichnung, Quellen-Chips und Querverweise, die ein Textfeld
// plattdruecken wuerde.
//
// Aufbau wie der Tabellen-Dialog: Karten-Scope (editorToolbarCard), also `x-ref`
// + showModal() statt des `modal()`-Primitivs, und `@close` ist der EINZIGE
// Aufraeumpunkt — ESC, Backdrop und Abbrechen laufen alle durch `dlg.close()`.
//
// EINGABE IST NOTEBOOK-ONLY (wie Tabelle und Diagramm). Focus-Editor und
// Bucheditor stellen Abbildungen nur dar.

import { getEditEl } from '../../utils.js';
import { applyFigureMeta, figureModel, markFiguresAtomic } from '../../../figure/figure-html.js';

export const imageMethods = {
  /** `el` ist eine bestehende `<figure>` im Manuskript. Einen Einfuege-Weg gibt
   *  es hier nicht — die Abbildung entsteht im Slash-Menue (Datei-Dialog), und
   *  ohne Bild gaebe es nichts zu beschreiben. */
  openImageForEl(el) {
    const m = figureModel(el);
    if (!m) return;
    this._imageEl = el;
    this.imageSrc = m.src;
    this.imageAlt = m.alt;
    this.imageCredit = m.credit;
    const dlg = this.$refs?.imageDlg;
    if (!dlg) return;
    if (!dlg.open) dlg.showModal();
    queueMicrotask(() => this.$refs?.imageAltInput?.focus());
  },

  closeImageDialog() {
    this.$refs?.imageDlg?.close();
  },

  /** Einziger Aufraeumpunkt (siehe Modulkopf). */
  onImageDialogClose() {
    this._imageEl = null;
    this.imageSrc = '';
    this.imageAlt = '';
    this.imageCredit = '';
    getEditEl()?.focus();
  },

  /** Uebernehmen. `applyFigureMeta` meldet, ob sich etwas geaendert hat — ohne
   *  Aenderung bleibt die Seite sauber, statt allein vom Oeffnen des Dialogs
   *  dirty zu werden. */
  applyImageMeta() {
    const el = this._imageEl;
    if (el?.isConnected) {
      const changed = applyFigureMeta(el, { alt: this.imageAlt, credit: this.imageCredit });
      if (changed) {
        // Ein frisch angelegter Bildnachweis ist noch frei bearbeitbar — das
        // Laufzeit-Attribut setzt sonst erst der naechste Mount.
        markFiguresAtomic(el);
        window.__app?._markEditDirty?.();
      }
    }
    this.closeImageDialog();
  },

  /** Abbildung loeschen. Das `<img>` ist ein void-Element und damit kein
   *  Loeschziel fuer Backspace (harte Regel „Loeschen an Blockgrenzen") — ohne
   *  diesen Weg bliebe nur, die Legende zu leeren und die Abbildung stehen zu
   *  lassen. */
  removeImage() {
    const el = this._imageEl;
    if (el?.isConnected) {
      el.remove();
      window.__app?._markEditDirty?.();
    }
    this.closeImageDialog();
  },
};
