// Motiv-Werkstatt — KI-Motiverkennung (Ist-Index). Stösst den motif-scan-Job an
// und pollt ihn; bei Abschluss den Graph neu laden (Fundstellen → Knotengrösse).

import { fetchJson } from '../../utils.js';
import { startPoll } from '../../cards/job-helpers.js';

export const scanMethods = {
  // Ist die semantische Erkennung aktiv? (Embedding-Backend an — /config).
  // Ist sie aus, findet der Scan nur wörtliche Trigger; das Panel warnt dann.
  semanticActive() {
    return !!this.$store.config?.semanticSearchEnabled;
  },

  // Embedding-Index des Buches aktualisieren, damit der semantische Scan frische
  // Vektoren sieht (neu geschriebener Text). Nach Abschluss automatisch rescannen.
  async refreshEmbedIndex() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || this.indexing) return;
    this.indexing = true;
    this.errorMessage = '';
    try {
      const { jobId } = await fetchJson('/jobs/embed-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      startPoll(this, {
        timerProp: '_embedPollTimer',
        jobId,
        onDone: async () => { this.indexing = false; this.embedIndexStale = false; if (this.motifs.length) await this.runScan(); },
        onNotFound: () => { this.indexing = false; },
        onError: () => { this.indexing = false; this.errorMessage = window.__app.t('motiv.error.index'); },
      });
    } catch (e) {
      this.indexing = false;
      this.errorMessage = window.__app.t('motiv.error.index');
    }
  },

  async runScan() {
    const bookId = this.$store.nav.selectedBookId;
    if (!bookId || this.scanning) return;
    if (!this.motifs.length) { this.errorMessage = window.__app.t('motiv.scan.noMotifs'); return; }
    this.scanning = true;
    this.scanProgress = 0;
    this.errorMessage = '';
    try {
      const { jobId } = await fetchJson('/jobs/motif-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId }),
      });
      this.motivScanJobId = jobId;
      startPoll(this, {
        timerProp: '_scanPollTimer',
        jobId,
        progressProp: 'scanProgress',
        onDone: async () => {
          this.scanning = false;
          this.motivScanJobId = null;
          await this.loadBoard();
          if (this.selectedMotifId) this.selectMotif(this.selectedMotifId);
        },
        onNotFound: () => { this.scanning = false; this.motivScanJobId = null; },
        onError: () => { this.scanning = false; this.motivScanJobId = null; this.errorMessage = window.__app.t('motiv.error.scan'); },
      });
    } catch (e) {
      this.scanning = false;
      this.errorMessage = window.__app.t('motiv.error.scan');
    }
  },
};
