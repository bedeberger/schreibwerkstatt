// Diary-Calendar: Sidebar-Alternative für Bücher mit buchtyp='tagebuch'.
// Aggregiert `pages` mit `YYYY-MM-DD`-Namen zu Monats-Grid; Klick auf Tag ruft
// `selectPage(page)`. Eingebunden ins Root via spread in tree.js.
//
// Performance: `diaryCalendarPagesMap` läuft einmal pro Load + Cache-Invalidation
// in `loadPages`. Bei 2'400 Diary-Pages ist der Build ~3 ms (Regex-Match pro
// Page), wir wollen aber nicht pro Render rebuilden.

import { contentRepo } from '../repo/content.js';
import { localIsoDate } from '../utils.js';
import { _sortSoloFirst } from './tree.js';

const _CACHE_KEY = '_diaryCalendarCache';

function _ensureCache(app) {
  if (!app[_CACHE_KEY]) app[_CACHE_KEY] = { pagesRef: null, map: null, months: null };
  return app[_CACHE_KEY];
}

export const diaryCalendarMethods = {
  // Map<'YYYY-MM-DD', page>. Cache invalidiert bei pages-Replacement.
  diaryCalendarPagesMap() {
    const cache = _ensureCache(this);
    if (cache.pagesRef === this.pages && cache.map) return cache.map;
    const m = new Map();
    for (const p of (this.pages || [])) {
      const md = (p.name || '').match(/^(\d{4})-(\d{2})-(\d{2})\b/);
      if (md) {
        const key = `${md[1]}-${md[2]}-${md[3]}`;
        if (!m.has(key)) m.set(key, p);
      }
    }
    cache.pagesRef = this.pages;
    cache.map = m;
    cache.months = null;
    return m;
  },

  // [{ key:'YYYY-MM', year, month, count }] absteigend sortiert.
  diaryCalendarMonths() {
    const cache = _ensureCache(this);
    if (cache.months) return cache.months;
    const map = this.diaryCalendarPagesMap();
    const counts = new Map();
    for (const key of map.keys()) {
      const k = key.slice(0, 7);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    const list = [...counts.entries()]
      .map(([k, count]) => {
        const [y, mo] = k.split('-');
        return { key: k, year: parseInt(y, 10), month: parseInt(mo, 10), count };
      })
      .sort((a, b) => b.key.localeCompare(a.key));
    cache.months = list;
    return list;
  },

  // {year, month} — entweder explizite User-Wahl oder neuester verfügbarer Monat.
  diaryCalendarCurrentMonth() {
    if (this.diaryCalendarYearMonth) return this.diaryCalendarYearMonth;
    const months = this.diaryCalendarMonths();
    if (months[0]) return { year: months[0].year, month: months[0].month };
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() + 1 };
  },

  // 6x7-Grid, jeweils { date:'YYYY-MM-DD', dayNum, inMonth, hasPage, page, isToday }.
  // Monday als Wochenanfang (Swiss).
  diaryCalendarMonthGrid() {
    const { year, month } = this.diaryCalendarCurrentMonth();
    const first = new Date(Date.UTC(year, month - 1, 1));
    const dayOfWeek = (first.getUTCDay() + 6) % 7;
    const map = this.diaryCalendarPagesMap();
    const todayIso = new Date().toISOString().slice(0, 10);
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const off = i - dayOfWeek;
      const d = new Date(Date.UTC(year, month - 1, 1 + off));
      const ds = d.toISOString().slice(0, 10);
      const page = map.get(ds) || null;
      cells.push({
        date: ds,
        dayNum: d.getUTCDate(),
        inMonth: d.getUTCMonth() === month - 1,
        hasPage: !!page,
        page,
        isToday: ds === todayIso,
      });
    }
    return cells;
  },

  // Monatsname lokalisiert (Februar / February).
  diaryCalendarMonthLabel() {
    const { year, month } = this.diaryCalendarCurrentMonth();
    return this._formatYearMonth(year, month);
  },

  diaryCalendarLabelForMonth(monthEntry) {
    return this._formatYearMonth(monthEntry.year, monthEntry.month);
  },

  _formatYearMonth(year, month) {
    const locale = this.uiLocale === 'en' ? 'en-US' : 'de-CH';
    const dt = new Date(Date.UTC(year, month - 1, 15));
    return dt.toLocaleDateString(locale, { month: 'long', year: 'numeric' });
  },

  // Wochentags-Header lokalisiert (Mo Di Mi … / Mon Tue Wed …).
  diaryCalendarWeekdayLabels() {
    const locale = this.uiLocale === 'en' ? 'en-US' : 'de-CH';
    const labels = [];
    // 2024-01-01 ist ein Montag; davon ausgehend 7 Tage.
    for (let i = 0; i < 7; i++) {
      const dt = new Date(Date.UTC(2024, 0, 1 + i));
      labels.push(dt.toLocaleDateString(locale, { weekday: 'short' }));
    }
    return labels;
  },

  diaryCalendarStep(delta) {
    const cur = this.diaryCalendarCurrentMonth();
    let m = cur.month + delta;
    let y = cur.year;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    this.diaryCalendarYearMonth = { year: y, month: m };
  },

  // Springt zum Monat mit Schlüssel `YYYY-MM`. Aus Combobox-Auswahl.
  diaryCalendarJumpTo(monthKey) {
    if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return;
    const [y, m] = monthKey.split('-');
    this.diaryCalendarYearMonth = { year: parseInt(y, 10), month: parseInt(m, 10) };
  },

  selectDiaryCalendarDay(cell) {
    if (!cell?.page) return;
    this.selectPage(cell.page);
  },

  // Heute-Button-Handler. Öffnet bestehenden Eintrag oder legt neuen an.
  createDiaryEntryToday() {
    this._createDiaryEntry(localIsoDate());
  },

  // Sichert Jahr-Kapitel `YYYY` (Name = Jahrzahl, position = Jahrzahl).
  // Pattern stammt aus folder-import (routes/jobs/folder-import.js): ein
  // Top-Level-Kapitel pro Jahr. Liefert Chapter-ID.
  async _ensureDiaryYearChapter(year) {
    const yearStr = String(year);
    const existing = this.tree.find(
      it => it.type === 'chapter' && !it.solo && it.name === yearStr
    );
    if (existing) return existing.id;
    const created = await contentRepo.createChapter({
      book_id: parseInt(this.selectedBookId, 10),
      name: yearStr,
      position: parseInt(yearStr, 10),
    });
    if (!created?.id) throw new Error('createChapter returned no id');
    const chapterItem = {
      type: 'chapter',
      id: created.id,
      name: created.name,
      priority: created.position ?? parseInt(yearStr, 10),
      open: true,
      solo: false,
      pages: [],
    };
    this.tree = [...this.tree, chapterItem].sort(_sortSoloFirst);
    return created.id;
  },

  // Erstellt Diary-Page mit Name = dateIso (`YYYY-MM-DD`) im passenden
  // Jahr-Kapitel und öffnet sie. Existiert bereits eine Page für dieses
  // Datum, wird sie geöffnet statt dupliziert.
  // Diary-Cache (pagesRef) wird durch Array-Reassignment invalidiert.
  async _createDiaryEntry(dateIso) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso || '')) return;
    if (!this.canEdit?.()) return;
    if (this._diaryCreatingDate === dateIso) return;
    const existing = this.diaryCalendarPagesMap().get(dateIso);
    if (existing) { this.selectPage(existing); return; }
    this._diaryCreatingDate = dateIso;
    try {
      const chapterId = await this._ensureDiaryYearChapter(dateIso.slice(0, 4));
      const created = await contentRepo.createPage({
        book_id: parseInt(this.selectedBookId, 10),
        chapter_id: chapterId,
        name: dateIso,
        html: '<p></p>',
      });
      if (!created?.id) throw new Error('createPage returned no id');
      this.pages = [...this.pages, created];
      const treeCh = this.tree.find(
        it => it.type === 'chapter' && !it.solo && String(it.id) === String(chapterId)
      );
      if (treeCh) {
        treeCh.pages = [...treeCh.pages, created];
        treeCh.open = true;
      }
      this.tokEsts[created.id] = { tok: 0, words: 0, chars: 0 };
      this.diaryCalendarYearMonth = {
        year: parseInt(dateIso.slice(0, 4), 10),
        month: parseInt(dateIso.slice(5, 7), 10),
      };
      this.selectPage(created);
    } catch (e) {
      console.error('[_createDiaryEntry]', e);
      this.setStatus(this.t('calendar.createError'));
    } finally {
      this._diaryCreatingDate = null;
    }
  },

  // Sortiert Diary-Pages chronologisch (älteste zuerst). Cache wie pagesMap.
  _diarySortedPages() {
    const cache = _ensureCache(this);
    if (cache.pagesRef === this.pages && cache.sorted) return cache.sorted;
    this.diaryCalendarPagesMap();
    const entries = [...cache.map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([, page]) => page);
    cache.sorted = entries;
    return entries;
  },

  diaryPrevPage() {
    return this._diaryNeighbor(-1);
  },
  diaryNextPage() {
    return this._diaryNeighbor(1);
  },
  _diaryNeighbor(delta) {
    if (!this.currentPage) return null;
    const sorted = this._diarySortedPages();
    if (!sorted.length) return null;
    const idx = sorted.findIndex(p => p.id === this.currentPage.id);
    if (idx === -1) return null;
    const target = sorted[idx + delta];
    return target || null;
  },
  diaryGo(delta) {
    const target = this._diaryNeighbor(delta);
    if (target) this.selectPage(target);
  },

  // Sidebar-Mode-Toggle. Default ist 'tree' aus app-state; bei tagebuch
  // setzt Tree-Code beim Buchwechsel auf 'calendar' (in tree.js loadPages).
  toggleSidebarMode() {
    this.sidebarMode = this.sidebarMode === 'calendar' ? 'tree' : 'calendar';
  },
};
