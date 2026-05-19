// Load-Pipeline + Memo-Helper.
// loadBookOverview ruft 10 Endpoints parallel und schreibt das Resultat in den
// State. _checkBookStatsStaleness läuft anschliessend silent im Hintergrund;
// resetBookOverview leert State + Memos beim Buchwechsel.
import { fetchJson, aggregateLiveBookStats } from '../utils.js';

// Retry once mit kurzem Backoff: bei 9 parallelen Endpoints fängt das
// 5xx-/Netzwerk-Blips ab, ohne dass das Tile stumm leer rendert.
async function fetchJsonRetry(url) {
  try { return await fetchJson(url); }
  catch (e1) {
    await new Promise(r => setTimeout(r, 250));
    try { return await fetchJson(url); }
    catch (e2) {
      console.warn('[bookOverview] fetch failed twice', url, e2);
      throw e2;
    }
  }
}

export const loadMethods = {
  async loadBookOverview(bookId) {
    if (!bookId) return;
    // Dedupe: laufender Load fürs gleiche Buch wird ignoriert. Buchwechsel
    // setzt _loadingBookId auf die neue ID; In-flight-Antworten fürs alte
    // Buch fallen unten durch den overviewBookId-Guard raus.
    if (this._loadingBookId === bookId) return;
    this._loadingBookId = bookId;
    this.overviewLoading = true;
    this.overviewBookId = bookId;
    try {
      const [stats, coverage, heat, reviews, recent, figuren, szenen, orte, songs, lektoratTime, settings] = await Promise.all([
        fetchJsonRetry(`/history/book-stats/${bookId}`).catch(() => []),
        fetchJsonRetry(`/history/coverage/${bookId}`).catch(() => null),
        fetchJsonRetry(`/history/fehler-heatmap/${bookId}?mode=open`).catch(() => null),
        fetchJsonRetry(`/history/review/${bookId}`).catch(() => []),
        fetchJsonRetry(`/usage/page/recent?book_id=${bookId}&limit=5`).catch(() => []),
        fetchJsonRetry(`/figures/${bookId}`).catch(() => null),
        fetchJsonRetry(`/figures/scenes/${bookId}`).catch(() => null),
        fetchJsonRetry(`/locations/${bookId}`).catch(() => null),
        fetchJsonRetry(`/songs/${bookId}`).catch(() => null),
        fetchJsonRetry(`/history/lektorat-time/${bookId}`).catch(() => null),
        fetchJsonRetry(`/booksettings/${bookId}`).catch(() => null),
      ]);
      if (this.overviewBookId !== bookId) return;
      this.overviewStats = Array.isArray(stats) ? stats : [];
      this.overviewCoverage = coverage || null;
      this.overviewHeat = heat || null;
      const reviewArr = Array.isArray(reviews) ? reviews : [];
      this.overviewLastReview = reviewArr[0] || null;
      this.overviewPrevReview = reviewArr[1] || null;
      this.overviewRecent = Array.isArray(recent) ? recent : [];
      this.overviewFiguren = Array.isArray(figuren?.figuren) ? figuren.figuren : [];
      this.overviewSzenen = Array.isArray(szenen?.szenen) ? szenen.szenen : [];
      this.overviewOrte = Array.isArray(orte?.orte) ? orte.orte : [];
      this.overviewSongs = Array.isArray(songs?.songs) ? songs.songs : [];
      this.overviewLektoratTime = lektoratTime || null;
      this.overviewIsFinished = !!settings?.is_finished;
      this.overviewDailyGoalChars = settings?.daily_goal_chars != null ? Number(settings.daily_goal_chars) : null;
      this._memos = {};
    } catch (e) {
      console.error('[loadBookOverview]', e);
    } finally {
      if (this._loadingBookId === bookId) this._loadingBookId = null;
      if (this.overviewBookId === bookId) this.overviewLoading = false;
    }
    // Background-Auto-Sync: vergleiche pages[].updated_at gegen page_stats-Cache.
    // Wenn Seiten seit dem letzten Sync editiert wurden → /sync/book im Hintergrund,
    // danach Overview-Tiles refreshen. Silent (kein Spinner / Status).
    this._checkBookStatsStaleness(bookId);
  },

  // Silent background staleness check + auto-sync. Re-Entry-sicher via _staleCheckBookId
  // und _statsSyncBookId. Während des Post-Sync-Reloads bleibt _statsSyncBookId gesetzt,
  // damit der rekursive Check sofort returnt (kein Loop).
  async _checkBookStatsStaleness(bookId) {
    if (!bookId) return;
    if (typeof window === 'undefined') return;
    const app = window.__app;
    if (!app) return;
    if (this._statsSyncBookId === bookId) return;
    if (this._staleCheckBookId === bookId) return;
    this._staleCheckBookId = bookId;
    try {
      // Nach Buchwechsel kann app.pages noch leer sein (loadPages async).
      // Kurz pollen, dann aufgeben.
      for (let i = 0; i < 30 && (!app.pages || !app.pages.length); i++) {
        await new Promise(r => setTimeout(r, 100));
        if (app.selectedBookId !== bookId) return;
      }
      const pages = app.pages || [];
      if (!pages.length) return;
      const cache = await fetchJsonRetry(`/history/page-stats/${bookId}`).catch(() => null);
      if (!cache) return;
      if (app.selectedBookId !== bookId) return;
      let stale = false;
      // (a) per-Seite-Diff: BookStack-pages.updated_at vs page_stats-Cache.
      for (const p of pages) {
        const c = cache[p.id];
        if (!c || c.updated_at !== p.updated_at) { stale = true; break; }
      }
      // (b) Aggregat-Diff: book_stats_history.recorded_at (Tagesgranularität) vs
      // letzte page-Aktivität. Lazy `/sync/page-stats/:id` (IntersectionObserver
      // in tree.js) hält page_stats fresh, ohne aber book_stats_history zu
      // schreiben → Sparkline-Snapshot bleibt sonst hängen, bis Cron nachts läuft
      // oder User manuell synct. Stats-Tile soll nach Edit ohne Wartezeit korrekt
      // sein, also hier explizit nachsynchronisieren.
      if (!stale) {
        const stats = this.overviewStats || [];
        const lastSnapshotDate = stats.length ? stats[stats.length - 1].recorded_at : null;
        let latestPageDate = null;
        for (const p of pages) {
          const d = p.updated_at ? p.updated_at.slice(0, 10) : null;
          if (d && (!latestPageDate || d > latestPageDate)) latestPageDate = d;
        }
        if (latestPageDate && (!lastSnapshotDate || lastSnapshotDate < latestPageDate)) {
          stale = true;
        }
      }
      // (c) Live-Diff: Σ tokEsts.chars vs neuester Snapshot.chars. Greift den
      // Tagesgranularitäts-Blindspot von (b) ab — User editiert mehrfach am
      // selben Tag nach erstem Sync; Datums-String identisch, aber Live wächst
      // weiter. Sparkline + Δ-Trend zeigen ohne manuellen Refresh die jüngste
      // Spitze. Toleranz max(50, 0.5%), damit Normalisierungs-Rundungen nicht
      // bei jedem Open einen Sync triggern.
      if (!stale) {
        const stats = this.overviewStats || [];
        const lastSnapshot = stats.length ? stats[stats.length - 1] : null;
        const tokEsts = app.tokEsts || {};
        const tree = app.tree || [];
        const liveChars = aggregateLiveBookStats(tokEsts, tree).chars;
        const snapshotChars = Number(lastSnapshot?.chars) || 0;
        if (liveChars > 0 && snapshotChars > 0) {
          const diff = Math.abs(liveChars - snapshotChars);
          const tolerance = Math.max(50, snapshotChars * 0.005);
          if (diff > tolerance) stale = true;
        }
      }
      if (!stale) return;
      this._statsSyncBookId = bookId;
      try {
        const res = await fetch(`/sync/book/${bookId}`, { method: 'POST' });
        if (!res.ok) return;
        if (app.selectedBookId !== bookId) return;
        // tokEsts aktualisieren — gleicher Pfad wie syncBookStats in bookstats.js,
        // damit Sidebar-Σ und Hero-Snapshot nach dem Auto-Sync sofort aktuell sind.
        // REASSIGN, nicht index-assign: book-overview-Methoden cachen via _memo
        // mit tokEsts-Ref als Source. Index-Assign hält dieselbe Referenz →
        // Cache-Hit → stale Compute (Streak-Heatmap-Symptom: heutige Cell fehlt
        // weil Cache von vor dem Sync überlebt). Reassign triggert Memo-Invalidate.
        try {
          const fresh = await fetchJsonRetry(`/history/page-stats/${bookId}`);
          const updated = { ...app.tokEsts };
          for (const p of pages) {
            const c = fresh[p.id];
            if (c && c.updated_at === p.updated_at) {
              updated[p.id] = { tok: c.tok, words: c.words, chars: c.chars };
            }
          }
          app.tokEsts = updated;
        } catch { /* tokEsts-Update non-critical */ }
        if (!app.showBookOverviewCard || app.selectedBookId !== bookId) return;
        await this.loadBookOverview(bookId);
      } finally {
        if (this._statsSyncBookId === bookId) this._statsSyncBookId = null;
      }
    } catch (e) {
      console.warn('[bookOverview] staleness auto-sync failed', e);
    } finally {
      if (this._staleCheckBookId === bookId) this._staleCheckBookId = null;
    }
  },

  resetBookOverview() {
    this.overviewStats = [];
    this.overviewCoverage = null;
    this.overviewHeat = null;
    this.overviewLastReview = null;
    this.overviewPrevReview = null;
    this.overviewRecent = [];
    this.overviewFiguren = [];
    this.overviewSzenen = [];
    this.overviewOrte = [];
    this.overviewSongs = [];
    this.overviewLektoratTime = null;
    this.overviewIsFinished = false;
    this.overviewDailyGoalChars = null;
    this.overviewBookId = null;
    this._memos = {};
  },

  // Rollup-Helfer: alle per-Kapitel-Tiles aggregieren Sub-Kapitel auf ihr
  // Wurzel-Kapitel (Top-Level, depth=1). Tree ist flach + depth-annotiert
  // (siehe tree.js#loadPages). Solo-Wrapper (Spezialseiten ohne Kapitel)
  // ausgeklammert — verzerren sonst Median/Skalierung. Name-Map als
  // Fallback für Server-Rows, die nur `chapter_name` ohne `chapter_id`
  // liefern (Backfill-Lücken).
  _chapterRollup() {
    const tree = window.__app?.tree || [];
    return this._memo('rollup', [tree], () => {
      const chs = tree.filter(i => i.type === 'chapter' && !i.solo);
      const byId = new Map(chs.map(c => [Number(c.id), c]));
      const byName = new Map(chs.map(c => [c.name, c]));
      const rootCache = new Map();
      const rootOf = (id) => {
        if (id == null) return null;
        const key = Number(id);
        if (rootCache.has(key)) return rootCache.get(key);
        let cur = byId.get(key);
        const path = [key];
        while (cur?.parent_id != null) {
          const pid = Number(cur.parent_id);
          path.push(pid);
          cur = byId.get(pid);
        }
        for (const k of path) rootCache.set(k, cur || null);
        return cur || null;
      };
      const rootOfName = (name) => {
        if (!name) return null;
        const ch = byName.get(name);
        return ch ? rootOf(ch.id) : null;
      };
      // Root = ohne parent_id. Stabiler als depth===1 (legacy/tree-Fixtures
      // ohne depth-Annotation funktionieren weiter; Tree-Walker setzt depth=1
      // genau dann, wenn parent_id === null).
      const roots = chs.filter(c => c.parent_id == null);
      return { roots, rootOf, rootOfName, byId, byName };
    });
  },

  // Cache hit nur wenn ALLE Source-Refs (deps) identisch zur letzten Compute.
  // Wichtig für Tiles, die zusätzlich zu `overviewXxx` auch `app.tree`/
  // `app.figuren` lesen — sonst wird ein Compute mit leerem `tree` (während
  // loadPages noch läuft) als `null` cached und Tile bleibt aus, obwohl
  // tree danach befüllt wird (Haupt-Source-Ref unverändert).
  _memo(key, deps, compute) {
    const memos = (this._memos ||= {});
    const hit = memos[key];
    if (hit && hit.deps.length === deps.length
        && hit.deps.every((d, i) => d === deps[i])) {
      return hit.value;
    }
    const value = compute();
    memos[key] = { deps: [...deps], value };
    return value;
  },
};
