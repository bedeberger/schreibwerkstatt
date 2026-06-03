// Fachmodul Tagebuch-Rückblick: Zeitraum-Optionen aus datierten Einträgen,
// Default-Zeitraum, Navigation zu einem Tag, Fliesstext-Absätze. Root-Zugriffe
// via window.__app. Job-Polling + run/onVisible kommen aus createCardJobFeature
// (siehe tagebuch-rueckblick-card.js). KI-Felder werden im Template via x-text
// (auto-escaped) gerendert — kein x-html-Sink.

import { tzOpts, fetchJson } from '../utils.js';

// Tagebuch-Seitennamen sind 'YYYY-MM-DD'. Hier rein clientseitig per Regex
// (kein Bedarf am vollen lib/datum-parse-Fallback).
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})\b/;

export const tagebuchRueckblickMethods = {
  // Liefert die für die Combobox verfügbaren Zeiträume (Jahre + Monate),
  // absteigend (neueste zuerst). Format: [{ value, label }].
  availableZeitraeume() {
    const pages = window.__app?.pages || [];
    const months = new Set();
    const years = new Set();
    for (const p of pages) {
      const m = ISO_DATE_RE.exec(p?.name || '');
      if (!m) continue;
      years.add(m[1]);
      months.add(`${m[1]}-${m[2]}`);
    }
    const monthOpts = [...months].sort().reverse().map(v => ({ value: v, label: this.zeitraumLabel(v) }));
    const yearOpts = [...years].sort().reverse().map(v => ({ value: v, label: this.zeitraumLabel(v) }));
    // Monate zuerst (feinkörniger), dann Jahre.
    return [...monthOpts, ...yearOpts];
  },

  // 'YYYY' → '2024'; 'YYYY-MM' → lokalisierter Monat + Jahr (TZ-aware).
  zeitraumLabel(value) {
    const v = String(value || '');
    const mm = /^(\d{4})-(\d{2})$/.exec(v);
    if (mm) {
      const d = new Date(Date.UTC(parseInt(mm[1], 10), parseInt(mm[2], 10) - 1, 1));
      try {
        return d.toLocaleDateString(window.__app?.uiLocale === 'en' ? 'en-US' : 'de-CH',
          tzOpts({ year: 'numeric', month: 'long' }));
      } catch { return v; }
    }
    return v;
  },

  // Default = jüngster Monat mit Einträgen (oder leer, wenn keine datierten).
  defaultZeitraum() {
    const opts = this.availableZeitraeume();
    const firstMonth = opts.find(o => /^\d{4}-\d{2}$/.test(o.value));
    return firstMonth ? firstMonth.value : (opts[0]?.value || '');
  },

  // Springt zur Tagebuch-Seite eines Datums (page_name === 'YYYY-MM-DD').
  gotoRueckblickTag(datum) {
    const pages = window.__app?.pages || [];
    const page = pages.find(p => (p?.name || '').slice(0, 10) === String(datum).slice(0, 10));
    if (page) window.__app.selectPage(page);
  },

  // Zusammenfassung in Absätze splitten (Doppel-Newline oder Single-Newline).
  rueckblickParagraphs() {
    const txt = this.rueckblickResult?.zusammenfassung || '';
    return String(txt).split(/\n{2,}|\n/).map(s => s.trim()).filter(Boolean);
  },

  hasRueckblickResult() {
    const r = this.rueckblickResult;
    return !!(r && (r.zusammenfassung || (r.themen && r.themen.length)));
  },

  // ── History (dauerhaft gespeicherte Rückblicke, re-öffenbar) ────────────────
  async loadRueckblickHistory() {
    const bookId = window.__app?.selectedBookId;
    if (!bookId) { this.rueckblickHistory = []; return; }
    try {
      this.rueckblickHistory = await fetchJson('/history/rueckblick/' + bookId);
    } catch (e) {
      console.error('[loadRueckblickHistory]', e);
      this.rueckblickHistory = [];
    }
  },

  // Historischen Rückblick in die Anzeige laden (kein neuer KI-Call).
  openRueckblickHistory(entry) {
    if (!entry?.result_json) return;
    this.rueckblickResult = entry.result_json;
    this.rueckblickEmpty = false;
    this.rueckblickZeitraum = entry.zeitraum || this.rueckblickZeitraum;
    this.selectedRueckblickId = entry.id;
  },

  async deleteRueckblickHistory(id) {
    try {
      await fetchJson('/history/rueckblick/' + id, { method: 'DELETE' });
      this.rueckblickHistory = (this.rueckblickHistory || []).filter(e => e.id !== id);
      if (this.selectedRueckblickId === id) this.selectedRueckblickId = null;
    } catch (e) {
      console.error('[deleteRueckblickHistory]', e);
    }
  },

  // Datum eines History-Eintrags (TZ-aware).
  rueckblickEntryDate(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleString(window.__app?.uiLocale === 'en' ? 'en-US' : 'de-CH',
        tzOpts({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    } catch { return iso; }
  },
};
