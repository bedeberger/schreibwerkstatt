// Plan-Slice der Referenz-Karte (Alpine.data('referenceCard'), cards/reference-card.js):
// die Beats des Beat-Boards neben dem Notebook-Editor — was im offenen Kapitel
// laut Plan passieren soll, waehrend man es schreibt.
//
// Warum im Referenz-Slot und nicht als eigene Karte: der Plan gehoert an den
// Schreibort. Das Board ist eine Buchkarte und schliesst den Editor
// (Exklusivitaet); hier steht er daneben, read-only. Pflege bleibt im Board —
// jede Zeile springt per Beat-Permalink (#book/<id>/plot/<beatId>) dorthin.
//
// Kontext-Regel wie bei den Geschwister-Reitern (reference-context.js): ein Beat
// haengt an einem KAPITEL (`plot_beats.chapter_id`, sonst geerbt vom Strang),
// nie an einer Seite. Die
// Seiten-Zugehoerigkeit kommt deshalb nicht aus dem Plan, sondern aus der
// Beat-Verankerung (`occ_top[].page_id`, mitgeliefert vom Board-GET): 'page' =
// der Beat wurde auf der offenen Seite im Text gefunden, 'chapter' = er gehoert
// ins Kapitel, steht aber (noch) nicht hier.
//
// Daten: GET /plot/?book_id — derselbe Payload wie das Board (Akte, Straenge,
// Beats mit fig_ids/locations/motifs/occ_top). Pro Buch + User skopiert, wie
// das Board selbst. Schreibt nie.

import { fetchJson } from '../utils.js';

/** Aktiv = nicht verworfen (Spalte `verworfen` ODER Alt-Status 'verworfen'). */
const isActive = (b) => !b?.verworfen && b?.status !== 'verworfen';

/** Beats in Board-Lesereihenfolge (Akt-Position → sort_order → id) — dieselbe
 *  Ordnung wie Board und Spannungsbogen (plot/derived/tension.js). Pure. */
export function orderPlanBeats(plan) {
  const acts = plan?.acts || [];
  const actPos = new Map(acts.map((a, i) => [a.id, a.position ?? i]));
  return (plan?.beats || [])
    .filter(isActive)
    .sort((a, b) => ((actPos.get(a.act_id) ?? 0) - (actPos.get(b.act_id) ?? 0))
                 || ((a.sort_order ?? 0) - (b.sort_order ?? 0))
                 || (a.id - b.id));
}

/** Kapitel eines Beats: das eigene, sonst das seines Strangs — Beats der
 *  Strang-Lane erben es implizit (Buch-Chat: `geerbtes_kapitel`). */
function effectiveChapterId(beat, threadChapter) {
  if (beat.chapter_id != null) return beat.chapter_id;
  return beat.thread_id != null ? (threadChapter.get(beat.thread_id) ?? null) : null;
}

/** Kontext-Auswahl: Beats des Kapitels, auf der Seite verankerte zuerst. Pure. */
export function selectPlanBeatsForPage(ordered, { pageId, chapterId, threads = [] }) {
  if (chapterId == null) return [];
  const threadChapter = new Map((threads || []).map(t => [t.id, t.chapter_id ?? null]));
  const onPage = [];
  const inChapter = [];
  for (const b of ordered) {
    const cid = effectiveChapterId(b, threadChapter);
    if (cid == null || Number(cid) !== Number(chapterId)) continue;
    const here = pageId != null && (b.occ_top || []).some(o => o?.page_id != null && Number(o.page_id) === Number(pageId));
    (here ? onPage : inChapter).push(b);
  }
  return [
    ...onPage.map(b => ({ ...b, refCtx: 'page' })),
    ...inChapter.map(b => ({ ...b, refCtx: 'chapter' })),
  ];
}

export function referencePlanState() {
  return {
    referencePlan: null,              // { acts, threads, beats } aus GET /plot/
    referencePlanLoading: false,
  };
}

export const referencePlanMethods = {
  async _loadReferencePlan() {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId) { this.referencePlan = null; return; }
    this.referencePlanLoading = true;
    try {
      const r = await fetchJson(`/plot/?book_id=${encodeURIComponent(bookId)}`);
      this.referencePlan = r && Array.isArray(r.beats) ? r : null;
    } catch { this.referencePlan = null; }
    finally { this.referencePlanLoading = false; }
  },

  _planOrdered() {
    return this._memo('planOrdered', [this.referencePlan], () => orderPlanBeats(this.referencePlan));
  },

  // Tab-Sichtbarkeit: ohne aktiven Beat im Buch gibt es keinen Plan zu zeigen
  // (analog Quellen-Tab ohne Quellen).
  referenceHasPlan() { return this._planOrdered().length > 0; },

  referencePlanBeats() {
    const app = window.__app;
    const pid = app?.currentPage?.id ?? null;
    const cid = app?.currentPage?.chapter_id ?? null;
    const ordered = this._planOrdered();
    const threads = this.referencePlan?.threads || [];
    return this._memo('plan', [this.referenceScope, pid, cid, ordered, threads], () => {
      if (!this._contextActive()) return ordered;
      return selectPlanBeatsForPage(ordered, { pageId: pid, chapterId: cid, threads });
    });
  },

  /** Akt · Strang · Zeit — woran man den Beat auf dem Board wiederfindet. */
  referencePlanMeta(beat) {
    const plan = this.referencePlan || {};
    const act = (plan.acts || []).find(a => a.id === beat?.act_id);
    const thread = beat?.thread_id != null ? (plan.threads || []).find(t => t.id === beat.thread_id) : null;
    return [act?.name, thread?.name, beat?.zeit].filter(Boolean).join(' · ');
  },

  /** Beteiligte Figuren + Orte als eine Zeile. Figuren-Identitaet ist die
   *  TEXT-fig_id (Katalog-`id`), nie durch Number() schicken. */
  referencePlanCast(beat) {
    const figs = Alpine.store('catalog').figuren || [];
    const byId = new Map(figs.map(f => [String(f.id), f]));
    const names = (beat?.fig_ids || []).map(id => byId.get(String(id))?.name).filter(Boolean);
    const orte = (beat?.locations || []).map(l => l?.name).filter(Boolean);
    return [...names, ...orte].join(', ');
  },

  referencePlanMotifs(beat) {
    return (beat?.motifs || []).map(m => m?.name).filter(Boolean).join(', ');
  },

  referencePlanStatus(beat) {
    return beat?.status ? window.__app.t('plot.status.' + beat.status) : '';
  },

  /** Sprung aufs Board, Beat fokussiert (Hash-Router: case 'plot' + Permalink). */
  openReferenceBeat(beat) {
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || beat?.id == null) return;
    location.hash = `#book/${bookId}/plot/${beat.id}`;
  },
};
