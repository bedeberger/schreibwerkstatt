// Teil von appViewMethods (siehe Facade app-view.js).
import { fetchJson } from './_shared.js';

export const badgesMethods = {

  // Lädt Badge-Counts (offene Ideen, Chat-Sessions) für die geöffnete Seite.
  // Race-safe: prüft pageId gegen aktuelle Seite vor Set, falls User schnell wechselt.
  async _loadPageBadgeCounts(pageId) {
    try {
      const [ideen, sessions] = await Promise.all([
        fetchJson(`/ideen?page_id=${pageId}`).catch(() => []),
        fetchJson(`/chat/sessions/${pageId}`).catch(() => []),
      ]);
      if (this.currentPage?.id !== pageId) return;
      const openCount = (Array.isArray(ideen) ? ideen : []).filter(i => !i.erledigt).length;
      this.currentPageIdeenOpenCount = openCount;
      // Recherche-Count aus der buchweit geladenen Map (kein Extra-Request);
      // wird bei Link-Änderungen in der Recherche-Karte frisch gehalten.
      this.currentPageRechercheCount = (this.rechercheCounts || {})[pageId] || 0;
      // Plot-Beat-Count ebenfalls aus der buchweit geladenen Map (kein Extra-Request).
      this.currentPagePlotBeatCount = (this.plotBeatCounts || {})[pageId] || 0;
      this.currentPageShareCommentCount = (this.shareCommentCounts || {})[pageId] || 0;
      this.currentPageShareLinkCount = (this.shareLinkCounts || {})[pageId] || 0;
      this.currentPageChatSessionCount = (Array.isArray(sessions) ? sessions : []).length;
      // Tree-Indikator mit frischer Wahrheit syncen (z.B. bei Cross-Tab-Edits).
      const next = { ...(this.ideenCounts || {}) };
      if (openCount > 0) next[pageId] = openCount;
      else delete next[pageId];
      this.ideenCounts = next;
    } catch (e) {
      console.error('[loadPageBadgeCounts]', e);
    }
  },


  // Pro-Seite-Map offener Reviewer-Kommentare neu laden (nach Resolve/Delete in
  // der Share-Karte) und den Badge der offenen Seite syncen.
  async refreshShareCommentCounts() {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetchJson(`/share/api/page-comment-counts?book_id=${bookId}`).catch(() => null);
      if (!map || this.selectedBookId !== bookId) return;
      this.shareCommentCounts = map;
      if (this.currentPage?.id) this.currentPageShareCommentCount = map[this.currentPage.id] || 0;
    } catch (e) {
      console.error('[refreshShareCommentCounts]', e);
    }
  },


  // Page- + Chapter-Map verknüpfter Plot-Beats neu laden (nach Kapitel-/Verwerfen-/
  // Lösch-Änderung in der Plot-Karte) und den Editor-Badge der offenen Seite
  // syncen. Beats hängen am Kapitel → Page-Count ist kapitelweit projiziert,
  // die Kapitelansicht liest chapterPlotBeatCounts direkt.
  async refreshPlotBeatCounts() {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    try {
      const [pageMap, chapterMap] = await Promise.all([
        fetchJson(`/plot/page-beat-counts?book_id=${bookId}`).catch(() => null),
        fetchJson(`/plot/chapter-beat-counts?book_id=${bookId}`).catch(() => null),
      ]);
      if (this.selectedBookId !== bookId) return;
      if (pageMap) {
        this.plotBeatCounts = pageMap;
        if (this.currentPage?.id) this.currentPagePlotBeatCount = pageMap[this.currentPage.id] || 0;
      }
      if (chapterMap) this.chapterPlotBeatCounts = chapterMap;
    } catch (e) {
      console.error('[refreshPlotBeatCounts]', e);
    }
  },


  // Pro-Seite-Map aktiver Share-Links neu laden (nach Create/Revoke in der
  // Share-Karte) und den „Teilen"-Badge der offenen Seite syncen.
  async refreshShareLinkCounts() {
    const bookId = this.selectedBookId;
    if (!bookId) return;
    try {
      const map = await fetchJson(`/share/api/page-link-counts?book_id=${bookId}`).catch(() => null);
      if (!map || this.selectedBookId !== bookId) return;
      this.shareLinkCounts = map;
      if (this.currentPage?.id) this.currentPageShareLinkCount = map[this.currentPage.id] || 0;
    } catch (e) {
      console.error('[refreshShareLinkCounts]', e);
    }
  },
};
