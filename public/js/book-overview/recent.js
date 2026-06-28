// Recent-Pages-Tile: zuletzt geöffnete Seiten + Zeichen-Badge.
export const recentMethods = {
  overviewRecentPages() {
    const recent = this.overviewRecent || [];
    const pages = Alpine.store('nav').pages || [];
    return this._memo('recentPages', [recent, pages], () => {
      const byId = new Map(pages.map(p => [p.id, p]));
      return recent.map(r => byId.get(r.page_id)).filter(Boolean);
    });
  },

  // Zeichen-Badge pro Recent-Page (aus tokEsts).
  overviewPageChars(pageId) {
    const est = window.__app?.tokEsts?.[pageId];
    return est?.chars ?? null;
  },
};
