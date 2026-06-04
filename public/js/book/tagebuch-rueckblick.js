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
    const pages = window.__app?.pages || [];
    return this._memo('zeitraeume', [pages, window.__app?.uiLocale],
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

  // ── Belege-Popover (Klick auf Thema/Person/Ort → referenzierte Seiten) ───────
  // Öffnet ein fixed-positioniertes Popover, das sich am angeklickten Badge
  // ausrichtet (unter dem Element, bei zu wenig Platz darüber — mobil wie
  // desktop) und am Viewport-Rand geclampt wird. Jeder Tag navigiert zur Seite.
  openBelegePopover(event, label, belege) {
    const anchor = event?.currentTarget || event?.target || null;
    const days = [...new Set((belege || []).map(d => String(d).slice(0, 10)).filter(Boolean))].sort();
    this.rbPopover = { open: true, label: label || '', belege: days, x: -9999, y: -9999 };
    // Sync-Vorabplatzierung (ohne gemessene Höhe → unter dem Element) gegen
    // Flackern, dann nach Render mit echter Höhe verfeinern (Flip oben/unten).
    this._placeBelegePopover(anchor);
    const place = () => this._placeBelegePopover(anchor);
    if (window.Alpine?.nextTick) window.Alpine.nextTick(place);
    else setTimeout(place, 0);
  },

  // Positioniert das Popover relativ zum Anker-Element. Unter dem Element, sofern
  // dort Platz ist; sonst darüber, wenn oben mehr Raum bleibt. Horizontal an der
  // linken Anker-Kante, beidseitig auf den Viewport geclampt.
  _placeBelegePopover(anchor) {
    const rect = anchor?.getBoundingClientRect?.();
    if (!rect) return;
    const pop = anchor.closest?.('.card')?.querySelector?.('.rb-belege-popover');
    const EDGE = 8, GAP = 6;
    const vw = window.innerWidth, vh = window.innerHeight;
    const popW = pop?.offsetWidth || 240;
    const popH = pop?.offsetHeight || 0;
    let left = Math.min(rect.left, vw - popW - EDGE);
    left = Math.max(EDGE, left);
    const spaceBelow = vh - rect.bottom;
    let top;
    if (popH && spaceBelow < popH + GAP && rect.top > spaceBelow) {
      top = rect.top - popH - GAP; // oben aufklappen
    } else {
      top = rect.bottom + GAP;     // unter dem Element
    }
    if (popH) top = Math.max(EDGE, Math.min(top, vh - popH - EDGE));
    this.rbPopover.x = Math.round(left);
    this.rbPopover.y = Math.round(top);
  },

  closeBelegePopover() {
    this.rbPopover = { open: false, label: '', belege: [], x: 0, y: 0 };
  },

  // Tag aus dem Popover anspringen + Popover schliessen.
  gotoBelegTag(datum) {
    this.closeBelegePopover();
    this.gotoRueckblickTag(datum);
  },

  // 'YYYY-MM-DD' → lokalisierter Tag (TZ-aware, Noon-UTC verhindert Datums-Rollover).
  belegLabel(datum) {
    const m = ISO_DATE_RE.exec(String(datum || ''));
    if (!m) return String(datum || '');
    const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12));
    try {
      return d.toLocaleDateString(window.__app?.uiLocale === 'en' ? 'en-US' : 'de-CH',
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

  // Gefilterte History (Volltext über Zeitraum-Label + Inhalt der gespeicherten
  // Rückblicke: Zusammenfassung, Themen, Personen, Orte, bemerkenswerte Tage).
  // Rein clientseitig über die bereits geladene Liste.
  filteredRueckblickHistory() {
    const all = this.rueckblickHistory || [];
    const q = String(this.rbHistorySearch || '').trim().toLowerCase();
    return this._memo('histFilter', [all, q, window.__app?.uiLocale], () => {
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
