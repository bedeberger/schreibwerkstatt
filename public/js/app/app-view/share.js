// Teil von appViewMethods (siehe Facade app-view.js).
import { EVT, EXCLUSIVE_CARDS } from './_shared.js';

export const shareMethods = {

  // Share-Link-Karte mit Prefill öffnen. Buttons im Notebook-Editor (page) und
  // im Sidebar-Kapitel-Header (chapter) rufen das auf, damit das Create-Form
  // direkt auf das richtige Target vorgesetzt ist. Sub-Komponente liest
  // `_shareLinksPrefill` in `onShow` und cleared.
  async openShareLinksForPage(pageId) {
    if (!pageId) return;
    this._shareLinksPrefill = { kind: 'page', id: pageId };
    if (!this.showShareLinksCard) {
      this._captureShareReturn();
      await this.toggleShareLinksCard();
    } else {
      window.dispatchEvent(new CustomEvent(EVT.SHARE_PREFILL, { detail: { kind: 'page', id: pageId } }));
      this._scrollToCardByKey('shareLinks');
    }
  },

  async openShareLinksForChapter(chapterId) {
    if (!chapterId) return;
    this._shareLinksPrefill = { kind: 'chapter', id: chapterId };
    if (!this.showShareLinksCard) {
      this._captureShareReturn();
      await this.toggleShareLinksCard();
    } else {
      window.dispatchEvent(new CustomEvent(EVT.SHARE_PREFILL, { detail: { kind: 'chapter', id: chapterId } }));
      this._scrollToCardByKey('shareLinks');
    }
  },

  // Ganzes Buch teilen (Trigger: Quick-Action in der Buch-Uebersicht). Kein
  // Ziel-Picker noetig — der Server zieht book_id aus dem aktiven Buch.
  async openShareLinksForBook() {
    this._shareLinksPrefill = { kind: 'book' };
    if (!this.showShareLinksCard) {
      this._captureShareReturn();
      await this.toggleShareLinksCard();
    } else {
      window.dispatchEvent(new CustomEvent(EVT.SHARE_PREFILL, { detail: { kind: 'book' } }));
      this._scrollToCardByKey('shareLinks');
    }
  },


  // Vor dem Öffnen der Teilen-Karte die aktuelle Ansicht festhalten, damit der
  // "Schliessen"-Button dorthin zurückkehrt statt auf der Buchübersicht zu
  // landen. `toggleShareLinksCard` ruft danach `_closeOtherMainCards` → die
  // Ansicht ist nach dem Toggle weg, deshalb Snapshot hier. Transienter
  // Private analog `_shareLinksPrefill`.
  _captureShareReturn() {
    if (this.currentPage?.id) {
      this._shareReturn = { kind: 'page', id: this.currentPage.id };
    } else if (this.showKapitelReviewCard && this.kapitelReviewChapterId) {
      this._shareReturn = { kind: 'kapitelReview', id: this.kapitelReviewChapterId };
    } else {
      const openCard = EXCLUSIVE_CARDS.find(c => c.key !== 'shareLinks' && this[c.flag]);
      this._shareReturn = openCard ? { kind: 'card', key: openCard.key } : null;
    }
  },


  // Teilen-Karte schliessen und zur Ausgangsansicht zurückkehren (Seite,
  // Kapitelbewertung oder andere Hauptkarte). Ohne festgehaltenes Ziel fällt
  // es auf die Buchübersicht zurück.
  async closeShareLinks() {
    this.showShareLinksCard = false;
    const ret = this._shareReturn;
    this._shareReturn = null;
    if (ret?.kind === 'page') {
      const page = (this.pages || []).find(p => p.id === ret.id);
      if (page) { await this.selectPage(page); return; }
    } else if (ret?.kind === 'kapitelReview') {
      await this.openKapitelReviewForChapter(ret.id);
      return;
    } else if (ret?.kind === 'card') {
      const entry = EXCLUSIVE_CARDS.find(c => c.key === ret.key);
      if (entry && !this[entry.flag] && typeof this[entry.toggle] === 'function') {
        await this[entry.toggle]();
        return;
      }
    }
    if (this.selectedBookId && !this.showEditorCard && !this.showBookStatsCard) {
      await this.toggleBookStatsCard();
      return;
    }
    await this._maybeOpenBookOverview();
  },
};
