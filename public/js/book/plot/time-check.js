// Plot-Werkstatt: Zeit-Messung (deterministisch, kein KI-Lauf). Der Server
// stellt datierte Beats gegen Geburtsjahre, Buchspanne und Board-Reihenfolge
// (GET /plot/time-check, pure Logik in lib/plot-time-consistency.js). Kein Job,
// kein Polling, keine Kosten — die Befunde kommen mit jedem Board-Load mit und
// werden nach jeder Beat-Mutation frisch geholt.
//
// Der Befund-Text lebt in den Locales (plot.check.<code>), nicht im Payload:
// der Server liefert `code` + `params`, der Betrachter bestimmt die Sprache.

import { fetchJson } from '../../utils.js';

export const timeCheckMethods = {
  async loadTimeChecks() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.timeChecks = []; return; }
    try {
      const data = await fetchJson(`/plot/time-check?book_id=${bookId}`);
      if (Alpine.store('nav').selectedBookId !== bookId) return;
      this.timeChecks = Array.isArray(data.befunde) ? data.befunde : [];
    } catch (e) {
      // Non-fatal: die Messung ist eine Zusatzsicht, kein Board-Blocker.
      this.timeChecks = [];
    }
  },

  timeCheckText(f) {
    return window.__app.t('plot.check.' + f.code, f.params || {}) || f.code;
  },

  // `schwach` heisst hier „leichter Befund". Die geteilte Palette kodiert unter
  // `severity-tag--schwach` aber Beleg-STÄRKE (schwach = rot) — darum explizit
  // auf die Schwere-Klassen abbilden (gleiche Zuordnung wie die Motiv-Messung).
  timeCheckSeverityClass(f) {
    const map = { kritisch: 'severity-tag--kritisch', mittel: 'severity-tag--mittel', schwach: 'severity-tag--niedrig' };
    return map[f && f.schwere] || 'severity-tag--niedrig';
  },
};
