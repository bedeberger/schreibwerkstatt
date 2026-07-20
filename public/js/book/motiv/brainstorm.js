// Motiv-Werkstatt — KI-Brainstorm: die KI liest den Text und schlägt neue
// Motive/Themen vor. Vorschläge sind transient (kein DB-Persist); der Autor
// übernimmt sie einzeln (→ Theme/Motiv anlegen) oder verwirft sie. Nie im Text.

import { fetchJson } from '../../utils.js';
import { startPoll } from '../../cards/job-helpers.js';

function _json(url, method, body) {
  return fetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const brainstormMethods = {
  async runBrainstorm() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || this.brainstorming) return;
    this.brainstorming = true;
    this.errorMessage = '';
    try {
      const { jobId } = await fetchJson('/jobs/motif-brainstorm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      this.motivBrainstormJobId = jobId;
      startPoll(this, {
        timerProp: '_brainstormPollTimer',
        jobId,
        onDone: (job) => {
          this.brainstorming = false;
          this.motivBrainstormJobId = null;
          this.suggestions = (job.result?.vorschlaege || []);
        },
        onNotFound: () => { this.brainstorming = false; this.motivBrainstormJobId = null; },
        onError: () => { this.brainstorming = false; this.motivBrainstormJobId = null; this.errorMessage = window.__app.t('motiv.error.brainstorm'); },
      });
    } catch (e) {
      this.brainstorming = false;
      this.errorMessage = window.__app.t('motiv.error.brainstorm');
    }
  },

  dismissSuggestion(s) {
    this.suggestions = this.suggestions.filter(x => x !== s);
  },

  // Vorschlag übernehmen → Theme bzw. Motiv anlegen, dann aus der Liste nehmen.
  // Motiv-Vorschläge dürfen beim Übernehmen einem Thema zugeordnet werden
  // (s.themeIdDraft aus der Combobox in der Vorschlagskarte).
  async adoptSuggestion(s) {
    const bookId = this.$store.nav.selectedBookId;
    try {
      if (s.typ === 'thema') {
        await _json('/motifs/themes', 'POST', { book_id: bookId, name: s.name, beschreibung: s.beschreibung });
      } else {
        const body = { book_id: bookId, name: s.name, beschreibung: s.beschreibung, trigger_terms: s.trigger_terms || [] };
        if (s.themeIdDraft) body.theme_id = Number(s.themeIdDraft);
        await _json('/motifs', 'POST', body);
      }
      this.dismissSuggestion(s);
      await this.loadBoard();
    } catch (e) { this.errorMessage = window.__app.t('motiv.error.save'); }
  },
};
