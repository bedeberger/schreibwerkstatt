// Plot-Werkstatt: abgeleitete (memoisierte) Read-Methoden — Beats/Stats,
// Stränge/Swimlanes, Hybrid-Akte, Grid-Render-Plan, Spannungsbogen, Filter.
// Reine Compute aus Board-State, keine Server-Mutationen.

import { STATUSES, DIST_SEGMENTS, ACT_PALETTE, _intensityBottomPct } from './constants.js';

// Schwere-Rangfolge (höher = gravierender) für die Badge-Farbwahl am Beat.
const SEV_RANK = { kritisch: 5, stark: 4, mittel: 3, schwach: 2, niedrig: 1 };
// Beat-Titel normalisieren für den Abgleich Befund ↔ Beat (gleiche Vertragsbasis
// wie der Consistency-Job, der den Beat nur per Titel-String referenziert).
const _normTitle = (s) => (s || '').trim().toLowerCase().replace(/\s+/g, ' ');

export const derivedMethods = {
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

  // ── Spannungsbogen ─────────────────────────────────────────────────────────
  // Beats mit gesetzter Intensität (verworfene zählen nicht — sie formen den
  // Bogen nicht) in Board-Lesereihenfolge (Akt-Position → sort_order) zu einer
  // Kurve. Punkte als Prozent-Koordinaten + Polyline-String für die SVG-Linie.
  tensionCurve() {
    return this._memo('tension', [this.beats, this.acts, this.threads], () => {
      const actPos = new Map((this.acts || []).map(a => [a.id, a.position]));
      const actById = new Map((this.acts || []).map(a => [a.id, a]));
      const order = (a, b) =>
        ((actPos.get(a.act_id) ?? 0) - (actPos.get(b.act_id) ?? 0)) ||
        (a.sort_order - b.sort_order) || (a.id - b.id);

      // Eine Punkt-Reihe aus einer Beat-Teilmenge (verworfene + ohne Intensität raus).
      const _line = (subset, color) => {
        const seq = subset
          .filter(b => !b.verworfen && b.intensitaet != null)
          .sort(order);
        const n = seq.length;
        const pts = seq.map((b, k) => {
          const xPct = n === 1 ? 50 : +(5 + (k / (n - 1)) * 90).toFixed(2);
          const bottomPct = +_intensityBottomPct(b.intensitaet).toFixed(2);
          return {
            beat: b, act: actById.get(b.act_id) || null, color,
            xPct, bottomPct, xSvg: xPct, ySvg: +(100 - bottomPct).toFixed(2),
          };
        });
        return { points: pts, polyline: pts.map(p => `${p.xSvg},${p.ySvg}`).join(' '), count: n };
      };

      // Globale Kurve (alle Beats, Akt-Akzent pro Punkt) — Board ohne Stränge.
      const all = (this.beats || []).filter(b => !b.verworfen && b.intensitaet != null).sort(order);
      const nAll = all.length;
      const points = all.map((b, k) => {
        const act = actById.get(b.act_id) || null;
        const xPct = nAll === 1 ? 50 : +(5 + (k / (nAll - 1)) * 90).toFixed(2);
        const bottomPct = +_intensityBottomPct(b.intensitaet).toFixed(2);
        return { beat: b, act, color: this.actAccent(act), xPct, bottomPct, xSvg: xPct, ySvg: +(100 - bottomPct).toFixed(2) };
      });

      // Pro-Strang-Serien (nur wenn Stränge existieren) — je Strang eine eigene
      // farbige Polyline. Leere Stränge fallen raus.
      const series = (this.threads || [])
        .slice()
        .sort((a, b) => a.position - b.position)
        .map(t => {
          const line = _line((this.beats || []).filter(b => b.thread_id === t.id), this.threadAccent(t));
          return { key: `t${t.id}`, thread: t, label: t.name, ...line };
        })
        .filter(s => s.count >= 1);

      return { points, polyline: points.map(p => `${p.xSvg},${p.ySvg}`).join(' '), count: nAll, series };
    });
  },

  // ── Verworfen-Collapse (pro Akt) ────────────────────────────────────────────
  // Verworfene Beats werden eingeklappt, damit sie die Spalte nicht aufblähen;
  // ein „+N verworfen"-Toggle blendet sie ein. Drag/Reorder bleibt unberührt
  // (operiert weiter auf beatsForAct/filteredBeatsForAct mit allen Beats).
  visibleBeatsForAct(actId) {
    const base = this.filteredBeatsForAct(actId);
    if (this.verworfenOpen[actId]) return base;
    return this._memo(`vbeats:${actId}`, [base], () => base.filter(b => !b.verworfen));
  },

  verworfenCountForAct(actId) {
    return this.filteredBeatsForAct(actId).filter(b => b.verworfen).length;
  },

  toggleVerworfen(actId) {
    this.verworfenOpen = { ...this.verworfenOpen, [actId]: !this.verworfenOpen[actId] };
  },

  // ── Konsistenz-Befunde ↔ Beats (aktiver Lauf) ──────────────────────────────
  // Index normalisierter Beat-Titel → Befunde des gerade angezeigten Laufs.
  // Übergreifende Befunde ("—") haben kein Beat-Ziel und fallen raus. Memoisiert
  // auf das Result-Objekt — es wird bei jedem Lauf/Öffnen neu zugewiesen, sodass
  // der Referenz-Vergleich greift.
  _konfliktIndex() {
    return this._memo('konfliktIdx', [this.consistencyResult], () => {
      const map = new Map();
      const ks = this.consistencyResult?.konflikte || [];
      ks.forEach((k, idx) => {
        const key = _normTitle(k.beat);
        if (!key || key === '—') return;
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ ...k, idx });
      });
      return map;
    });
  },

  // Befunde, die genau diesen Beat (per Titel) betreffen — leer, wenn kein Lauf
  // angezeigt wird oder der Beat sauber ist.
  beatKonflikte(beat) {
    if (!this.consistencyResult) return [];
    return this._konfliktIndex().get(_normTitle(beat?.titel)) || [];
  },

  // Höchste Schwere unter den Befunden eines Beats (steuert die Badge-Farbe).
  beatTopSeverity(beat) {
    let top = 'mittel', rank = 0;
    for (const k of this.beatKonflikte(beat)) {
      const r = SEV_RANK[k.schwere] || 0;
      if (r > rank) { rank = r; top = k.schwere; }
    }
    return top;
  },

  // Tooltip am Warn-Badge: alle Probleme dieses Beats untereinander.
  beatKonflikteTip(beat) {
    return this.beatKonflikte(beat).map(k => k.problem).filter(Boolean).join('\n');
  },

  // ── Kapitel-Coverage (lokales Aggregat, kein KI-Job) ────────────────────────
  // Welche Buch-Kapitel haben (noch) keinen Beat, und wie viele nicht-verworfenen
  // Beats hängen an keinem Kapitel. Match über das effektive Kapitel (eigenes oder
  // vom Strang geerbt), Quelle sind die $app.tree-Kapitel. Deps inkl. threads, weil
  // das geerbte Kapitel an der Strang-Bindung hängt.
  plotCoverage() {
    const tree = window.__app.tree || [];
    return this._memo('coverage', [this.beats, this.threads, tree], () => {
      const chapters = tree.filter(it => it.type === 'chapter');
      const covered = new Set((this.beats || []).map(b => this.effectiveChapterNameForBeat(b)).filter(Boolean));
      const uncovered = chapters.filter(c => !covered.has(c.name)).map(c => c.name);
      const beatsNoChapter = (this.beats || []).filter(b => !this.effectiveChapterNameForBeat(b) && !b.verworfen).length;
      return { uncovered, beatsNoChapter, totalChapters: chapters.length };
    });
  },

  // Lohnt die Coverage-Sektion? Nur wenn Kapitel existieren und es etwas zu
  // melden gibt (offene Kapitel oder kapitellose Beats).
  plotCoverageRelevant() {
    const c = this.plotCoverage();
    return c.totalChapters > 0 && (c.uncovered.length > 0 || c.beatsNoChapter > 0);
  },

  // ── Filter (Volltext / Kapitel / Figur) ─────────────────────────────────────
  // Kapitel-Optionen aus den Beats ableiten (buchgeordnet via Root-Helper),
  // damit nur Kapitel angeboten werden, die im Board überhaupt vorkommen.
  plotKapitelListe() {
    return window.__app._deriveKapitel(this.beats, b => this.effectiveChapterNameForBeat(b));
  },

  plotFilterActive() {
    const f = this.plotFilters;
    return !!(f.kapitel || f.figurId || f.draftFigurId || f.status || (f.text || '').trim());
  },

  _beatMatchesFilter(b) {
    const f = this.plotFilters;
    const txt = (f.text || '').trim().toLowerCase();
    // draftFigurId kommt aus der Combobox als Roh-Value (INTEGER) — String-
    // koerziert vergleichen, da draft_fig_ids INTEGER sind.
    return (!txt || (b.titel || '').toLowerCase().includes(txt) || (b.beschreibung || '').toLowerCase().includes(txt)) &&
           (!f.kapitel || this.effectiveChapterNameForBeat(b) === f.kapitel) &&
           (!f.status || b.status === f.status) &&
           (!f.figurId || (b.fig_ids || []).includes(f.figurId)) &&
           (!f.draftFigurId || (b.draft_fig_ids || []).map(String).includes(String(f.draftFigurId)));
  },

  // Gefilterte Beats pro Akt — nur fürs Rendering. Ohne aktiven Filter wird der
  // (bereits memoisierte) ungefilterte beatsForAct-Array unverändert durchgereicht.
  filteredBeatsForAct(actId) {
    const f = this.plotFilters;
    const base = this.beatsForAct(actId);
    if (!this.plotFilterActive()) return base;
    return this._memo(`fbeats:${actId}`, [base, f.kapitel, f.figurId, f.draftFigurId, f.status, f.text], () =>
      base.filter(b => this._beatMatchesFilter(b)));
  },

  filteredBeatCount() {
    const f = this.plotFilters;
    return this._memo('fcount', [this.beats, f.kapitel, f.figurId, f.draftFigurId, f.status, f.text], () =>
      (this.beats || []).filter(b => this._beatMatchesFilter(b)).length);
  },

  // Gefilterte Beats einer Grid-Zelle — Pendant zu filteredBeatsForAct. Anders als
  // der flache Akt-Pfad gibt es im Grid keinen Verworfen-Collapse (Zellen sind klein,
  // verworfene Beats bleiben sichtbar/durchgestrichen).
  filteredBeatsForCell(actId, threadId) {
    const f = this.plotFilters;
    const base = this.beatsForCell(actId, threadId);
    if (!this.plotFilterActive()) return base;
    const tid = threadId == null ? null : threadId;
    return this._memo(`fcell:${actId}:${tid}`, [base, f.kapitel, f.figurId, f.draftFigurId, f.status, f.text], () =>
      base.filter(b => this._beatMatchesFilter(b)));
  },
};
