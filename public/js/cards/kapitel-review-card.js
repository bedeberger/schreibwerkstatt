// Alpine.data('kapitelReviewCard') — Sub-Komponente der Kapitel-Bewertung.
// Per-Kapitel-Job-State: jeder Run/Reconnect schreibt in seinen eigenen Slot.
// Getter (`kapitelReviewLoading/Progress/Status/Out`) lesen den Slot des
// aktuell angezeigten Kapitels — beim Wechsel auf ein anderes Kapitel sieht
// der User dort sein eigenes Loading/Output, nicht den Status eines parallel
// laufenden Reviews.

import { fetchJson, escHtml, renderStars, noteTip } from '../utils.js';
import { renderReviewHtml, CHAPTER_REVIEW_AXES } from '../book/review.js';
import { startPoll, runningJobStatus } from './job-helpers.js';
import { setupCardLifecycle } from './card-lifecycle.js';
import { contentRepo } from '../repo/content.js';

function emptySlot() {
  return { loading: false, progress: 0, status: '', out: '', jobId: null, pollTimer: null };
}

export function registerKapitelReviewCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('kapitelReviewCard', () => ({
    // kapitelReviewChapterId lebt am Root (Hash-Router + Sidebar lesen es).
    kapitelReviewHistory: {},
    selectedKapitelReviewId: null,
    _kapitelReviewByChapter: {}, // { [chapterId]: emptySlot() }
    _lifecycle: null,

    init() {
      const onSelectChapter = (e) => {
        const chapterId = e.detail?.chapterId;
        if (!chapterId) return;
        const opts = this.kapitelReviewChapterOptions();
        if (!opts.some(c => String(c.id) === String(chapterId))) return;
        window.__app.kapitelReviewChapterId = String(chapterId);
      };

      // Backstop für Done-Events ohne lokalen per-Slot-Poller (z.B. Job lief in
      // anderem Tab oder Slot wurde durch Buchwechsel zerstört). Lädt History
      // neu, damit der Eintrag in der Card auftaucht.
      const onJobFinished = (e) => {
        const d = e.detail;
        if (d?.type !== 'chapter-review' || d.job?.status !== 'done') return;
        const root = window.__app;
        if (!root.selectedBookId || String(d.bookId) !== String(root.selectedBookId)) return;
        this.loadKapitelReviewHistory(root.selectedBookId);
      };

      const onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'kapitel-review') return;
        const chapterId = d.extra?.chapterId;
        if (!chapterId) return;
        const root = window.__app;
        const slot = this._ensureSlot(chapterId);
        slot.loading = true;
        slot.progress = d.job.progress || 0;
        slot.out = '';
        slot.status = this._formatStatus(
          d.job.statusText ? root.t(d.job.statusText, d.job.statusParams) : root.t('common.analysisRunning'),
          true,
        );
        // Reconnect zeigt das wiedergefundene Kapitel auch an.
        root.kapitelReviewChapterId = String(chapterId);
        this.startKapitelReviewPoll(d.jobId, chapterId);
      };

      const reset = (ctx) => {
        ctx._clearAllPollTimers();
        ctx._kapitelReviewByChapter = {};
        window.__app.kapitelReviewChapterId = '';
        ctx.selectedKapitelReviewId = null;
        ctx.kapitelReviewHistory = {};
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'kapitelReview',
        showFlag: 'showKapitelReviewCard',
        timerKeys: [],
        showNeedsBookId: false,
        onShow: () => this._openKapitelReview(),
        load: (root) => this.loadKapitelReviewHistory(root.selectedBookId),
        onBookChanged: (e, ctx) => reset(ctx),
        onViewReset:   (e, ctx) => reset(ctx),
        extraListeners: [
          { type: 'kapitel-review:select', handler: onSelectChapter },
          { type: 'job:reconnect',         handler: onJobReconnect },
          { type: 'job:finished',          handler: onJobFinished },
        ],
      });
    },

    destroy() {
      this._clearAllPollTimers();
      this._lifecycle?.destroy();
    },

    // --- Per-Kapitel-Slot-Zugriff ----------------------------------------

    _slotFor(chapterId) {
      const id = String(chapterId || '');
      return id ? (this._kapitelReviewByChapter[id] || null) : null;
    },
    _ensureSlot(chapterId) {
      const id = String(chapterId || '');
      if (!id) return null;
      if (!this._kapitelReviewByChapter[id]) this._kapitelReviewByChapter[id] = emptySlot();
      return this._kapitelReviewByChapter[id];
    },
    _currentSlot() {
      // Read-only: kein Slot anlegen beim Lesen (würde Render-Side-Effects erzeugen).
      return this._slotFor(window.__app.kapitelReviewChapterId) || emptySlot();
    },
    _clearAllPollTimers() {
      for (const slot of Object.values(this._kapitelReviewByChapter || {})) {
        if (slot.pollTimer) { clearInterval(slot.pollTimer); slot.pollTimer = null; }
      }
    },
    _formatStatus(msg, spinner = false) {
      const safe = escHtml(msg);
      return spinner ? `<span class="spinner"></span>${safe}` : safe;
    },

    get kapitelReviewLoading()  { return this._currentSlot().loading; },
    get kapitelReviewProgress() { return this._currentSlot().progress; },
    get kapitelReviewStatus()   { return this._currentSlot().status; },
    get kapitelReviewOut()      { return this._currentSlot().out; },

    _lsKeyKapitelReview(chapterId) {
      return `lektorat_chapter_review_job_${window.__app.selectedBookId}_${chapterId}`;
    },

    renderStars(note) { return renderStars(note); },
    noteTip(note) { return noteTip(note); },

    _renderKapitelReviewHtml(r) {
      return renderReviewHtml(r, CHAPTER_REVIEW_AXES, (k, p) => window.__app.t(k, p));
    },

    startKapitelReviewPoll(jobId, chapterId) {
      const root = window.__app;
      const slot = this._ensureSlot(chapterId);
      if (!slot) return;
      slot.jobId = jobId;
      startPoll(slot, {
        timerProp: 'pollTimer',
        jobId,
        lsKey: this._lsKeyKapitelReview(chapterId),
        progressProp: 'progress',
        onProgress: (job) => {
          slot.status = runningJobStatus(
            (k, p) => root.t(k, p),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams,
          );
        },
        onNotFound: () => {
          slot.loading = false;
          slot.status = this._formatStatus(root.t('job.interrupted'));
        },
        onError: (job) => {
          slot.loading = false;
          slot.out = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(root.t(job.error, job.errorParams))}</span>`;
          slot.status = '';
        },
        onDone: async (job) => {
          slot.loading = false;
          if (job.result?.empty) {
            slot.status = this._formatStatus(root.t('kapitelReview.noPages'));
            return;
          }
          const r = job.result?.review;
          if (r) {
            slot.out = this._renderKapitelReviewHtml(r);
            setTimeout(() => { slot.progress = 0; }, 400);
            slot.status = this._formatStatus(root.t('kapitelReview.pagesAnalyzed', { n: job.result.pageCount || '?' }));
            if (root.selectedBookId) await this.loadKapitelReviewHistory(root.selectedBookId);
          }
        },
      });
    },

    async loadKapitelReviewHistory(bookId) {
      try {
        this.kapitelReviewHistory = await fetchJson('/history/chapter-reviews/' + bookId) || {};
      } catch (e) {
        console.error('[loadKapitelReviewHistory]', e);
        this.kapitelReviewHistory = {};
      }
    },

    // Wird beim Öffnen der Karte (über den $watch) aufgerufen — setzt ein
    // Default-Kapitel und lädt die History.
    async _openKapitelReview() {
      const current = window.__app.kapitelReviewChapterId;
      const eligible = this.kapitelReviewChapterOptions();
      const stillValid = current && eligible.some(c => String(c.id) === String(current));
      if (!stillValid) {
        window.__app.kapitelReviewChapterId = eligible.length ? String(eligible[0].id) : '';
      }
      if (window.__app.selectedBookId) {
        await this.loadKapitelReviewHistory(window.__app.selectedBookId);
      }
    },

    async runKapitelReview() {
      const root = window.__app;
      const bookId = root.selectedBookId;
      const bookName = root.selectedBookName;
      const chapterId = root.kapitelReviewChapterId;
      if (!chapterId) return;
      const chapter = (root.tree || []).find(i => i.type === 'chapter' && String(i.id) === String(chapterId));
      const chapterName = chapter?.name || '';
      const slot = this._ensureSlot(chapterId);
      slot.loading = true;
      slot.progress = 0;
      slot.out = '';
      slot.status = this._formatStatus(root.t('kapitelReview.starting'), true);
      root.showKapitelReviewCard = true;
      try {
        const { jobId } = await fetchJson('/jobs/chapter-review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            book_id: parseInt(bookId),
            chapter_id: parseInt(chapterId),
            chapter_name: chapterName,
            book_name: bookName,
          }),
        });
        localStorage.setItem(this._lsKeyKapitelReview(chapterId), jobId);
        this.startKapitelReviewPoll(jobId, chapterId);
      } catch (e) {
        console.error('[runKapitelReview]', e);
        slot.out = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(e.message)}</span>`;
        slot.status = '';
        slot.loading = false;
      }
    },

    async deleteKapitelReview(id) {
      try {
        await fetchJson('/history/chapter-review/' + id, { method: 'DELETE' });
        if (window.__app.selectedBookId) await this.loadKapitelReviewHistory(window.__app.selectedBookId);
      } catch (e) {
        console.error('[deleteKapitelReview]', e);
      }
    },

    // Sobald ein Buch als „strukturiert" erkennbar ist (≥2 Kapitel und
    // mindestens eines mit mehreren Seiten), lohnt sich das Kapitel-Review für
    // alle Kapitel – auch für solche mit nur einer Seite.
    _bookQualifiesForChapterReview() {
      const chapters = (window.__app.tree || []).filter(i => i.type === 'chapter' && !i.solo);
      return chapters.length >= 2 && chapters.some(c => c.pages.length > 1);
    },

    // Liste der Kapitel, die fürs Kapitel-Review anklickbar sind.
    kapitelReviewChapterOptions() {
      if (!this._bookQualifiesForChapterReview()) return [];
      return (window.__app.tree || [])
        .filter(i => i.type === 'chapter' && !i.solo && i.pages.length > 0)
        .map(c => ({ id: c.id, name: c.name, pageCount: c.pages.length }));
    },

    kapitelReviewSelectedChapter() {
      if (!window.__app.kapitelReviewChapterId) return null;
      return (window.__app.tree || []).find(i =>
        i.type === 'chapter' && !i.solo && String(i.id) === String(window.__app.kapitelReviewChapterId)
      ) || null;
    },

    kapitelReviewLastEditAt() {
      const ch = this.kapitelReviewSelectedChapter();
      if (!ch?.pages?.length) return null;
      let max = 0;
      for (const p of ch.pages) {
        const t = p.updated_at ? new Date(p.updated_at).getTime() : 0;
        if (t > max) max = t;
      }
      return max ? new Date(max).toISOString() : null;
    },

    kapitelReviewChapterStats() {
      const ch = this.kapitelReviewSelectedChapter();
      if (!ch || !ch.pages?.length) return null;
      const ests = window.__app.tokEsts || {};
      let chars = 0, words = 0, tok = 0, any = false;
      for (const p of ch.pages) {
        const e = ests[p.id];
        if (!e) continue;
        any = true;
        chars += e.chars || 0;
        words += e.words || 0;
        tok   += e.tok   || 0;
      }
      return any ? { chars, words, tok } : null;
    },

    kapitelReviewCurrentHistory() {
      if (!window.__app.kapitelReviewChapterId) return [];
      return this.kapitelReviewHistory?.[String(window.__app.kapitelReviewChapterId)] || [];
    },

    // Schnell eine Seite im aktuellen Kapitel anlegen. BookStack hängt neue
    // Seiten automatisch ans Ende an — Baum + Flat-Liste lokal einhängen, dann
    // zur neuen Seite springen.
    async createKapitelPage() {
      const root = window.__app;
      const chapter = this.kapitelReviewSelectedChapter();
      const title = (root.newPageTitle || '').trim();
      if (!chapter || !title || root.newPageCreating) return;
      root.newPageCreating = true;
      root.newPageError = '';
      try {
        const created = await contentRepo.createPage({
          chapter_id: parseInt(chapter.id),
          name: title,
          html: '<p></p>',
        });
        root.newPageTitle = '';
        if (!created?.id) return;
        const newPage = {
          ...created,
          chapterName: chapter.name,
        };
        root.pages.push(newPage);
        const chapterItem = root.tree.find(i =>
          i.type === 'chapter' && !i.solo && String(i.id) === String(chapter.id)
        );
        if (chapterItem) {
          chapterItem.pages.push(newPage);
          chapterItem.open = true;
        }
        root.tokEsts[newPage.id] = { tok: 0, words: 0, chars: 0 };
        await root.selectPage(newPage);
      } catch (e) {
        console.error('[createKapitelPage]', e);
        root.newPageError = e.message || root.t('common.unknownError');
      } finally {
        root.newPageCreating = false;
      }
    },

    // Neues Kapitel direkt unter dem aktuell angezeigten Kapitel einhängen
    // und sofort zum neuen Kapitel navigieren, damit der User dort eine
    // erste Seite anlegen kann. ID wird direkt am Root gesetzt — der
    // kapitel-review:select-Handler filtert via kapitelReviewChapterOptions()
    // 0-Seiten-Kapitel raus und wäre für ein frisches Kapitel ein No-Op.
    async createSiblingChapter() {
      const root = window.__app;
      const current = this.kapitelReviewSelectedChapter();
      if (!current || root.newChapterCreating) return;
      const created = await root.createChapter({ afterChapterId: current.id });
      if (!created) return;
      root.kapitelReviewChapterId = String(created.id);
    },
  }));
}
