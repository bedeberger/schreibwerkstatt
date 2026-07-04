// Kapitel-Tiles: Verteilung (Zeichen), Findings (Lektorat), Lektoratszeit.
// Alle drei nutzen das gleiche Diverging-Bar-Layout um Median; Bar-Länge =
// |deltaPct| / maxAbsDelta * 48% (cap, damit Bars nicht an Track-Rand stossen).
import { fmtExactDuration, charsToNormseiten } from '../utils.js';

export const kapitelMethods = {
  // Kapitel-Verteilung: Zeichen + Wörter + Seiten pro Top-Level-Kapitel.
  // Sub-Kapitel werden auf ihr Wurzel-Kapitel aggregiert (Pages aller
  // Descendant-Kapitel zählen zum Root-Bucket). Liest tree (Lese-Reihenfolge)
  // und tokEsts (Live-Metriken pro Seite). Diverging-Bar um Median (Zeichen):
  // Track-Mitte = Median, Bars wachsen rechts (länger als Median) oder links
  // (kürzer). deltaPct = Abweichung gegen Median. isMax/isMin markieren
  // Extrem-Kapitel (Border-Akzent). Sortierung: Lese-Reihenfolge der Roots.
  overviewChapterDistribution() {
    const app = window.__app;
    if (!app) return [];
    const tree = Alpine.store('nav').tree || [];
    const tokEsts = app.tokEsts || {};
    return this._memo('chapterDist', [tree, tokEsts], () => {
      const { roots, rootOf } = this._chapterRollup();
      const buckets = new Map();
      for (const r of roots) buckets.set(Number(r.id), { id: r.id, name: r.name, pages: 0, words: 0, chars: 0 });
      for (const item of tree) {
        if (item.type !== 'chapter' || item.solo) continue;
        const root = rootOf(item.id);
        if (!root) continue;
        const b = buckets.get(Number(root.id));
        if (!b) continue;
        const pages = item.pages || [];
        b.pages += pages.length;
        for (const p of pages) {
          const est = tokEsts[p.id];
          if (!est) continue;
          b.words += Number(est.words) || 0;
          b.chars += Number(est.chars) || 0;
        }
      }
      const out = [];
      for (const r of roots) {
        const b = buckets.get(Number(r.id));
        if (!b) continue;
        out.push({ ...b, normseiten: charsToNormseiten(b.chars) });
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

  // Lektorat-Findings pro Top-Level-Kapitel: aus overviewHeat.matrix (mode=open).
  // Sub-Kapitel-Rows werden auf ihr Wurzel-Kapitel aggregiert (count, words,
  // pages_total, pages_checked summiert). Median, Diverging-Bar und Sort
  // basieren auf absoluter Anzahl Findings — direkt ablesbar, ohne mentalen
  // Umweg über Findings/1k Wörter. per1k bleibt als sekundärer Wert in der
  // Zeilen-Meta erhalten. Median nur aus geprüften Kapiteln; ungeprüfte Zeilen
  // behalten den Tick als Referenz, zeigen aber keinen Bar. Schwelle ≥3
  // geprüfte Kapitel für Median.
  overviewChapterFindings() {
    const heat = this.overviewHeat;
    if (!heat || !Array.isArray(heat.chapters) || !heat.matrix) return [];
    const tree = Alpine.store('nav').tree || [];
    return this._memo('chapterFindings', [heat, tree], () => this._computeChapterFindings(heat));
  },

  _computeChapterFindings(heat) {
    const { roots, rootOf, rootOfName } = this._chapterRollup();
    const buckets = new Map();
    for (const r of roots) buckets.set(Number(r.id), {
      id: r.id, name: r.name, count: 0, words: 0, pages_total: 0, pages_checked: 0,
    });
    for (const ch of heat.chapters) {
      if (ch.chapter_id == null) continue;
      const root = rootOf(ch.chapter_id) || rootOfName(ch.chapter_name);
      if (!root) continue;
      const b = buckets.get(Number(root.id));
      if (!b) continue;
      const typen = heat.matrix[ch.chapter_id] || {};
      let count = 0;
      for (const t of Object.values(typen)) count += Number(t.count) || 0;
      b.count += count;
      b.words += Number(ch.words) || 0;
      b.pages_total += Number(ch.pages_total) || 0;
      b.pages_checked += Number(ch.pages_checked) || 0;
    }
    const out = [];
    for (const r of roots) {
      const b = buckets.get(Number(r.id));
      if (!b) continue;
      const per1k = b.words > 0 ? Math.round((b.count / b.words) * 1000 * 10) / 10 : 0;
      out.push({ ...b, per1k });
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

  // Lektoratszeit pro Top-Level-Kapitel: alle Roots aus tree, Sub-Kapitel-Zeiten
  // auf ihr Wurzel-Kapitel aggregiert. /history/lektorat-time/:book_id liefert
  // per_chapter pro direct chapter_id. Untracked = noTime, analog zum
  // noCheck-Flag der Findings-Tile (gleiches Layout). Diverging-Bar um Median
  // der Sekunden über tracked Kapitel; Schwelle ≥3 tracked Kapitel für Median.
  // Sort: tracked nach seconds desc, noTime ans Ende.
  overviewChapterLektoratTime() {
    const tree = Alpine.store('nav').tree || [];
    const lt = this.overviewLektoratTime;
    return this._memo('chapterLektoratTime', [tree, lt], () => this._computeChapterLektoratTime(lt));
  },

  _computeChapterLektoratTime(lt) {
    const { roots, rootOf, rootOfName } = this._chapterRollup();
    if (roots.length === 0) return [];
    const buckets = new Map();
    for (const r of roots) buckets.set(Number(r.id), {
      id: r.id, name: r.name, seconds: 0, pages_count: 0,
    });
    for (const row of (lt?.per_chapter || [])) {
      const sec = Number(row.seconds) || 0;
      if (sec <= 0) continue;
      const root = (row.chapter_id != null ? rootOf(row.chapter_id) : null)
                 || rootOfName(row.chapter_name);
      if (!root) continue;
      const b = buckets.get(Number(root.id));
      if (!b) continue;
      b.seconds += sec;
      b.pages_count += Number(row.pages_count) || 0;
    }
    const out = [];
    for (const r of roots) {
      const b = buckets.get(Number(r.id));
      if (!b) continue;
      out.push({ ...b, noTime: b.seconds <= 0 });
    }
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
