// Sentinel: lokales Datum darf bei TZ-Differenz nicht auf UTC-Vortag fallen.
// Bug-Symptom (vor Fix): User in CEST schreibt am Mo 14:00 lokal → Frontend
// nutzte `setHours(0,0,0,0).toISOString().slice(0,10)` → liefert UTC-So
// (lokal-Mitternacht = UTC vor-22:00). Streak-Grid zeigt heutige Zeichen
// auf Sonntag-Position.
import test from 'node:test';
import assert from 'node:assert/strict';
import { localIsoDate, localIsoDaysAgo } from '../../public/js/utils.js';

test('localIsoDate: Format YYYY-MM-DD', () => {
  const iso = localIsoDate(new Date('2026-05-04T14:00:00+02:00'));
  assert.match(iso, /^\d{4}-\d{2}-\d{2}$/);
});

test('localIsoDate: gleicher Tag wie new Date().toLocaleDateString sv-SE', () => {
  const d = new Date();
  // sv-SE liefert ebenfalls YYYY-MM-DD und nutzt lokale TZ.
  assert.equal(localIsoDate(d), d.toLocaleDateString('en-CA'));
});

test('localIsoDaysAgo: 0 == localIsoDate today', () => {
  assert.equal(localIsoDaysAgo(0), localIsoDate());
});

test('localIsoDaysAgo: chronologisch absteigend', () => {
  const today = localIsoDaysAgo(0);
  const yesterday = localIsoDaysAgo(1);
  const weekAgo = localIsoDaysAgo(7);
  assert.ok(today > yesterday, `today (${today}) > yesterday (${yesterday})`);
  assert.ok(yesterday > weekAgo, `yesterday (${yesterday}) > weekAgo (${weekAgo})`);
});

test('localIsoDaysAgo: 7 Tage zurück = exakt 7 Tage Differenz', () => {
  const today = localIsoDaysAgo(0);
  const week = localIsoDaysAgo(7);
  const todayMs = new Date(today + 'T12:00:00').getTime();
  const weekMs = new Date(week + 'T12:00:00').getTime();
  const diffDays = Math.round((todayMs - weekMs) / 86400000);
  assert.equal(diffDays, 7);
});

test('localIsoDaysAgo: DST-Drift-sicher (Mittag-Anker statt Mitternacht)', () => {
  // Test-Konstrukt: Wenn ein DST-Übergang dazwischenliegt, würde ein
  // 86_400_000-ms-Step pro Tag um ±1h driften. Der Mittag-Anker im Helper
  // verhindert das. Wir prüfen Stabilität über 60 aufeinanderfolgende Tage.
  const dates = [];
  for (let i = 0; i < 60; i++) dates.push(localIsoDaysAgo(i));
  // Alle Datums müssen unique sein (sonst hat ein Step denselben Tag doppelt geliefert).
  const unique = new Set(dates);
  assert.equal(unique.size, 60, 'Datums-Steps müssen alle unterschiedliche Tage liefern');
});

test('Bug-Sentinel: lokal-Mitternacht in CET ≠ UTC-Vortag', () => {
  // Reproduce der UTC-Falle: midnight setzen + toISOString liefert in CET den
  // Vortag. localIsoDate muss anders behandeln.
  const d = new Date('2026-05-04T14:00:00+02:00'); // Mo 14:00 CEST = Mo 12:00 UTC
  d.setHours(0, 0, 0, 0); // lokal Mo 00:00 = UTC So 22:00
  const utcSlice = d.toISOString().slice(0, 10);
  const localSlice = localIsoDate(d);
  // utcSlice könnte "2026-05-03" (So) sein, localSlice MUSS "2026-05-04" (Mo) sein.
  assert.equal(localSlice, '2026-05-04');
  // utcSlice driftet je nach Test-Runner-TZ; nur localSlice ist stabil.
});
