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
  // Memo-Helper (CLAUDE.md-Pattern): genau einer pro Modul, Array-Deps shallow ===.
  // Aggregat-Getter, die mehrfach pro Render laufen (availableZeitraeume via
  // Combobox-x-effect, filteredRueckblickHistory in x-for + Empty-Check), cachen
  // darüber. Invalidierung rein über die Deps — kein expliziter Reset nötig.
  _memo(key, deps, fn) {
    if (!this._memos) this._memos = {};
    const prev = this._memos[key];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, i) => d === deps[i])) {
      return prev.val;
    }
    const val = fn();
    this._memos[key] = { deps, val };
    return val;
  },

  // Liefert die für die Combobox verfügbaren Zeiträume (Jahre + Monate),
  // absteigend (neueste zuerst). Format: [{ value, label }].
  availableZeitraeume() {
    const pages = Alpine.store('nav').pages || [];
    return this._memo('zeitraeume', [pages, Alpine.store('shell').uiLocale],
      () => this._computeZeitraeume(pages));
  },

  _computeZeitraeume(pages) {
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
        return d.toLocaleDateString(Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH',
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

  // ── Neugenerierungs-Sperre ───────────────────────────────────────────────────
  // Ein Rückblick wird NICHT neu generiert, solange sich die datierten Einträge des
  // Zeitraums seit der letzten Generierung nicht geändert haben. Zwei Signale:
  //  1. jüngste updated_at aller datierten Seiten > created_at des Rückblicks
  //     → Seite bearbeitet/hinzugefügt.
  //  2. aktuelle Anzahl datierter Seiten ≠ entry_count-Snapshot des Rückblicks
  //     → Seite gelöscht (deckt den Fall ab, den (1) nicht sieht: keine verbleibende
  //     Seite ist jünger, aber eine ist verschwunden).
  // Ist beides unauffällig → aktuell → Button gesperrt. Deckt sich mit der server-
  // seitigen Cache-Invalidierung (pages_sig keyt auf id:updated_at aller Seiten des
  // Zeitraums): unveränderte Menge ⇒ Cache-HIT ⇒ ohnehin kein KI-Call. Legacy-
  // Einträge ohne entry_count (null) prüfen nur (1) — altes Verhalten.
  rueckblickUpToDate() {
    const z = this.rueckblickZeitraum;
    if (!z) return false;
    const entry = (this.rueckblickHistory || []).find(e => e.zeitraum === z);
    if (!entry?.created_at) return false;
    const genMs = new Date(entry.created_at).getTime();
    if (!genMs) return false;
    const { newest, count } = this._pageStatsForZeitraum(z);
    if (newest > genMs) return false;
    if (entry.entry_count != null && count !== entry.entry_count) return false;
    return true;
  },

  // Jüngste updated_at (ms) + Anzahl aller datierten Seiten des Zeitraums.
  _pageStatsForZeitraum(z) {
    const pages = Alpine.store('nav').pages || [];
    return this._memo('pageStats:' + z, [pages, z], () => {
      const prefix = /^\d{4}$/.test(z) ? z + '-' : z; // Jahr → 'YYYY-', Monat → 'YYYY-MM'
      let newest = 0, count = 0;
      for (const p of pages) {
        const name = p?.name || '';
        if (!ISO_DATE_RE.test(name) || !name.startsWith(prefix)) continue;
        count++;
        const ms = p.updated_at ? new Date(p.updated_at).getTime() : 0;
        if (ms > newest) newest = ms;
      }
      return { newest, count };
    });
  },

  // Springt zur Tagebuch-Seite eines Datums (page_name === 'YYYY-MM-DD').
  gotoRueckblickTag(datum) {
    const pages = Alpine.store('nav').pages || [];
    const page = pages.find(p => (p?.name || '').slice(0, 10) === String(datum).slice(0, 10));
    if (page) window.__app.selectPage(page);
  },

  // ── Facetten sortiert (häufigste zuerst) ────────────────────────────────────
  // Wiederkehrendes steht oben, Einmal-Nennungen hinten. Memoized über die
  // Quell-Referenz, damit nicht bei jedem Render neu sortiert wird.
  rbThemen()   { return this._sortedFacet('themen'); },
  rbPersonen() { return this._sortedFacet('personen'); },
  rbOrte()     { return this._sortedFacet('orte'); },

  _sortedFacet(key) {
    const arr = this.rueckblickResult?.[key] || [];
    return this._memo('facet:' + key, [arr],
      () => [...arr].sort((a, b) => (b.haeufigkeit || 0) - (a.haeufigkeit || 0)));
  },

  // ── Belege inline (Klick auf Thema/Person/Ort → referenzierte Tage) ──────────
  // Statt eines schwebenden Popovers: eine Inline-Leiste unter den Facetten zeigt
  // die Belegtage des aktiven Stichworts. Kein Positioning-Math, keine Fehlplatz-
  // ierung. Erneuter Klick (gleicher Key) schliesst die Leiste.
  toggleBeleg(key, label, belege) {
    if (this.rbBeleg.key === key) { this.clearBeleg(); return; }
    const days = [...new Set((belege || []).map(d => String(d).slice(0, 10)).filter(Boolean))].sort();
    this.rbBeleg = { key, label: label || '', belege: days };
  },

  clearBeleg() {
    this.rbBeleg = { key: null, label: '', belege: [] };
  },

  // Tag aus der Belege-Leiste anspringen + Leiste schliessen.
  gotoBelegTag(datum) {
    this.clearBeleg();
    this.gotoRueckblickTag(datum);
  },

  // 'YYYY-MM-DD' → lokalisierter Tag (TZ-aware, Noon-UTC verhindert Datums-Rollover).
  belegLabel(datum) {
    const m = ISO_DATE_RE.exec(String(datum || ''));
    if (!m) return String(datum || '');
    const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12));
    try {
      return d.toLocaleDateString(Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH',
        tzOpts({ weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }));
    } catch { return String(datum); }
  },

  // Zusammenfassung in Absätze splitten. Bevorzugt Doppel-Newline (Claude); nur
  // wenn keiner vorkommt, auf Einzel-Newline ausweichen (lokale Provider) — so
  // wird ein weicher Umbruch innerhalb eines Absatzes nicht fälschlich getrennt.
  rueckblickParagraphs() {
    const txt = String(this.rueckblickResult?.zusammenfassung || '');
    if (!txt.trim()) return [];
    const byDouble = txt.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    if (byDouble.length > 1) return byDouble;
    return txt.split(/\n/).map(s => s.trim()).filter(Boolean);
  },

  hasRueckblickResult() {
    const r = this.rueckblickResult;
    return !!(r && (r.zusammenfassung || (r.themen && r.themen.length)));
  },

  // Label des aktuell angezeigten Rückblick-Zeitraums — nur wenn tatsächlich ein
  // Ergebnis oder der Leerzustand sichtbar ist (sonst leer). Trägt den Card-Title:
  // zeigt dem User, für welchen Zeitraum er den Rückblick gerade anschaut. Der
  // Combobox-Wert ist dagegen das Generierungs-Ziel und kann davon abweichen.
  viewingZeitraumLabel() {
    if (!this.hasRueckblickResult() && !this.rueckblickEmpty) return '';
    return this.zeitraumLabel(this.rueckblickZeitraum);
  },

  // ── History (dauerhaft gespeicherte Rückblicke, re-öffenbar) ────────────────
  async loadRueckblickHistory() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.rueckblickHistory = []; this.rbHistoryLoaded = true; return; }
    try {
      this.rueckblickHistory = await fetchJson('/history/rueckblick/' + bookId);
    } catch (e) {
      console.error('[loadRueckblickHistory]', e);
      this.rueckblickHistory = [];
    } finally {
      // Erst nach dem ersten Fetch darf der Leer-Hinweis erscheinen (kein Flash
      // der „noch keine Rückblicke"-Zeile, während die Liste noch lädt).
      this.rbHistoryLoaded = true;
    }
  },

  // Gefilterte History (Volltext über Zeitraum-Label + Inhalt der gespeicherten
  // Rückblicke: Zusammenfassung, Themen, Personen, Orte, bemerkenswerte Tage).
  // Rein clientseitig über die bereits geladene Liste.
  filteredRueckblickHistory() {
    const all = this.rueckblickHistory || [];
    const q = String(this.rbHistorySearch || '').trim().toLowerCase();
    return this._memo('histFilter', [all, q, Alpine.store('shell').uiLocale], () => {
      if (!q) return all;
      return all.filter(e => this._rueckblickHaystack(e).includes(q));
    });
  },

  // Durchsuchbarer Text eines History-Eintrags (lowercase).
  _rueckblickHaystack(entry) {
    const r = entry?.result_json || {};
    const parts = [
      entry?.zeitraum || '',
      this.zeitraumLabel(entry?.zeitraum),
      r.zusammenfassung || '',
      ...(r.themen || []).map(t => t.label),
      ...(r.personen || []).map(p => p.name),
      ...(r.orte || []).map(o => o.name),
      ...(r.bemerkenswerteTage || []).map(t => t.begruendung),
    ];
    return parts.filter(Boolean).join(' ').toLowerCase();
  },

  // Zeitraum-Vorauswahl (aus Overview-Heatmap, warmer Fall): Zeitraum setzen
  // und einen bereits vorhandenen Rückblick anzeigen — nie auto-generieren.
  _applyRueckblickZeitraum(zeitraum) {
    if (!zeitraum) return;
    this.rueckblickZeitraum = zeitraum;
    this.selectedRueckblickId = null;
    this.rueckblickResult = null;
    this.rueckblickEmpty = false;
    this.clearBeleg();
    const existing = (this.rueckblickHistory || []).find(e => e.zeitraum === zeitraum);
    if (existing) this.openRueckblickHistory(existing);
  },

  // Historischen Rückblick in die Anzeige laden (kein neuer KI-Call).
  openRueckblickHistory(entry) {
    if (!entry?.result_json) return;
    this.rueckblickResult = entry.result_json;
    this.rueckblickEmpty = false;
    this.rueckblickZeitraum = entry.zeitraum || this.rueckblickZeitraum;
    this.selectedRueckblickId = entry.id;
    this.clearBeleg();
  },

  // History-Eintrag per id öffnen (Permalink-Eingang #…/rueckblick/<id>).
  _openRueckblickEntryById(id) {
    const entry = (this.rueckblickHistory || []).find(e => String(e.id) === String(id));
    if (entry) this.openRueckblickHistory(entry);
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
      return new Date(iso).toLocaleString(Alpine.store('shell').uiLocale === 'en' ? 'en-US' : 'de-CH',
        tzOpts({ day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }));
    } catch { return iso; }
  },
};
