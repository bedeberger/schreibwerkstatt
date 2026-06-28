// Plot-Werkstatt — abgeleitete Reads (Teil 1): Beats/Stats, Figuren-Picker,
// Stränge/Swimlanes, Hybrid-Akte, Grid-Render-Plan, Live-Vererbung, Akt-Farben.
// Reine Compute aus Board-State (memoized), keine Server-Mutationen.

import { STATUSES, DIST_SEGMENTS, ACT_PALETTE } from '../constants.js';

export const boardMethods = {
  // ── Derived (memoized) ──────────────────────────────────────────────────────
  beatsForAct(actId) {
    return this._memo(`beats:${actId}`, [this.beats, actId], () =>
      (this.beats || [])
        .filter(b => b.act_id === actId)
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
    );
  },

  // Beats einer Grid-Zelle (Akt × Strang). threadId === null = „ohne Strang"-Lane.
  // Im Grid-Pfad das Pendant zu beatsForAct.
  beatsForCell(actId, threadId) {
    const tid = threadId == null ? null : threadId;
    return this._memo(`cell:${actId}:${tid}`, [this.beats, actId, tid], () =>
      (this.beats || [])
        .filter(b => b.act_id === actId && (b.thread_id ?? null) === tid)
        .sort((a, b) => (a.sort_order - b.sort_order) || (a.id - b.id))
    );
  },

  boardStats() {
    return this._memo('stats', [this.beats], () => this._computeStats(this.beats || []));
  },

  // Status-Zählung über eine Beat-Liste (board-weit oder pro Akt). geplant/im_buch
  // zählen nur aktive (nicht verworfene) Beats; verworfen ist eine eigene Achse
  // (Flag) und wird separat gezählt — die drei Segmente summieren sich zu total.
  // imBuch/geplant bleiben als Top-Level-Felder erhalten (von plot.stats-i18n konsumiert).
  _computeStats(list) {
    const by = { geplant: 0, im_buch: 0, verworfen: 0 };
    for (const b of list) {
      if (b.verworfen) by.verworfen++;
      else if (by[b.status] != null) by[b.status]++;
    }
    return { total: list.length, by, imBuch: by.im_buch, geplant: by.geplant };
  },

  // Pro-Akt-Status-Verteilung (für die Mini-Fortschrittsleiste im Spaltenkopf).
  actStats(actId) {
    return this._memo(`astats:${actId}`, [this.beats, actId], () =>
      this._computeStats((this.beats || []).filter(b => b.act_id === actId)));
  },

  statusList() { return STATUSES; },

  // Segmente der board-weiten/akt-weiten Verteilungsleiste (zwei Status + die
  // Verwerfen-Achse). Eigene Liste, damit die Edit-Status-Tabs binär bleiben.
  distStatusList() { return DIST_SEGMENTS; },

  // ── Figuren-Picker (gruppierte Combobox-Optionen) ───────────────────────────
  // Katalog-Figuren als Multi-Select-Combobox-Optionen, gruppiert nach Kapitel
  // (`opt.group`). Eine Figur erscheint unter jedem Kapitel, in dem sie auftritt
  // (figuren[].kapitel via figure_appearances); Figuren ohne Auftritt landen in
  // der „ohne Kapitel"-Gruppe. Gruppen in Buch-Kapitelreihenfolge ($app.tree),
  // innerhalb nach Figurname. Liest bewusst `window.__app.*` (Root-Proxy) statt
  // `this.*` — nur so trackt der combobox-`x-effect` die Reaktivität (DESIGN.md).
  beatFigureOptions() {
    const app = window.__app;
    const figs = app?.figuren || [];
    const tree = app?.tree || [];
    return this._memo('figOpts', [figs, tree], () => {
      const order = new Map();
      tree.filter(it => it.type === 'chapter').forEach((c, i) => order.set(c.name, i));
      const noChapter = app?.t ? app.t('plot.beat.noChapterGroup') : '—';
      const rows = [];
      for (const f of figs) {
        const label = f.kurzname || f.name;
        const chapters = [...new Set((f.kapitel || []).map(k => k.name).filter(Boolean))];
        if (!chapters.length) {
          rows.push({ value: f.id, label, group: noChapter, _ord: Number.MAX_SAFE_INTEGER });
        } else {
          for (const ch of chapters) rows.push({ value: f.id, label, group: ch, _ord: order.has(ch) ? order.get(ch) : order.size });
        }
      }
      rows.sort((a, b) => (a._ord - b._ord) || a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
      return rows;
    });
  },

  // Werkstatt-Figuren als (flache) Multi-Select-Optionen — keine Kapitel-Daten,
  // daher ungruppiert. Quelle ist karten-lokal (`this.draftFiguren`); der
  // combobox-`x-effect` berührt `draftFiguren` zusätzlich inline fürs Tracking.
  beatWerkstattOptions() {
    return this._memo('wFigOpts', [this.draftFiguren], () =>
      (this.draftFiguren || []).map(d => ({ value: d.id, label: d.name })));
  },

  // Aktuell gewählte Katalog-Figuren des Edit-Drafts als entfernbare Chips.
  beatFigureChips() {
    const byId = window.__app?.figurenById;
    return (this.beatDraft.figure_ids || []).map(id => ({ id, label: byId?.get(id)?.kurzname || byId?.get(id)?.name || id }));
  },

  // Aktuell gewählte Werkstatt-Figuren des Edit-Drafts als entfernbare Chips.
  beatWerkstattChips() {
    return (this.beatDraft.draft_figure_ids || []).map(id => ({ id, label: this.draftFigurenById?.get(id)?.name || id }));
  },

  // ── Stränge (Swimlanes, Derived) ───────────────────────────────────────────
  // Zeilen des Grids: Stränge in Position-Reihenfolge + die „ohne Strang"-Lane
  // (id null) immer am Ende — sie ist Drop-Ziel zum Entkoppeln und fängt alle
  // nicht zugeordneten Beats.
  threadLanes() {
    return this._memo('lanes', [this.threads], () => {
      const rows = [...(this.threads || [])]
        .sort((a, b) => a.position - b.position)
        .map(t => ({ id: t.id, thread: t, isDefault: false }));
      rows.push({ id: null, thread: null, isDefault: true });
      return rows;
    });
  },

  // ── Hybrid-Akte (Derived) ───────────────────────────────────────────────────
  // Geteilte Akte (thread_id NULL) — die Spalten des flachen Boards und aller
  // Stränge ohne eigene Aktstruktur.
  sharedActs() {
    return this._memo('sharedActs', [this.acts], () =>
      (this.acts || []).filter(a => a.thread_id == null).sort((a, b) => a.position - b.position));
  },

  // Strang-eigene Akte (thread_id === threadId), positionsgeordnet.
  actsForThread(threadId) {
    return this._memo(`tacts:${threadId}`, [this.acts, threadId], () =>
      (this.acts || []).filter(a => a.thread_id === threadId).sort((a, b) => a.position - b.position));
  },

  // Hat der Strang eine eigene Aktstruktur (≥1 strang-eigener Akt)? Aus den Daten
  // abgeleitet — kein Flag (kein Drift). Für null (ohne Strang) immer false.
  _threadHasOwn(threadId) {
    return threadId != null && (this.acts || []).some(a => a.thread_id === threadId);
  },
  threadHasOwnActs(threadId) { return this._threadHasOwn(threadId); },

  // Render-Plan des Grids als flache Zeilen-Deskriptoren (eine x-for-Schleife im
  // Partial, je Deskriptor ein Header- ODER Lane-Block). So bleibt das (grosse)
  // Beat-Zell-Markup an EINER Stelle, obwohl geteilte Lanes und strang-eigene
  // Blöcke unterschiedliche Spalten-Sets (acts) tragen:
  //   - Geteilte Region: ein Header (sharedActs) + alle Lanes ohne eigene Akte
  //     (inkl. „ohne Strang") — Spalten richten sich aus.
  //   - Pro Strang mit eigener Aktstruktur: ein eigener Header (seine Akte) + seine
  //     Lane darunter (eigene Spaltenzahl, nicht ausgerichtet — gewollt).
  // kind: 'header' → { acts, thread } ; kind: 'lane' → { lane, acts }.
  gridRows() {
    return this._memo('gridRows', [this.acts, this.threads], () => {
      const lanes = this.threadLanes();
      const shared = this.sharedActs();
      const rows = [];
      const sharedLanes = lanes.filter(l => l.isDefault || !this._threadHasOwn(l.id));
      if (sharedLanes.length) {
        rows.push({ kind: 'header', key: 'h:shared', acts: shared, thread: null });
        for (const l of sharedLanes) rows.push({ kind: 'lane', key: `l:${l.id ?? 'none'}`, lane: l, acts: shared });
      }
      for (const l of lanes) {
        if (l.isDefault || !this._threadHasOwn(l.id)) continue;
        const own = this.actsForThread(l.id);
        rows.push({ kind: 'header', key: `h:${l.id}`, acts: own, thread: l.thread });
        rows.push({ kind: 'lane', key: `l:${l.id}`, lane: l, acts: own });
      }
      return rows;
    });
  },

  // CSS-Akzent eines Strangs (gleiche Palette-Whitelist wie actAccent).
  threadAccent(thread) {
    const key = thread && thread.farbe;
    return (key && ACT_PALETTE.includes(key)) ? `var(--palette-${key})` : 'var(--card-accent)';
  },

  // Anzeigename der an den Strang gebundenen Figur (Katalog via fig_id, sonst
  // Werkstatt via draft_figure_id). Leer, wenn keine Figur gebunden.
  threadFigureLabel(thread) {
    if (!thread) return '';
    if (thread.fig_id) {
      const f = window.__app.figurenById?.get(thread.fig_id);
      return f ? (f.kurzname || f.name) : '';
    }
    if (thread.draft_figure_id) {
      const d = this.draftFigurenById?.get(thread.draft_figure_id);
      return d ? d.name : '';
    }
    return '';
  },

  // ── Live-Vererbung Strang → Beat ────────────────────────────────────────────
  // Ein Beat in einer Strang-Lane erbt implizit die Hauptfigur + das Kapitel des
  // Strangs (nie auf dem Beat gespeichert — rein Anzeige + KI-Kontext). Eigene
  // Beat-Werte haben Vorrang: die Strang-Figur wird nur als geerbter Zusatz
  // gezeigt, das Strang-Kapitel nur, wenn der Beat kein eigenes Kapitel hat.
  _threadOf(beat) {
    const tid = beat && beat.thread_id;
    if (tid == null) return null;
    return (this.threads || []).find(t => t.id === tid) || null;
  },

  // Vom Strang geerbte Figur als { kind:'catalog'|'werkstatt', id, label } —
  // oder null, wenn kein Strang, keine gebundene Figur, oder der Beat sie bereits
  // explizit führt (keine Doppelanzeige).
  inheritedFigureForBeat(beat) {
    const t = this._threadOf(beat);
    if (!t) return null;
    if (t.fig_id) {
      if ((beat.fig_ids || []).includes(t.fig_id)) return null;
      const f = window.__app.figurenById?.get(t.fig_id);
      return { kind: 'catalog', id: t.fig_id, label: f ? (f.kurzname || f.name) : t.fig_id };
    }
    if (t.draft_figure_id) {
      if ((beat.draft_fig_ids || []).map(String).includes(String(t.draft_figure_id))) return null;
      const d = this.draftFigurenById?.get(t.draft_figure_id);
      return { kind: 'werkstatt', id: t.draft_figure_id, label: d ? d.name : t.draft_figure_id };
    }
    return null;
  },

  // Vom Strang geerbter Kapitelname — nur wenn der Beat kein eigenes Kapitel hat
  // und der Strang eines bindet. Leer sonst.
  inheritedChapterForBeat(beat) {
    if (beat.chapter_id) return '';
    const t = this._threadOf(beat);
    return (t && t.chapter_name) ? t.chapter_name : '';
  },

  // Effektiver Kapitelname eines Beats: eigenes hat Vorrang, sonst das vom Strang
  // geerbte. SSoT für alle Aggregationen (Coverage, Filter), die mit „dem Kapitel
  // des Beats" arbeiten — sonst widerspricht das gezeigte geerbte Badge dem, was
  // Coverage/Filter melden.
  effectiveChapterNameForBeat(beat) {
    return beat.chapter_name || this.inheritedChapterForBeat(beat) || '';
  },

  // ── Akt-Farben (Derived) ───────────────────────────────────────────────────
  actPalette() { return ACT_PALETTE; },

  // CSS-Wert für den Akt-Akzent: bekannter Palette-Key → --palette-<key>,
  // sonst Karten-Akzent. Whitelist verhindert CSS-Injection aus dem Freitextfeld.
  actAccent(act) {
    const key = act && act.farbe;
    return (key && ACT_PALETTE.includes(key)) ? `var(--palette-${key})` : 'var(--card-accent)';
  },
};
