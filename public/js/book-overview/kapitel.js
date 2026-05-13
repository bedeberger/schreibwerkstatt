// Kapitel-Tiles: Verteilung (Zeichen), Findings (Lektorat), Lektoratszeit.
// Alle drei nutzen das gleiche Diverging-Bar-Layout um Median; Bar-Länge =
// |deltaPct| / maxAbsDelta * 48% (cap, damit Bars nicht an Track-Rand stossen).
import { fmtExactDuration } from '../utils.js';

export const kapitelMethods = {
  // Kapitel-Verteilung: Zeichen + Wörter + Seiten pro Kapitel.
  // Liest tree (Lese-Reihenfolge) und tokEsts (Live-Metriken pro Seite).
  // Diverging-Bar um Median (Zeichen): Track-Mitte = Median, Bars wachsen rechts
  // (länger als Median) oder links (kürzer). deltaPct = Abweichung gegen Median.
  // isMax/isMin markieren Extrem-Kapitel (Border-Akzent).
  // Sortierung: Lese-Reihenfolge aus tree (= Buch-Sortierung der Kapitel).
  overviewChapterDistribution() {
    const app = window.__app;
    if (!app) return [];
    const tree = app.tree || [];
    const tokEsts = app.tokEsts || {};
    return this._memo('chapterDist', [tree, tokEsts], () => {
      const out = [];
      for (const item of tree) {
        // Solo-Wrapper für Spezialseiten ohne Kapitel ausklammern (verzerren Median).
        if (item.type !== 'chapter' || item.solo) continue;
        const pages = item.pages || [];
        let words = 0, chars = 0;
        for (const p of pages) {
          const est = tokEsts[p.id];
          if (!est) continue;
          words += Number(est.words) || 0;
          chars += Number(est.chars) || 0;
        }
        out.push({
          id: item.id,
          name: item.name,
          pages: pages.length,
          words,
          chars,
          normseiten: Math.round((chars / 1500) * 10) / 10,
        });
      }
      if (out.length === 0) return out;
      const maxChars = Math.max(1, ...out.map(c => c.chars));
      const minChars = Math.min(...out.map(c => c.chars));
      const sorted = [...out].map(c => c.chars).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
      const withDelta = out.map(c => ({
        ...c,
        deltaPct: median > 0 ? Math.round(((c.chars - median) / median) * 100) : 0,
        isMax: c.chars === maxChars && maxChars > 0,
        isMin: c.chars === minChars && maxChars !== minChars,
      }));
      const maxAbsDelta = Math.max(1, ...withDelta.map(c => Math.abs(c.deltaPct)));
      const HALF = 48; // % of full track
      return withDelta.map(c => {
        const halfPct = (Math.abs(c.deltaPct) / maxAbsDelta) * HALF;
        return {
          ...c,
          median,
          barWidthPct: halfPct,
          barLeftPct: c.deltaPct >= 0 ? 50 : 50 - halfPct,
          isPositive: c.deltaPct >= 0,
        };
      });
    });
  },

  // Lektorat-Findings pro Kapitel: aus overviewHeat.matrix (mode=open).
  // Median, Diverging-Bar und Sort basieren auf absoluter Anzahl Findings —
  // direkt ablesbar, ohne mentalen Umweg über Findings/1k Wörter.
  // per1k bleibt als sekundärer Wert in der Zeilen-Meta erhalten.
  // Median nur aus geprüften Kapiteln; ungeprüfte Zeilen behalten den Tick als
  // Referenz, zeigen aber keinen Bar. Schwelle ≥3 geprüfte Kapitel für Median.
  overviewChapterFindings() {
    const heat = this.overviewHeat;
    if (!heat || !Array.isArray(heat.chapters) || !heat.matrix) return [];
    return this._memo('chapterFindings', [heat], () => this._computeChapterFindings(heat));
  },

  _computeChapterFindings(heat) {
    const out = [];
    for (const ch of heat.chapters) {
      if (ch.chapter_id == null) continue;
      const typen = heat.matrix[ch.chapter_id] || {};
      let count = 0;
      for (const t of Object.values(typen)) count += Number(t.count) || 0;
      const per1k = ch.words > 0 ? Math.round((count / ch.words) * 1000 * 10) / 10 : 0;
      out.push({
        id: ch.chapter_id,
        name: ch.chapter_name || '—',
        count,
        per1k,
        words: ch.words,
        pages_total: ch.pages_total,
        pages_checked: ch.pages_checked,
      });
    }
    if (out.length === 0) return out;
    const checked = out.filter(c => c.pages_checked > 0);
    const showMedian = checked.length >= 3;
    let median = 0;
    if (showMedian) {
      const sorted = checked.map(c => c.count).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      median = sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    }
    const withDelta = out.map(c => {
      const noCheck = c.pages_checked === 0;
      const deltaPct = !noCheck && median > 0
        ? Math.round(((c.count - median) / median) * 100)
        : 0;
      return { ...c, noCheck, deltaPct };
    });
    const HALF = 48;
    const deltas = withDelta.filter(c => !c.noCheck).map(c => Math.abs(c.deltaPct));
    const maxAbsDelta = Math.max(1, ...deltas);
    const checkedCounts = withDelta.filter(c => !c.noCheck).map(c => c.count);
    const worstCount = checkedCounts.length > 0 ? Math.max(...checkedCounts) : 0;
    const bestCount = checkedCounts.length > 0 ? Math.min(...checkedCounts) : 0;
    const enriched = withDelta
      .filter(c => !c.noCheck)
      .map(c => {
        const halfPct = showMedian
          ? (Math.abs(c.deltaPct) / maxAbsDelta) * HALF
          : 0;
        return {
          ...c,
          median,
          showMedian,
          barWidthPct: halfPct,
          barLeftPct: c.deltaPct >= 0 ? 50 : 50 - halfPct,
          isAbove: c.deltaPct > 0,
          isWorst: checkedCounts.length >= 2 && worstCount !== bestCount && c.count === worstCount,
          isBest: checkedCounts.length >= 2 && worstCount !== bestCount && c.count === bestCount,
        };
      });
    enriched.sort((a, b) => b.count - a.count);
    return enriched;
  },

  // Lektoratszeit pro Kapitel: alle Kapitel aus tree, gemerged mit
  // /history/lektorat-time/:book_id (per_chapter). Untracked = noTime,
  // analog zum noCheck-Flag der Findings-Tile (gleiches Layout).
  // Diverging-Bar um Median der Sekunden über tracked Kapitel; Schwelle
  // ≥3 tracked Kapitel für Median. Sort: tracked nach seconds desc,
  // noTime ans Ende.
  overviewChapterLektoratTime() {
    const tree = window.__app?.tree || [];
    const chapters = tree.filter(i => i.type === 'chapter');
    if (chapters.length === 0) return [];
    const lt = this.overviewLektoratTime;
    return this._memo('chapterLektoratTime', [tree, lt], () => this._computeChapterLektoratTime(chapters, lt));
  },

  _computeChapterLektoratTime(chapters, lt) {
    const byId = new Map();
    const byName = new Map();
    for (const row of (lt?.per_chapter || [])) {
      const sec = Number(row.seconds) || 0;
      if (sec <= 0) continue;
      if (row.chapter_id != null) byId.set(Number(row.chapter_id), row);
      if (row.chapter_name) byName.set(row.chapter_name, row);
    }
    const out = chapters.map(ch => {
      const row = byId.get(Number(ch.id)) || byName.get(ch.name) || null;
      const seconds = row ? (Number(row.seconds) || 0) : 0;
      return {
        id: ch.id,
        name: ch.name,
        seconds,
        pages_count: row ? (Number(row.pages_count) || 0) : 0,
        noTime: seconds <= 0,
      };
    });
    const tracked = out.filter(c => !c.noTime);
    const showMedian = tracked.length >= 3;
    let median = 0;
    if (showMedian) {
      const sorted = tracked.map(c => c.seconds).sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      median = sorted.length % 2 === 0
        ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
        : sorted[mid];
    }
    const withDelta = out.map(c => {
      const deltaPct = !c.noTime && median > 0
        ? Math.round(((c.seconds - median) / median) * 100)
        : 0;
      return { ...c, deltaPct };
    });
    const HALF = 48;
    const deltas = withDelta.filter(c => !c.noTime).map(c => Math.abs(c.deltaPct));
    const maxAbsDelta = Math.max(1, ...deltas);
    const trackedSecs = withDelta.filter(c => !c.noTime).map(c => c.seconds);
    const worstSeconds = trackedSecs.length > 0 ? Math.max(...trackedSecs) : 0;
    const bestSeconds = trackedSecs.length > 0 ? Math.min(...trackedSecs) : 0;
    const enriched = withDelta
      .filter(c => !c.noTime)
      .map(c => {
        const halfPct = showMedian
          ? (Math.abs(c.deltaPct) / maxAbsDelta) * HALF
          : 0;
        return {
          ...c,
          median,
          medianLabel: fmtExactDuration(median),
          durationLabel: fmtExactDuration(c.seconds),
          showMedian,
          barWidthPct: halfPct,
          barLeftPct: c.deltaPct >= 0 ? 50 : 50 - halfPct,
          isAbove: c.deltaPct > 0,
          isWorst: trackedSecs.length >= 2 && worstSeconds !== bestSeconds && c.seconds === worstSeconds,
          isBest: trackedSecs.length >= 2 && worstSeconds !== bestSeconds && c.seconds === bestSeconds,
        };
      });
    enriched.sort((a, b) => b.seconds - a.seconds);
    return enriched;
  },
};
