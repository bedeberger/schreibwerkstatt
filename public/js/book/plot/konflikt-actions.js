// Plot-Werkstatt: Befund-Typen + Ein-Klick-Aktionen in der Konsistenz-Liste.
//
// Vertrag des Jobs `plot-consistency` (routes/jobs/plot.js):
//   konflikt.typ   ∈ KONFLIKT_TYPES   (Alt-Läufe: fehlt → kein Tag)
//   konflikt.aktion = null | { art:'status', wert:'im_buch'|'geplant' }
//                   | { art:'verwerfen' }
//                   | { art:'relation', typ:<BEAT_REL_TYPES>, ziel_beat_id:int }
//                   — immer bezogen auf konflikt.beat_id
//   konflikt.seit_letztem_lauf ∈ 'neu'|'bestehend'|null
//   result.erledigt = string[] (optional)
//
// Eine Aktion läuft über die BESTEHENDEN Mutationspfade (Beat-PATCH mit
// Undo-Record, toggleBeatVerworfen, addBeatRelation) — die KI schlägt vor, der
// User löst aus. Danach gilt der Befund lokal als „angewendet" (nicht
// persistiert: der nächste Lauf prüft ohnehin neu).

import { fetchJson } from '../../utils.js';
import { BEAT_REL_TYPES } from './constants.js';

export const KONFLIKT_TYPES = ['status', 'chronologie', 'kausalitaet', 'setup_payoff', 'strang', 'figur', 'weltgesetz', 'spannung', 'logik', 'struktur'];
const STATUS_WERTE = ['im_buch', 'geplant'];

export function konfliktActionState() {
  return {
    // Typ-Filter über der Befund-Liste ('' = alle).
    konfliktTypFilter: '',
    // { '<runId|live>:<idx>': true } — in dieser Sitzung angewendete Befunde.
    appliedKonflikte: {},
  };
}

export const konfliktActionMethods = {
  konfliktHasTyp(k) { return !!k && KONFLIKT_TYPES.includes(k.typ); },

  konfliktTypLabel(typ) { return window.__app.t('plot.konflikt.typ.' + typ); },

  // Typen, die im angezeigten Lauf vorkommen (feste Reihenfolge + Anzahl).
  konfliktTypOptions() {
    return this._memo('konfliktTypOpts', [this.consistencyResult], () => {
      const counts = new Map();
      for (const k of this.consistencyResult?.konflikte || []) {
        if (this.konfliktHasTyp(k)) counts.set(k.typ, (counts.get(k.typ) || 0) + 1);
      }
      return KONFLIKT_TYPES.filter(t => counts.has(t))
        .map(t => ({ value: t, label: `${this.konfliktTypLabel(t)} (${counts.get(t)})` }));
    });
  },

  konfliktVisible(k) {
    const f = this.konfliktTypFilter;
    return !f || (k && k.typ === f);
  },

  konfliktErledigt() {
    const list = this.consistencyResult?.erledigt;
    return Array.isArray(list) ? list.filter(s => typeof s === 'string' && s.trim()) : [];
  },

  _konfliktKey(idx) { return `${this.selectedRunId ?? 'live'}:${idx}`; },

  konfliktApplied(idx) { return !!this.appliedKonflikte[this._konfliktKey(idx)]; },

  _konfliktBeat(k) {
    if (!k || k.beat_id == null) return null;
    return (this.beats || []).find(b => b.id === k.beat_id) || null;
  },

  // Aktion validieren (KI-Ausgabe ist untrusted: unbekannte Arten/Werte → null).
  _konfliktAction(k) {
    const a = k && k.aktion;
    if (!a || typeof a !== 'object') return null;
    if (a.art === 'status' && STATUS_WERTE.includes(a.wert)) return a;
    if (a.art === 'verwerfen') return a;
    if (a.art === 'relation' && BEAT_REL_TYPES.includes(a.typ) && Number.isInteger(a.ziel_beat_id)) return a;
    return null;
  },

  // Knopf zeigen? Nur wenn der Beat (und bei Relation das Ziel) noch existiert,
  // die Aktion nicht schon angewendet ist und sie nicht bereits erfüllt ist.
  konfliktActionPending(k, idx) {
    const a = this._konfliktAction(k);
    const beat = this._konfliktBeat(k);
    if (!a || !beat || this.konfliktApplied(idx)) return false;
    if (a.art === 'status') return beat.status !== a.wert;
    if (a.art === 'verwerfen') return !beat.verworfen;
    const ziel = (this.beats || []).find(b => b.id === a.ziel_beat_id);
    if (!ziel || ziel.id === beat.id) return false;
    return !(this.relations || []).some(r =>
      r.from_beat_id === beat.id && r.to_beat_id === ziel.id && r.typ === a.typ);
  },

  konfliktActionLabel(k) {
    const app = window.__app;
    const a = this._konfliktAction(k);
    if (!a) return '';
    if (a.art === 'status') return app.t('plot.konflikt.action.status.' + a.wert);
    if (a.art === 'verwerfen') return app.t('plot.konflikt.action.verwerfen');
    const ziel = (this.beats || []).find(b => b.id === a.ziel_beat_id);
    return app.t('plot.konflikt.action.relation', { typ: this.relTypeLabel(a.typ), ziel: ziel ? ziel.titel : '' });
  },

  async applyKonfliktAction(k, idx) {
    const app = window.__app;
    if (this.busy || !this.konfliktActionPending(k, idx)) return;
    const a = this._konfliktAction(k);
    const beat = this._konfliktBeat(k);
    let ok = false;
    if (a.art === 'status') {
      ok = await this._konfliktSetStatus(beat, a.wert);
    } else if (a.art === 'verwerfen') {
      await this.toggleBeatVerworfen(beat);
      ok = !!(this.beats || []).find(b => b.id === beat.id)?.verworfen;
    } else {
      // addBeatRelation liest den Picker-State des Beat-Edits — kurz belegen und
      // den Stand des Users danach zurückgeben.
      const prev = { typ: this.relDraftTyp, target: this.relDraftTarget };
      this.relDraftTyp = a.typ;
      this.relDraftTarget = String(a.ziel_beat_id);
      try {
        await this.addBeatRelation(beat);
      } finally {
        this.relDraftTyp = prev.typ;
        this.relDraftTarget = prev.target;
      }
      ok = (this.relations || []).some(r =>
        r.from_beat_id === beat.id && r.to_beat_id === a.ziel_beat_id && r.typ === a.typ);
    }
    if (ok) {
      this.appliedKonflikte = { ...this.appliedKonflikte, [this._konfliktKey(idx)]: true };
    } else if (!this.errorMessage) {
      this.errorMessage = app.t('plot.error.save');
    }
  },

  // Status-PATCH wie promoteBeat: Undo-Record `beat-fields`, Fundstellen lokal
  // übernehmen (die PATCH-Antwort trägt kein occ_count/occ_top).
  async _konfliktSetStatus(beat, wert) {
    const app = window.__app;
    const before = { status: beat.status };
    this.busy = true;
    try {
      const updated = await fetchJson(`/plot/beats/${beat.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: wert }),
      });
      this._replaceBeat({ ...updated, occ_count: beat.occ_count, occ_top: beat.occ_top });
      this._recordBeatFields(beat.id, before, { status: wert });
      app.refreshPlotBeatCounts?.();
      this.errorMessage = '';
      return true;
    } catch (e) {
      this.errorMessage = app.t('plot.error.save');
      return false;
    } finally { this.busy = false; }
  },
};
