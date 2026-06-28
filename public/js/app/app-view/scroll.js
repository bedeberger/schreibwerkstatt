// Teil von appViewMethods (siehe Facade app-view.js).
import { EXCLUSIVE_CARDS } from './_shared.js';

export const scrollMethods = {

  // Scroll-Ziel beim Karten-Öffnen: Mobile (<960px, einspaltig) → Karte
  // ins Viewport, sonst sieht User den Tree statt der frisch geöffneten Karte.
  // Desktop (>=960px, zweispaltig) → Window-Top, da Karten in eigener Spalte.
  _scrollToCardEl(el) {
    const isMobile = window.matchMedia('(max-width: 959.98px)').matches;
    if (isMobile && el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  },

  _scrollToEditorCard() {
    this._scrollToCardEl(document.getElementById('editor-card'));
  },


  // Scrollt zur Karte mit `key` (aus EXCLUSIVE_CARDS). Pflicht: vom Aufrufer
  // erst aufrufen, nachdem Partial geladen UND Flag gesetzt ist — sonst hat
  // das `x-show`-Element noch keine DOM-Repräsentation.
  _scrollToCardByKey(key) {
    const target = EXCLUSIVE_CARDS.find(c => c.key === key);
    if (!target || typeof this.$nextTick !== 'function') return;
    this.$nextTick(() => {
      this._scrollToCardEl(document.querySelector(`[x-show="$app.${target.flag}"]`));
    });
  },
};
