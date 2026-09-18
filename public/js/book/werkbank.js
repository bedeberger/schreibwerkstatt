// Werkbank — die Ansicht, die Figuren-, Plot- und Motiv-Werkstatt zusammen liest.
//
// Zwei Sichten, ein Bestand:
//   „Matrix"  — Figuren × Akte: welche Figur trägt welchen Akt, mit welchen
//               Motiven und welchem Bogen-Ist.
//   „Befunde" — die GEMESSENEN Aussagen aller drei Werkstätten an einer Stelle
//               (Bogen, Zeit, Motiv-Kanten). Kein KI-Urteil: das bleibt bei
//               seinem Gegenstand, wo es den Kontext hat, der es lesbar macht.
//
// Rein lesend, kein Job, kein eigener Index — die drei Werkstätten SIND die
// abgeleiteten Stände (siehe routes/werkbank.js).

import { fetchJson } from '../utils.js';

// Schwere-Reihenfolge der drei Mess-Engines (lib/figure-arc.js,
// lib/plot-time-consistency.js, lib/motif-consistency.js führen dieselbe).
const SEVERITY_ORDER = ['kritisch', 'stark', 'mittel', 'schwach', 'niedrig'];

// Eine geteilte leere Liste fuer leere Zellen: `x-for` vergleicht Referenzen,
// und ein frisches `[]` pro Aufruf loeste bei jedem Render ein Re-Render aus.
const EMPTY = Object.freeze([]);

export const werkbankMethods = {
  setWerkbankView(mode) {
    const next = mode === 'befunde' ? 'befunde' : 'matrix';
    if (this.werkbankView === next) return;
    this.werkbankView = next;
    // Befunde lazy: wer nur die Matrix ansieht, soll die drei Messungen nicht
    // bezahlen (sie lesen den halben Buchbestand).
    if (next === 'befunde' && !this.werkbankBefunde) this.loadWerkbankBefunde();
  },

  async loadWerkbank() {
    const bookId = window.Alpine?.store('nav').selectedBookId;
    if (!bookId) { this.werkbank = null; return; }
    this.werkbankLoading = true;
    this.werkbankError = '';
    // Ein Buchwechsel während des Fetch darf die Antwort des alten Buchs nicht
    // in den frischen State schreiben (gleiche Sperre wie loadDrafts).
    const isStale = () => window.Alpine?.store('nav').selectedBookId !== bookId;
    try {
      const data = await fetchJson(`/werkbank?book_id=${bookId}`);
      if (isStale()) return;
      this.werkbank = data;
      this._memos = {};
    } catch {
      if (isStale()) return;
      this.werkbank = null;
      this.werkbankError = window.__app.t('werkbank.error.load');
    } finally {
      if (!isStale()) this.werkbankLoading = false;
    }
    // Die Befunde nur nachziehen, wenn ihre Ansicht offen ist — sonst holt sie
    // `setWerkbankView` beim Umschalten.
    if (!isStale() && this.werkbankView === 'befunde') await this.loadWerkbankBefunde();
  },

  async loadWerkbankBefunde() {
    const bookId = window.Alpine?.store('nav').selectedBookId;
    if (!bookId) { this.werkbankBefunde = null; return; }
    this.werkbankBefundeLoading = true;
    try {
      this.werkbankBefunde = await fetchJson(`/werkbank/befunde?book_id=${bookId}`);
      this._memos = {};
    } catch {
      this.werkbankBefunde = null;
      this.werkbankError = window.__app.t('werkbank.error.befunde');
    } finally { this.werkbankBefundeLoading = false; }
  },

  resetWerkbank() {
    this.werkbank = null;
    this.werkbankBefunde = null;
    this.werkbankError = '';
    this.werkbankLoading = false;
    this.werkbankBefundeLoading = false;
    this.werkbankFilter = '';
    this._memos = {};
  },

  // ── Matrix ────────────────────────────────────────────────────────────────

  // Sichtbare Akte: archivierte bleiben draussen, wie auf dem Beat-Board. Ihre
  // Beats zählen dort weiter in jeder Kennzahl — hier geht es aber um die
  // ARBEITSFLÄCHE, und ein abgeschlossener Akt ist keine.
  werkbankAkte() {
    return this._memo('wbAkte', [this.werkbank], () =>
      (this.werkbank?.akte || []).filter(a => !a.archiviert));
  },

  // Zeilen: Figuren mit Plan ODER Beats zuerst (sie sind der Gegenstand), dann
  // die übrigen. Innerhalb nach Beat-Zahl — wer das Buch trägt, steht oben.
  werkbankFiguren() {
    return this._memo('wbFiguren', [this.werkbank, this.werkbankFilter], () => {
      const q = (this.werkbankFilter || '').trim().toLowerCase();
      const rows = (this.werkbank?.figuren || []).filter(r =>
        !q || String(r.name || '').toLowerCase().includes(q));
      return rows.slice().sort((a, b) =>
        (b.activeBeatCount - a.activeBeatCount)
        || (b.motive.length - a.motive.length)
        || String(a.name).localeCompare(String(b.name)));
    });
  },

  // Zell-Index: `figurKey:actId` → aktive Beats. EINMAL gebaut statt pro Zelle
  // gefiltert — das Raster ruft die Zellen-Methode Figuren × Akte mal pro
  // Render, und jeder Aufruf erzeugte sonst ein neues Array (CLAUDE.md,
  // „Memo-Pattern"). Verworfene fallen hier raus: sie sollen nicht ins Buch,
  // also tragen sie auch keinen Akt.
  _werkbankZellen() {
    return this._memo('wbZellen', [this.werkbank], () => {
      const idx = new Map();
      for (const row of (this.werkbank?.figuren || [])) {
        for (const [actId, list] of Object.entries(row.beats || {})) {
          const aktiv = list.filter(b => !b.verworfen);
          if (aktiv.length) idx.set(`${row.key}:${actId}`, aktiv);
        }
      }
      return idx;
    });
  },

  werkbankZelle(row, actId) {
    return this._werkbankZellen().get(`${row.key}:${actId}`) || EMPTY;
  },

  // Eine leere Zelle ist die eigentliche Auskunft der Matrix: diese Figur kommt
  // in diesem Akt nicht vor. Sie wird darum gezeichnet, nicht weggelassen.
  werkbankZelleLeer(row, actId) {
    return !this._werkbankZellen().has(`${row.key}:${actId}`);
  },

  // Bogen-Kurzform je Zeile: wie viele geplante Kerne im Text belegt sind.
  // Nur für Werkstatt-Figuren — der Katalog hat keinen Plan, den man gegen den
  // Text stellen könnte. null = keine Aussage (auch die Anzeige sagt dann nichts).
  werkbankBogen(row) {
    if (row.kind !== 'draft' || !this.werkbank?.scanned) return null;
    const kerne = (this.werkbank?.kerne || []).filter(k => row.geplant?.[k]);
    if (!kerne.length) return null;
    const belegt = kerne.filter(k => (row.counts?.[k] || 0) > 0).length;
    return { belegt, gesamt: kerne.length };
  },

  // Sprung in die zuständige Werkstatt. Die Matrix ist die Übersicht, die
  // Werkstätten sind das Detail — hier wird nichts bearbeitet.
  werkbankOpenFigur(row) {
    if (row.kind === 'draft') window.__app.openWerkstattDraftById(row.id);
    else window.__app.openFigurById(row.id);
  },
  werkbankOpenBeat(beat) { window.__app.openPlotBeatById(beat.id); },
  werkbankOpenMotiv(motif) { window.__app.openMotifById(motif.id); },

  // ── Befunde ───────────────────────────────────────────────────────────────

  werkbankBefundListe() {
    return this._memo('wbBefunde', [this.werkbankBefunde], () => {
      const rows = [...(this.werkbankBefunde?.befunde || [])];
      rows.sort((a, b) =>
        (SEVERITY_ORDER.indexOf(a.schwere) - SEVERITY_ORDER.indexOf(b.schwere))
        || String(a.werkstatt).localeCompare(String(b.werkstatt)));
      return rows;
    });
  },

  // Der Befundtext kommt aus den Locales, nicht aus der Antwort — der
  // Betrachter bestimmt die Sprache (gleiche Regel wie die Motiv-Messung).
  // Die drei Werkstätten haben eigene Key-Räume, weil ihre Codes eigene sind.
  //
  // Die Platzhalter-Map muss ALLE Felder tragen, die ein Key einsetzt, und die
  // Engines legen sie nicht einheitlich ab: `werkstatt.arc.check.*` braucht nur
  // `params` plus den Kern, `motiv.check.*` zusätzlich Motiv-/Partnername und
  // den übersetzten Kanten-Typ — die stehen in der Wurzel des Befunds, nicht in
  // `params`. Fehlt eines, rendert der Satz den rohen `{name}`-Platzhalter.
  werkbankBefundText(b) {
    const app = window.__app;
    const prefix = b.werkstatt === 'figur' ? 'werkstatt.arc.check.'
                 : b.werkstatt === 'plot'  ? 'plot.check.'
                 : 'motiv.check.';
    const typKey = b.typ ? 'motiv.relation.type.' + b.typ : null;
    const typLabel = typKey ? app.t(typKey) : '';
    return app.t(prefix + b.code, {
      motiv: b.motiv || '',
      partner: b.partner || '',
      // Freitext-Kanten bleiben lesbar: ohne Locale-Eintrag der rohe Wert
      // (wortgleich mit motifRelLabel in der Motiv-Werkstatt).
      typ: typKey ? (typLabel === typKey ? b.typ : typLabel) : '',
      ...(b.params || {}),
      kern: b.kern ? app.t('werkstatt.tree.' + b.kern) : '',
    }) || b.code;
  },

  // Der Gegenstand des Befunds (Figur / Beat / Motiv) — die Engines benennen
  // ihn je nach Werkstatt anders, die Anzeige zeigt eine Spalte.
  werkbankBefundZiel(b) {
    return b.figur || b.beat || b.motiv || '—';
  },

  werkbankBefundOpen(b) {
    const app = window.__app;
    if (b.werkstatt === 'figur' && b.draft_id) app.openWerkstattDraftById(b.draft_id);
    else if (b.werkstatt === 'plot' && b.beat_id) app.openPlotBeatById(b.beat_id);
    else if (b.werkstatt === 'motiv' && b.motiv_id) app.openMotifById(b.motiv_id);
  },

  // UNGEMESSEN IST UNGEPRUEFT, NICHT IN ORDNUNG: welche der drei Werkstätten
  // hat gar nicht gemessen? Ohne diesen Hinweis liest sich eine leere Liste als
  // Unbedenklichkeitsbescheinigung.
  werkbankUngemessen() {
    const sc = this.werkbankBefunde?.scanned;
    if (!sc) return [];
    return ['figur', 'plot', 'motiv'].filter(k => !sc[k]);
  },
};
