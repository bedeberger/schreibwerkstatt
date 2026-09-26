// Halter für eine Chart.js-Instanz einer Karte + ihren Theme-Observer.
//
// Die Instanz lebt bewusst AUSSERHALB von Alpine (Modul-State des Fachmoduls):
// Alpines Reaktivitäts-Proxy beschädigt Chart.js-Objekte. Ein Canvas kann keine
// CSS-Custom-Properties auflösen, darum muss bei einem `data-theme`-Wechsel neu
// gezeichnet werden — der Observer dafür kommt aus graph-kit (observeThemeChange),
// derselben Quelle wie beim Figuren-Graph.
//
//   const holder = createChartHolder();
//   holder.ensureThemeRedraw(() => { holder.destroy(); component.render(); });
//   holder.set(new Chart(canvas, cfg));
//   // destroy() der Karte:
//   holder.destroy(); holder.disconnect();

import { observeThemeChange } from '../graph-kit/theme.js';

/** Aktueller Wert einer CSS-Custom-Property am Dokument (für Chart-Farben). */
export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createChartHolder() {
  let chart = null;
  let observer = null;
  return {
    get() { return chart; },
    /** Neue Instanz übernehmen; eine abweichende alte wird zerstört. */
    set(next) {
      if (chart && chart !== next) chart.destroy();
      chart = next || null;
      return chart;
    },
    destroy() {
      if (chart) { chart.destroy(); chart = null; }
    },
    /** Observer einmalig anhängen. `onTheme` läuft nur, solange ein Chart steht. */
    ensureThemeRedraw(onTheme) {
      if (observer) return;
      observer = observeThemeChange(() => { if (chart) onTheme(); });
    },
    disconnect() {
      if (observer) { observer.disconnect(); observer = null; }
    },
  };
}
