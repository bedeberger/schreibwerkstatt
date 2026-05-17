import { escHtml, fetchJson, SAFETY_HTML_RATIO, replaceInHtml, stripFocusArtefacts, fmtTok } from '../utils.js';
import { sortByPosition, SOFT_TYPEN } from '../book/page-view.js';
import { buildStilkorrekturPrompt } from '../prompts.js';
import { contentRepo } from '../repo/content.js';

// Lektorat-Workflow-Methoden (werden in die Alpine-Komponente gespreadet)
// `this` bezieht sich auf die Alpine-Komponente.

export const lektoratMethods = {
  _applyCorrections(html, fehler) {
    let result = html;
    for (const f of fehler) {
      if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
      result = replaceInHtml(result, f.original, f.korrektur);
    }
    return result;
  },

  // Stil-KI-Pipeline: KI ruft buildStilkorrekturPrompt, ergebnis wird
  // selektiv ins HTML zurueckgeschrieben. log fuer Persistenz in
  // page_checks.stilkorrektur_log. hardOriginals: Originaltexte der bereits
  // applizierten Hard-Findings — Stil-Findings mit Substring-Ueberlappung
  // werden VOR dem KI-Call gedroppt (sonst sucht KI Text, der nicht mehr da
  // ist).
  async _applyStilkorrektur(html, selectedStyles, onProgress, hardOriginals = []) {
    const aiBase = html.length || 1;
    const log = {
      requested: selectedStyles.length,
      returned: 0,
      applied: 0,
      items: [],
      error: null,
      attempted_at: new Date().toISOString(),
    };
    const usableStyles = [];
    for (const s of selectedStyles) {
      const orig = s.original || '';
      const overlap = orig && hardOriginals.some(h => h && (h.includes(orig) || orig.includes(h)));
      if (overlap) {
        log.items.push({ original: orig, ersatz: s.korrektur || '', applied: false, reason: 'overlapped_with_hard' });
      } else {
        usableStyles.push(s);
      }
    }
    if (usableStyles.length === 0) {
      console.info(`[stilkorrektur] requested=${log.requested} all dropped (overlapped_with_hard)`);
      return { html, log, appliedStyles: [] };
    }
    this.setStatus(this.t('stilkorrektur.workingChars', { chars: 0 }), true);
    try {
      let completionInfo = null;
      const result = await this.callAI(
        buildStilkorrekturPrompt(html, usableStyles),
        'stilkorrektur',
        (chars, tokIn) => {
          const status = (tokIn > 0)
            ? this.t('stilkorrektur.workingTokens', { tokIn: fmtTok(tokIn), tokOutEst: fmtTok(Math.round(chars / 4)) })
            : this.t('stilkorrektur.workingChars', { chars });
          this.setStatus(status, true);
          if (onProgress) onProgress(chars, aiBase);
        },
        ({ tokensIn, tokensOut, tokPerSec }) => { completionInfo = { tokensIn, tokensOut, tokPerSec }; }
      );
      if (completionInfo) {
        this.setStatus(this.t('stilkorrektur.done', {
          tokIn: fmtTok(completionInfo.tokensIn || 0),
          tokOut: fmtTok(completionInfo.tokensOut || 0),
          tps: completionInfo.tokPerSec ? Math.round(completionInfo.tokPerSec) : 0,
        }), true);
      }
      const korrekturen = Array.isArray(result?.korrekturen) ? result.korrekturen : [];
      log.returned = korrekturen.length;
      let outHtml = html;
      const styleApplied = new Array(usableStyles.length).fill(false);
      const countMatches = korrekturen.length === usableStyles.length;
      for (let i = 0; i < korrekturen.length; i++) {
        const k = korrekturen[i];
        const skip = !k.original || !k.ersatz || k.original === k.ersatz;
        const before = outHtml;
        const after = skip ? before : replaceInHtml(outHtml, k.original, k.ersatz);
        const applied = !skip && after !== before;
        let styleIdx = null;
        if (Number.isInteger(k.index)) {
          const cand = k.index - 1;
          if (cand >= 0 && cand < usableStyles.length) styleIdx = cand;
        }
        if (styleIdx === null && countMatches) styleIdx = i;
        log.items.push({
          index: k.index ?? null,
          style_idx: styleIdx,
          original: k.original || '',
          ersatz: k.ersatz || '',
          applied,
          reason: skip ? 'empty_or_identical' : (applied ? null : 'not_found_in_html'),
        });
        if (applied) {
          log.applied++;
          outHtml = after;
          if (styleIdx !== null) styleApplied[styleIdx] = true;
        }
      }
      const appliedStyles = usableStyles.filter((_, i) => styleApplied[i]);
      const dropped = log.requested - usableStyles.length;
      console.info(`[stilkorrektur] requested=${log.requested} dropped_overlap=${dropped} returned=${log.returned} applied=${log.applied} mappable=${appliedStyles.length}`);
      return { html: outHtml, log, appliedStyles };
    } catch (e) {
      console.error('[_applyStilkorrektur]', e);
      log.error = e?.message || String(e);
      this.setStatus(this.t('stilkorrektur.failed'), true);
      return { html, log, appliedStyles: [] };
    }
  },

  // Gemeinsamer Kern fuer Lektorat-Save und History-Apply:
  // Seite frisch laden → Hard-Korrekturen anwenden → Stilkorrektur → Safety-
  // Check → Speichern. `fresh: true` umgeht SWR; sonst koennte der CONTENT_CACHE
  // nach kurz zuvor gesetzten Edits noch die alte Fassung liefern und der
  // gleich folgende PUT wuerde frische Server-Edits mit Stale-Daten
  // ueberschreiben.
  async _loadApplyAndSave(selectedErrors, selectedStyles, onProgress) {
    onProgress(10, this.t('lektorat.loadingPage'));
    const page = await contentRepo.loadPage(this.currentPage.id, { fresh: true });
    page.html = stripFocusArtefacts(page.html || '');

    let finalHtml = selectedErrors.length > 0
      ? this._applyCorrections(page.html, selectedErrors)
      : page.html;

    let stilLog = null;
    let appliedStyles = [];
    if (selectedStyles.length > 0) {
      onProgress(30, null);
      const hardOriginals = selectedErrors.map(e => e?.original).filter(Boolean);
      const r = await this._applyStilkorrektur(
        finalHtml,
        selectedStyles,
        (chars, aiBase) => onProgress(Math.min(70, 30 + Math.round((chars / aiBase) * 40)), null),
        hardOriginals,
      );
      finalHtml = r.html;
      stilLog = r.log;
      appliedStyles = r.appliedStyles || [];
    }

    if (finalHtml.length < page.html.length * SAFETY_HTML_RATIO) {
      throw new Error(this.t('lektorat.unsafeHtml'));
    }

    onProgress(85, this.t('lektorat.saving'));
    // `page.updated_at` ist der frisch geladene Stand; PUT optimistisch gegen
    // genau diesen Stamp. Wenn dazwischen jemand schreibt → 409 vom Server.
    const saved = await contentRepo.savePage(this.currentPage.id, {
      html: finalHtml,
      name: this.currentPage.name,
      expected_updated_at: page.updated_at || null,
    });
    if (saved?.updated_at) this.currentPage.updated_at = saved.updated_at;
    // Uebernommene Korrekturen sind direkte Folge des Lektorats — Seite soll
    // nicht unmittelbar danach auf "seit Lektorat bearbeitet" flippen.
    this.markPageChecked?.(this.currentPage.id);
    this._syncPageStatsAfterSave?.(this.currentPage, finalHtml);
    return { finalHtml, stilLog, appliedStyles };
  },


  _recomputeCorrectedHtml() {
    if (!this.originalHtml) return;
    // Nur Nicht-Stil-Korrekturen können direkt angewendet werden (Stil läuft über KI-Reformulierung erst beim Speichern)
    const selected = this.lektoratFindings.filter((f, i) => this.selectedFindings[i] && f.typ !== 'stil');
    this.correctedHtml = selected.length > 0
      ? this._applyCorrections(this.originalHtml, selected)
      : this.originalHtml;
    this.updatePageView();
  },

  toggleFinding(i) {
    this.selectedFindings[i] = !this.selectedFindings[i];
    this._recomputeCorrectedHtml();
  },

  selectAllFindings(val) {
    this.selectedFindings = this.selectedFindings.map(() => val);
    this._recomputeCorrectedHtml();
  },

  closeFindings() {
    this.checkDone = false;
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.appliedHistoricCorrections = [];
    this.correctedHtml = null;
    this.hasErrors = false;
    this.analysisOut = '';
    this.checkStatus = '';
    this.activeHistoryEntryId = null;
    this.updatePageView();
  },

  async runCheck() {
    if (!this.currentPage) return;
    // Guard: Lektorat darf nicht auf nicht-persistierten Edits laufen.
    // Server-Job liest BookStack server-seitig; sind Edits nur lokal (offline-
    // Draft oder editDirty), sieht der Job die alte Fassung. Findings haben
    // dann Positionen aus altem Text, und der spätere Save-Pfad würde nach
    // einem zwischenzeitlichen Online-Retry ein Race auslösen, das Edits
    // überschreiben kann. Lieber blocken bis der Save durch ist.
    if (this.saveOffline || this.editDirty) {
      this.setStatus(this.t('lektorat.blockedUnsavedEdits'), false, 6000);
      return;
    }
    const pageIdAtStart = this.currentPage.id;
    this.logAuditEvent?.('lektoratOpened', { book: this.selectedBookId, page: pageIdAtStart });
    this.checkLoading = true;
    this.checkDone = false;
    this.activeHistoryEntryId = null;
    // originalHtml und renderedPageHtml beibehalten → Seitenansicht bleibt sichtbar
    this.correctedHtml = null;
    this.hasErrors = false;
    this.analysisOut = '';
    this.lektoratFindings = [];
    this.selectedFindings = [];
    this.appliedOriginals = [];
    this.appliedHistoricCorrections = [];
    this.checkProgress = 0;
    this.checkStatus = `<span class="spinner"></span>${escHtml(this.t('lektorat.starting'))}`;

    try {
      const { jobId } = await fetchJson('/jobs/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page_id: this.currentPage.id,
          book_id: this.currentPage.book_id || null,
          page_name: this.currentPage.name || null,
        }),
      });
      if (this.currentPage?.id !== pageIdAtStart) return;
      localStorage.setItem('lektorat_check_job_' + this.currentPage.id, jobId);
      this.startCheckPoll(jobId);
    } catch (e) {
      console.error('[runCheck]', e);
      if (this.currentPage?.id !== pageIdAtStart) return;
      this.analysisOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.checkStatus = '';
      this.checkLoading = false;
    }
  },

  startCheckPoll(jobId) {
    const pageId = this.currentPage?.id;
    // Per-pageId Timer-Slot: Wechselt User während laufendem Check auf eine
    // andere Seite, soll der Poll für die ursprüngliche Seite weiterlaufen
    // (sonst feuert `onDone` nie → Sidebar-Status der Ursprungsseite bleibt
    // stale). Ein zweiter Check für eine andere Seite kollidiert nicht.
    this._startPoll({
      timerProp: '_checkPollTimer_' + pageId,
      jobId,
      lsKey: pageId != null ? 'lektorat_check_job_' + pageId : null,
      onProgress: (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkProgress = job.progress || 0;
        this.checkStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      },
      onNotFound: () => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        this.analysisOut = `<span class="error-msg">${escHtml(this.t('job.interrupted'))}</span>`;
        this.checkStatus = '';
      },
      onError: (job) => {
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        this.analysisOut = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
        this.checkStatus = '';
      },
      onDone: async (job) => {
        // Sidebar-Status immer aktualisieren, auch wenn User inzwischen auf eine andere Seite gewechselt hat.
        const r = job.result || {};
        const fehler = r.fehler || [];
        if (!r.empty) this.markPageChecked(pageId, { pending: fehler.length > 0 });
        if (this.currentPage?.id !== pageId) return;
        this.checkLoading = false;
        setTimeout(() => { this.checkProgress = 0; }, 400);
        this.checkStatus = '';
        if (r.empty) {
          this.analysisOut = `<span class="muted-msg">${escHtml(this.t('job.pageEmpty'))}</span>`;
          return;
        }
        // Staleness-Guard: Server-Snapshot stammt aus dem Moment, in dem der Job
        // BookStack ausgelesen hat. Hat der User danach im Fokus-/Edit-Modus
        // gespeichert (oder externe Änderung in BookStack), passt `r.originalHtml`
        // nicht mehr zum aktuellen Stand und Findings-Positionen sind verschoben.
        // Originals einzelner Findings landen dann beim Speichern auf altem Text
        // → frische Edits werden überschrieben. Ergebnis verwerfen, User soll
        // erneut prüfen lassen.
        if (r.updatedAt && this.currentPage?.updated_at && r.updatedAt !== this.currentPage.updated_at) {
          this.analysisOut = `<span class="error-msg">${escHtml(this.t('lektorat.staleResultDropped'))}</span>`;
          return;
        }
        this.originalHtml = r.originalHtml;
        const findings = sortByPosition(r.originalHtml, fehler);
        this.lektoratFindings = findings;
        // Default selected: nur „harte" Typen (rechtschreibung, grammatik). Weiche Typen und Stil default unselected.
        this.selectedFindings = findings.map(f => !SOFT_TYPEN.has(f.typ) && f.typ !== 'stil');
        this.appliedOriginals = [];
        const hardErrors = findings.filter(f => !SOFT_TYPEN.has(f.typ) && f.typ !== 'stil');
        this.hasErrors = hardErrors.length > 0;
        this.correctedHtml = hardErrors.length > 0
          ? this._applyCorrections(r.originalHtml, hardErrors)
          : r.originalHtml;
        this.updatePageView();
        let out = '';
        const szenen = r.szenen || [];
        if (szenen.length > 0) {
          const wertungBadge = w => {
            if (w === 'stark')   return `<span class="badge badge-ok">${escHtml(this.t('szenen.rating.stark'))}</span>`;
            if (w === 'schwach') return `<span class="badge badge-err">${escHtml(this.t('szenen.rating.schwach'))}</span>`;
            return `<span class="badge badge-warn">${escHtml(this.t('szenen.rating.mittel'))}</span>`;
          };
          const rows = szenen.map(s =>
            `<div class="szene-item">
              <div class="szene-header">${wertungBadge(s.wertung)} <span class="szene-titel">${escHtml(s.titel)}</span></div>
              ${s.kommentar ? `<div class="szene-kommentar">${escHtml(s.kommentar)}</div>` : ''}
            </div>`
          ).join('');
          out += `<div class="stilbox"><div class="bewertung-section-title">${escHtml(this.t('lektorat.section.szenen'))}</div>${rows}</div>`;
        }
        if (r.stilanalyse) out += `<div class="stilbox"><div class="bewertung-section-title">${escHtml(this.t('lektorat.section.stilanalyse'))}</div>${escHtml(r.stilanalyse)}</div>`;
        if (r.fazit) out += `<div class="fazit">${escHtml(r.fazit)}</div>`;
        this.analysisOut = out;
        this.checkDone = true;
        this.lastCheckId = r.checkId || null;
        this.activeHistoryEntryId = r.checkId || null;
        if (pageId != null) await this.loadPageHistory(pageId);
        this.setStatus(this.t('job.analyseDone'), false, 5000);
      },
    });
  },

  async saveCorrections() {
    if (!this.currentPage) return;
    const selected = this.lektoratFindings.filter((_, i) => this.selectedFindings[i]);
    if (selected.length === 0) return;
    // Split: Stil-Typ läuft über KI-Reformulierung, Rest über direkte Textersetzung
    const selectedHard   = selected.filter(f => f.typ !== 'stil');
    const selectedStyles = selected.filter(f => f.typ === 'stil');

    try {
      const { finalHtml, stilLog, appliedStyles } = await this._loadApplyAndSave(selectedHard, selectedStyles, (pct, text) => {
        this.saveApplying = pct;
        if (text) this.setStatus(text, true);
      });

      if (this.lastCheckId) {
        try {
          this.saveApplying = 95;
          // applied = Hard-Findings + tatsächlich übernommene Stil-Findings.
          // Stil-Findings ohne Match (KI-Original passt nicht ins HTML) bleiben
          // bewusst draußen — sonst zeigt die History sie als gespeichert, obwohl
          // sie nie ins BookStack-HTML geschrieben wurden.
          let applied = [...selectedHard, ...(appliedStyles || [])];
          let selectedAll = selected;
          // Bei History-Einträgen: mit bereits angewendeten Korrekturen mergen
          if (this.activeHistoryEntryId) {
            const entry = this.pageHistory.find(e => e.id === this.activeHistoryEntryId);
            if (entry) {
              const merge = (existing, items) => {
                const set = new Set((existing || []).map(e => e.original));
                return [...(existing || []), ...items.filter(e => !set.has(e.original))];
              };
              applied = merge(entry.applied_errors_json, applied);
              selectedAll = merge(entry.selected_errors_json, selected);
            }
          }
          const body = { applied_errors_json: applied, selected_errors_json: selectedAll };
          if (stilLog) body.stilkorrektur_log = stilLog;
          const r = await fetch('/history/check/' + this.lastCheckId + '/saved', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          await this.loadPageHistory(this.currentPage.id);
          this.refreshPageAges();
        } catch (e) { console.error('[history saved]', e); }
      }
      this.saveApplying = null;
      this.setStatus(this.t('lektorat.correctionsSaved'), false, 5000);
      this.correctedHtml = null;
      this.hasErrors = false;
      this.lektoratFindings = [];
      this.selectedFindings = [];
      this.appliedOriginals = [];
      this.appliedHistoricCorrections = [];
      this.checkDone = false;
      this.activeHistoryEntryId = null;
      // Seitenansicht aus dem gerade gespeicherten HTML neu aufbauen
      this.originalHtml = finalHtml;
      this.renderedPageHtml = finalHtml;
      this.analysisOut = '';
    } catch (e) {
      console.error('[saveCorrections]', e);
      this.saveApplying = null;
      this.setStatus(this.t('common.errorColon') + e.message);
    }
  },

  async batchCheck() {
    if (!this.pages.length) return;
    if (!await this.appConfirm({ message: this.t('lektorat.batchConfirm', { n: this.pages.length }) })) return;
    this.batchLoading = true;
    this.batchProgress = 0;
    this.batchStatus = this._runningJobStatus(this.t('common.starting'), 0, 0);
    try {
      const { jobId } = await fetchJson('/jobs/batch-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ book_id: parseInt(this.selectedBookId), book_name: this.selectedBookName || null }),
      });
      localStorage.setItem('lektorat_batchcheck_job_' + this.selectedBookId, jobId);
      this.startBatchPoll(jobId);
    } catch (e) {
      console.error('[batchCheck]', e);
      this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(e.message)}</span>`;
      this.batchLoading = false;
    }
  },

  startBatchPoll(jobId) {
    const bookId = this.selectedBookId;
    this._startPoll({
      timerProp: '_batchPollTimer',
      jobId,
      lsKey: 'lektorat_batchcheck_job_' + bookId,
      progressProp: 'batchProgress',
      onProgress: (job) => {
        this.batchStatus = this._runningJobStatus(job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut, job.progress, job.tokensPerSec, job.statusParams);
      },
      onNotFound: () => {
        this.batchLoading = false;
        this.batchStatus = this.t('job.interrupted');
      },
      onError: (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        this.batchStatus = `<span class="error-msg">${this.t('common.errorColon')}${escHtml(this.t(job.error, job.errorParams))}</span>`;
      },
      onDone: async (job) => {
        this.batchLoading = false;
        setTimeout(() => { this.batchProgress = 0; }, 400);
        if (job.result?.empty) { this.batchStatus = this.t('lektorat.batchNoPages'); return; }
        const r = job.result;
        this.batchStatus = this.t('lektorat.batchDone', { done: r.done, total: r.pageCount, errors: r.totalErrors });
        this.refreshPageAges();
        if (this.currentPage) await this.loadPageHistory(this.currentPage.id);
      },
    });
  },
};
