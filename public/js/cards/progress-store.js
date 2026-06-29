// Alpine.store('progress') — Tages-Schreibziel-State für den Header-Donut links
// neben dem Avatar. Liegt im Store (nicht in einer Karte), weil der Donut direkt
// im Root-Header-`<template>` rendert und unabhängig von der Buch-Overview-Karte
// sichtbar sein muss — es gibt keine Karte, die ihn hosten könnte.
//
// Kein Root-Proxy (wie nav/badges): Root-gespreadete Module (app-view/bookscope.js
// mit loadDailyProgress/resetDailyProgress/headerTodayRing, book-settings/settings.js)
// greifen via `this.$store.progress.*` bzw. `Alpine.store('progress').*` zu, das
// Header-Template via `$store.progress.*`.
//
// Feld-Bedeutung:
//   dailyProgressBookId        — Buch, für das die Stats geladen sind (Stale-Gate).
//   dailyProgressStats         — rohe /history/book-stats/:bookId-Liste; Tagesdelta
//                                berechnet headerTodayRing() (computeTodayRing).
//   dailyProgressIsFinished    — abgeschlossenes Buch → kein Donut.
//   dailyProgressDailyGoalChars— Zielzeichen/Tag (Default 1500, wenn null).
//   _dailyProgressLoadingBookId— async Re-Entry-/Stale-Guard für loadDailyProgress.

export function registerProgressStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('progress', {
    dailyProgressBookId: null,
    dailyProgressStats: [],
    dailyProgressIsFinished: false,
    dailyProgressDailyGoalChars: null,
    _dailyProgressLoadingBookId: null,
  });
}
