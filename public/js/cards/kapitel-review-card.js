// Alpine.data('kapitelReviewCard') — Sub-Komponente der Kapitel-Bewertung.
// Job-Flow manuell implementiert (kein createCardJobFeature), weil der
// Start-Payload kapitelbezogen ist und die Poll-Logik
// _kapitelReviewRunningChapterId trackt.

import { fetchJson, escHtml, escMd, renderStars } from '../utils.js';
import { startPoll, runningJobStatus } from './job-helpers.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerKapitelReviewCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('kapitelReviewCard', () => ({
    // kapitelReviewChapterId lebt am Root (Hash-Router + Sidebar lesen es).
    kapitelReviewLoading: false,
    kapitelReviewProgress: 0,
    kapitelReviewStatus: '',
    kapitelReviewOut: '',
    kapitelReviewHistory: {},
    selectedKapitelReviewId: null,
    _kapitelReviewPollTimer: null,
    _kapitelReviewRunningChapterId: '',
    _lifecycle: null,

    init() {
      const onSelectChapter = (e) => {
        const chapterId = e.detail?.chapterId;
        if (!chapterId) return;
        const opts = this.kapitelReviewChapterOptions();
        if (!opts.some(c => String(c.id) === String(chapterId))) return;
        const switching = String(window.__app.kapitelReviewChapterId) !== String(chapterId);
        window.__app.kapitelReviewChapterId = String(chapterId);
        if (switching) {
          this.kapitelReviewOut = '';
          this.setKapitelReviewStatus('');
        }
      };

      const onJobReconnect = (e) => {
        const d = e.detail;
        if (d?.type !== 'kapitel-review') return;
        const job = d.job;
        const chapterId = d.extra?.chapterId;
        this.kapitelReviewLoading = true;
        this.kapitelReviewProgress = job.progress || 0;
        window.__app.kapitelReviewChapterId = String(chapterId);
        this._kapitelReviewRunningChapterId = String(chapterId);
        this.kapitelReviewOut = '';
        this.setKapitelReviewStatus(
          job.statusText ? window.__app.t(job.statusText, job.statusParams) : window.__app.t('common.analysisRunning'),
          true,
        );
        this.startKapitelReviewPoll(d.jobId, chapterId);
      };

      // Reset zieht zusätzlich den Root-State `kapitelReviewChapterId`,
      // deshalb eigener Override statt resetState.
      const reset = (ctx) => {
        ctx.kapitelReviewLoading = false;
        ctx.kapitelReviewProgress = 0;
        ctx.kapitelReviewStatus = '';
        ctx.kapitelReviewOut = '';
        window.__app.kapitelReviewChapterId = '';
        ctx._kapitelReviewRunningChapterId = '';
        ctx.selectedKapitelReviewId = null;
        ctx.kapitelReviewHistory = {};
      };

      this._lifecycle = setupCardLifecycle(this, {
        name: 'kapitelReview',
        showFlag: 'showKapitelReviewCard',
        timerKeys: ['_kapitelReviewPollTimer'],
        showNeedsBookId: false,
        onShow: () => this._openKapitelReview(),
        load: (root) => this.loadKapitelReviewHistory(root.selectedBookId),
        onBookChanged: (e, ctx) => reset(ctx),
        onViewReset:   (e, ctx) => reset(ctx),
        extraListeners: [
          { type: 'kapitel-review:select', handler: onSelectChapter },
          { type: 'job:reconnect',         handler: onJobReconnect },
        ],
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    _lsKeyKapitelReview(chapterId) {
      return `lektorat_chapter_review_job_${window.__app.selectedBookId}_${chapterId}`;
    },

    renderStars(note) { return renderStars(note); },

    _renderKapitelReviewHtml(r) {
      const t = (k, p) => window.__app.t(k, p);
      const stars = renderStars(r.gesamtnote);
      let html = `
          <div class="bewertung-header">
            <span class="bewertung-stars">${stars}</span>
            <span class="bewertung-header-note">${escMd(r.gesamtnote_begruendung || '')}</span>
          </div>
          <div class="stilbox stilbox--review-summary">${escMd(r.zusammenfassung || '')}</div>`;
      const sections = [
        ['dramaturgie', 'kapitelReview.section.dramaturgie'],
        ['pacing',      'kapitelReview.section.pacing'],
        ['kohaerenz',   'kapitelReview.section.kohaerenz'],
        ['perspektive', 'kapitelReview.section.perspektive'],
        ['figuren',     'kapitelReview.section.figuren'],
      ];
      for (const [key, i18n] of sections) {
        if (r[key]) html += `
            <div class="bewertung-section">
              <div class="bewertung-section-title">${escHtml(t(i18n))}</div>
              <p class="bewertung-section-text">${escMd(r[key])}</p>
            </div>`;
      }
      if (r.staerken?.length) html += `
            <div class="bewertung-section">
              <div class="bewertung-section-title">${escHtml(t('review.strengths'))}</div>
              <ul class="bullet-list pos">${r.staerken.map(s => `<li>${escMd(s)}</li>`).join('')}</ul>
            </div>`;
      if (r.schwaechen?.length) html += `
            <div class="bewertung-section">
              <div class="bewertung-section-title">${escHtml(t('review.weaknesses'))}</div>
              <ul class="bullet-list neg">${r.schwaechen.map(s => `<li>${escMd(s)}</li>`).join('')}</ul>
            </div>`;
      if (r.empfehlungen?.length) html += `
            <div class="bewertung-section">
              <div class="bewertung-section-title">${escHtml(t('review.section.empfehlungen'))}</div>
              <ul class="bullet-list">${r.empfehlungen.map(s => `<li>${escMd(s)}</li>`).join('')}</ul>
            </div>`;
      if (r.fazit) html += `<div class="fazit fazit--review">${escMd(r.fazit)}</div>`;
      return html;
    },

    setKapitelReviewStatus(msg, spinner = false) {
      const safe = escHtml(msg);
      this.kapitelReviewStatus = spinner
        ? `<span class="spinner"></span>${safe}`
        : safe;
    },

    startKapitelReviewPoll(jobId, chapterId) {
      const root = window.__app;
      startPoll(this, {
        timerProp: '_kapitelReviewPollTimer',
        jobId,
        lsKey: this._lsKeyKapitelReview(chapterId),
        progressProp: 'kapitelReviewProgress',
        onProgress: (job) => {
          this.kapitelReviewStatus = runningJobStatus(
            (k, p) => root.t(k, p),
            job.statusText, job.tokensIn, job.tokensOut, job.maxTokensOut,
            job.progress, job.tokensPerSec, job.statusParams,
          );
        },
        onNotFound: () => {
          this.kapitelReviewLoading = false;
          this._kapitelReviewRunningChapterId = '';
          this.setKapitelReviewStatus(root.t('job.interrupted'));
        },
        onError: (job) => {
          this.kapitelReviewLoading = false;
          this._kapitelReviewRunningChapterId = '';
          this.kapitelReviewOut = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(root.t(job.error, job.errorParams))}</span>`;
          this.setKapitelReviewStatus('');
        },
        onDone: async (job) => {
          this.kapitelReviewLoading = false;
          this._kapitelReviewRunningChapterId = '';
          if (job.result?.empty) {
            this.setKapitelReviewStatus(root.t('kapitelReview.noPages'));
            return;
          }
          const r = job.result?.review;
          if (r) {
            this.kapitelReviewOut = this._renderKapitelReviewHtml(r);
            setTimeout(() => { this.kapitelReviewProgress = 0; }, 400);
            this.setKapitelReviewStatus(root.t('kapitelReview.pagesAnalyzed', { n: job.result.pageCount || '?' }));
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
      const chapterId = window.__app.kapitelReviewChapterId;
      if (!chapterId) return;
      const chapter = (root.tree || []).find(i => i.type === 'chapter' && String(i.id) === String(chapterId));
      const chapterName = chapter?.name || '';
      this.kapitelReviewLoading = true;
      this.kapitelReviewProgress = 0;
      this._kapitelReviewRunningChapterId = String(chapterId);
      root.showKapitelReviewCard = true;
      this.kapitelReviewOut = '';
      this.setKapitelReviewStatus(root.t('kapitelReview.starting'), true);
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
        this.kapitelReviewOut = `<span class="error-msg">${root.t('common.errorColon')}${escHtml(e.message)}</span>`;
        this.setKapitelReviewStatus('');
        this.kapitelReviewLoading = false;
        this._kapitelReviewRunningChapterId = '';
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
        const created = await root.bsPost('pages', {
          chapter_id: parseInt(chapter.id),
          name: title,
          html: '<p></p>',
        });
        root.newPageTitle = '';
        if (!created?.id) return;
        const newPage = {
          ...created,
          chapterName: chapter.name,
          url: root.bookstackUrl && created.book_slug && created.slug
            ? `${root.bookstackUrl}/books/${created.book_slug}/page/${created.slug}`
            : null,
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
  }));
}
