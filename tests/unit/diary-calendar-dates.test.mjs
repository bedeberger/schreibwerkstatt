// Diary-Kalender: Wochentags-Header und Monatslabel werden aus UTC-Datumswerten
// gebaut und müssen darum in UTC formatiert werden — sonst beginnt der Header
// westlich von UTC mit „So" statt „Mo". Der Test läuft unter wechselnder
// Prozess-TZ (TZ-Env wird von V8 pro Aufruf gelesen).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { diaryCalendarMethods } = await import('../../public/js/book/diary-calendar.js');

const ctx = (uiLocale) => ({ ...diaryCalendarMethods, $store: { shell: { uiLocale } } });

for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati', 'UTC']) {
  test(`Wochentags-Header beginnt mit Montag (TZ ${tz})`, () => {
    const prev = process.env.TZ;
    process.env.TZ = tz;
    try {
      assert.equal(ctx('en').diaryCalendarWeekdayLabels()[0], 'Mon');
      assert.equal(ctx('de').diaryCalendarWeekdayLabels()[6], 'So');
      assert.match(ctx('en')._formatYearMonth(2026, 3), /March 2026/);
    } finally {
      process.env.TZ = prev;
    }
  });
}
