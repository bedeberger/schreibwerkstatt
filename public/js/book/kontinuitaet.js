// Kontinuitätsprüfer-Methoden (werden in Alpine.data('kontinuitaetCard')
// gespreadet). Ergebnisse stammen aus der Komplettanalyse (Phase 8) und werden
// via _loadKontinuitaetHistory (GET) angezeigt; Anzeige + Filter + Resolve-Toggle.

import { fetchJson } from '../utils.js';
import { startPoll, runningJobStatus } from '../cards/job-helpers.js';

export const kontinuitaetMethods = {
  // ── Weltfakten-Faktencheck ──────────────────────────────────────────────────
  // Eigener KI-Job (/jobs/faktencheck): prüft extrahierte Welt-Fakten per Web-Suche
  // gegen die reale Faktenlage. Ergebnisse (typ='faktenfehler') werden an den
  // neuesten Kontinuitäts-Check angehängt und erscheinen in derselben Liste. Nur
  // wenn instanzweit freigeschaltet (Karte zeigt den Button nur dann) UND das Buch
  // opt-in hat (sonst 400 → Hinweis auf die Bucheinstellungen).
  async faktencheckRun() {
    const root = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.kontinuitaetLoading) return;
    this.kontinuitaetLoading = true;
    this.kontinuitaetProgress = 1;
    this.kontinuitaetStatus = runningJobStatus(root.t, 'kontinuitaet.faktencheck.starting');
    const clearRunState = () => {
      this.kontinuitaetLoading = false;
      this.kontinuitaetProgress = 0;
      this.kontinuitaetStatus = '';
    };
    try {
      const resp = await fetch('/jobs/faktencheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: bookId, book_name: root.selectedBookName || '' }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok || !data.jobId) {
        clearRunState();
        if (data.error_code === 'FACTCHECK_NOT_ENABLED_FOR_BOOK') {
          this.kontinuitaetStatus = `<span>${root.t('kontinuitaet.faktencheck.hint')}</span>`;
        }
        return;
      }
      startPoll(this, {
        jobId: data.jobId,
        timerProp: '_kontinuitaetPollTimer',
        progressProp: 'kontinuitaetProgress',
        onProgress: (job) => {
          this.kontinuitaetStatus = runningJobStatus(
            root.t, job.statusText, job.tokensIn, job.tokensOut,
            Alpine.store('config').claudeMaxTokens, job.progress, job.tps, job.statusParams);
        },
        onDone: async () => { clearRunState(); await this._loadKontinuitaetHistory(); },
        onError: async () => { clearRunState(); },
        onNotFound: () => { clearRunState(); },
      });
    } catch (e) {
      clearRunState();
      console.error('[faktencheckRun]', e);
    }
  },

  async _loadKontinuitaetHistory() {
    try {
      const data = await fetchJson('/jobs/kontinuitaet/' + Alpine.store('nav').selectedBookId);
      this.kontinuitaetResult = data;
    } catch (e) {
      console.error('[_loadKontinuitaetHistory]', e);
    }
  },

  // Issues gefiltert nach UI-Filtern (figurId, kapitel). Reads figuren+tree
  // from root. Muss eine Methode sein (keine `get`-Syntax): `kontinuitaetMethods`
  // wird per `...spread` in die Alpine.data-Factory übernommen, und Spread ruft
  // Getter auf und speichert nur den Wert — die Reaktivität auf Filter/Result
  // ginge verloren, und der Wert wäre zur Spread-Zeit `[]`.
  kontinuitaetIssuesFiltered() {
    const root = window.__app;
    const filters = Alpine.store('catalogUi').kontinuitaetFilters;
    const chapters = (Alpine.store('nav').tree || []).filter(t => t.type === 'chapter');
    const chapterNames = new Set(chapters.map(t => t.name));
    const fromStelle = (s) => {
      if (!s) return null;
      const ci = s.indexOf(':');
      const c = ci > 0 ? s.substring(0, ci).trim() : s.trim();
      return chapterNames.has(c) ? c : null;
    };
    return (this.kontinuitaetResult?.issues || []).filter(issue => {
      if (filters.figurId) {
        if (issue.fig_ids?.length) {
          if (!issue.fig_ids.includes(filters.figurId)) return false;
        } else {
          const selectedName = root.$store.catalog.figuren.find(f => f.id === filters.figurId)?.name || '';
          if (selectedName && !(issue.figuren || []).includes(selectedName)) return false;
        }
      }
      if (filters.kapitel) {
        const f = filters.kapitel;
        const selectedId = chapters.find(t => t.name === f)?.id;
        const idMatch    = selectedId !== undefined && issue.chapter_ids?.includes(selectedId);
        const nameMatch  = (issue.kapitel || []).includes(f);
        const stelleMatch = fromStelle(issue.stelle_a) === f || fromStelle(issue.stelle_b) === f;
        if (!idMatch && !nameMatch && !stelleMatch) return false;
      }
      if (filters.schwere) {
        const s = issue.schwere || 'niedrig';
        if (s !== filters.schwere) return false;
      }
      return true;
    });
  },

  kontinuitaetIssuesSorted() {
    const order = { kritisch: 0, mittel: 1, niedrig: 2 };
    const list = this.kontinuitaetIssuesFiltered().slice();
    list.sort((a, b) => {
      // Erledigte ans Ende, danach nach Schwere.
      const ra = a.resolved ? 1 : 0;
      const rb = b.resolved ? 1 : 0;
      if (ra !== rb) return ra - rb;
      const sa = order[a.schwere || 'niedrig'] ?? 2;
      const sb = order[b.schwere || 'niedrig'] ?? 2;
      return sa - sb;
    });
    return list;
  },

  // Selektions-/Render-Key: bevorzugt die DB-Issue-ID (stabil bis zum nächsten
  // Komplettanalyse-Lauf), Fallback auf Komposit für Alt-Antworten ohne ID.
  kontinuitaetIssueKey(issue, i) {
    if (issue?.id != null) return 'id:' + issue.id;
    return (issue.typ || '') + '|' + (issue.stelle_a || '') + '|' + (issue.stelle_b || '') + '|' + i;
  },

  // Erledigt-Status umschalten. Optimistisch + Rollback bei Fehler. Gültig bis
  // zur nächsten Komplettanalyse (frische Issue-Zeilen, resolved=0).
  async kontinuitaetToggleResolved(issue) {
    if (!issue || issue.id == null) return;
    const next = !issue.resolved;
    issue.resolved = next;
    try {
      await fetchJson('/jobs/kontinuitaet/issue/' + issue.id + '/resolved', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: next }),
      });
    } catch (e) {
      issue.resolved = !next;
      console.error('[kontinuitaetToggleResolved]', e);
    }
  },

  // Anzahl noch offener (nicht erledigter) Issues im aktuellen Check.
  kontinuitaetOpenCount() {
    return (this.kontinuitaetResult?.issues || []).filter(i => !i.resolved).length;
  },

  // Menschliches Label für den Issue-Typ. Freitext-Feld (Prompt-gesteuert) → i18n-Key
  // mit Fallback auf den Rohwert, damit unbekannte/neue Typen nie leer rendern.
  kontinuitaetTypLabel(typ) {
    const t = window.__app.t('kontinuitaet.typ.' + (typ || ''));
    return t === 'kontinuitaet.typ.' + (typ || '') ? (typ || '') : t;
  },

  kontinuitaetIssuesBySchwere() {
    if (!this.kontinuitaetResult?.issues) return { kritisch: [], mittel: [], niedrig: [] };
    const groups = { kritisch: [], mittel: [], niedrig: [] };
    for (const issue of this.kontinuitaetIssuesFiltered()) {
      const s = issue.schwere || 'niedrig';
      if (groups[s]) groups[s].push(issue);
      else groups.niedrig.push(issue);
    }
    return groups;
  },

  kontinuitaetKapitelListe() {
    const root = window.__app;
    const chapterById = new Map(
      (Alpine.store('nav').tree || []).filter(t => t.type === 'chapter').map(t => [t.id, t.name])
    );
    const chapterNames = new Set(chapterById.values());
    const fromStelle = (s) => {
      if (!s) return null;
      const ci = s.indexOf(':');
      const c = ci > 0 ? s.substring(0, ci).trim() : s.trim();
      return chapterNames.has(c) ? c : null;
    };
    const names = new Set();
    for (const issue of (this.kontinuitaetResult?.issues || [])) {
      if (issue.chapter_ids?.length) {
        for (const id of issue.chapter_ids) { const n = chapterById.get(id); if (n) names.add(n); }
      }
      if (issue.kapitel?.length) {
        for (const k of issue.kapitel) if (k && chapterNames.has(k)) names.add(k);
      }
      const a = fromStelle(issue.stelle_a); if (a) names.add(a);
      const b = fromStelle(issue.stelle_b); if (b) names.add(b);
    }
    return root._sortByChapterOrder([...names]);
  },

  // Löst "stelle_a/stelle_b" zu einem Page-Objekt auf. `stelle` ist ein
  // LLM-generierter String – Format nominal "Kapitel: Seite", kann aber
  // auch nur "Kapitel" sein. Authoritativer Kontext: issue.chapter_ids.
  //
  // Wichtig: Reine Kapitelreferenz (kein ":" oder part1 == Kapitelname)
  // verlinkt IMMER auf die erste Kapitelseite, NIE auf eine gleichnamige
  // Seite – sonst landet "Der Vater" (Kapitel) versehentlich auf einer
  // Seite namens "Der Vater" (in irgendeinem Kapitel). Globalen Page-
  // Fallback gibt es nicht: ohne Kapitelkontext kein Link.
  kontinuitaetResolveStelle(stelle, issue, side) {
    const root = window.__app;
    if (!stelle) return null;
    const chapters = (Alpine.store('nav').tree || []).filter(t => t.type === 'chapter');
    const chIds = issue?.chapter_ids || [];
    const idx = side === 'b' && chIds.length > 1 ? 1 : 0;
    const targetCh = chIds[idx] ? chapters.find(c => c.id === chIds[idx]) : null;

    const ci = stelle.indexOf(':');
    const part1 = (ci > 0 ? stelle.slice(0, ci) : stelle).trim();
    const part2 = ci > 0 ? stelle.slice(ci + 1).trim() : '';

    const chapter = targetCh || chapters.find(c => c.name === part1) || null;
    if (!chapter) return null;

    const pageByName = (pages, needle) => {
      if (!pages?.length || !needle) return null;
      const nLower = needle.toLowerCase();
      return pages.find(p => p.name === needle)
        || pages.find(p => p.name.toLowerCase() === nLower)
        || null;
    };

    if (!part2) {
      // Reine Kapitelreferenz → erste Kapitelseite (auch wenn gleichnamige
      // Seite existiert). Wenn part1 nicht der Kapitelname ist, kann es
      // ein Seitenname innerhalb des Kapitels sein.
      if (part1.toLowerCase() === chapter.name.toLowerCase()) {
        return chapter.pages?.[0] || null;
      }
      return pageByName(chapter.pages, part1) || chapter.pages?.[0] || null;
    }
    return pageByName(chapter.pages, part2) || chapter.pages?.[0] || null;
  },

  kontinuitaetGotoStelle(stelle, issue, side) {
    const page = this.kontinuitaetResolveStelle(stelle, issue, side);
    if (page) window.__app.selectPage(page);
  },

  // ── Namens-/Konsistenz-Waechter ────────────────────────────────────────────
  // Regelbasierte Erkennung buchweiter Schreibvarianten/Tippfehler von Eigennamen
  // (Figuren + Orte). Synchroner Endpunkt, kein KI-Job. Auf Knopfdruck.
  async nameGuardRun() {
    const root = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || this.nameGuardLoading) return;
    this.nameGuardLoading = true;
    try {
      const data = await fetchJson('/name-guard/' + bookId + '/check', { method: 'POST' });
      this.nameGuardResult = data;
      this.selectedNameGuardKey = null;
    } catch (e) {
      console.error('[nameGuardRun]', e);
      this.nameGuardResult = { clusters: [], error: true };
    } finally {
      this.nameGuardLoading = false;
    }
  },

  nameGuardKey(cluster) {
    return 'ng:' + (cluster?.canonical || '');
  },

  nameGuardConfidenceSeverity(conf) {
    // Auf die bestehende severity-tag-Farbskala mappen (Farbe = Aufmerksamkeit):
    // hohe Konfidenz = stark hervorgehoben.
    return conf === 'hoch' ? 'kritisch' : (conf === 'mittel' ? 'mittel' : 'niedrig');
  },

  // Eine Variante als gewollt akzeptieren → serverseitige Ignore-Liste + lokal entfernen.
  async nameGuardIgnore(cluster, variant) {
    const root = window.__app;
    const bookId = Alpine.store('nav').selectedBookId;
    if (!bookId || !cluster || !variant) return;
    try {
      await fetchJson('/name-guard/' + bookId + '/ignore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canonical: cluster.canonical, variant: variant.form }),
      });
      cluster.variants = (cluster.variants || []).filter(v => v.form !== variant.form);
      if (!cluster.variants.length && this.nameGuardResult?.clusters) {
        this.nameGuardResult.clusters = this.nameGuardResult.clusters.filter(c => c !== cluster);
      }
    } catch (e) {
      console.error('[nameGuardIgnore]', e);
    }
  },
};
