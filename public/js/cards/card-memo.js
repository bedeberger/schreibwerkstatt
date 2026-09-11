// Geteilter Memo-Helper fuer Karten mit Aggregat-Methoden, die pro Render
// mehrfach aus dem Template gerufen werden (CLAUDE.md, harte Regel
// „Memo-Pattern: ein Helper pro Modul").
//
// Cache-Hit nur, wenn ALLE Deps referenz-identisch zum letzten Lauf sind. Die
// Karte leert den Cache, indem sie `this._memos = {}` zuweist (Konvention:
// im `loadXxx`/`resetXxx` der Karte) — ein Reset einzelner Keys gibt es
// bewusst nicht, weil die Deps ohnehin die feinere Invalidierung tragen.
//
// Konsumenten: `bookOverviewCard` (via book-overview/load.js),
// `kapitelReviewCard` (via cards/kapitel-dashboard.js). Beide spreaden das
// Objekt in ihre Alpine-Komponente; der Speicher `_memos` lebt pro Instanz.
export const memoMethods = {
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
