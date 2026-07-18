import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeLektoratMetrics } = require('../../lib/lektorat-metrics.js');

const F = (typ, original) => ({ typ, original, korrektur: '', erklaerung: '' });
const errs = (...fs) => JSON.stringify(fs);

test('leere Eingabe → alle Modi 0', () => {
  const m = computeLektoratMetrics([]);
  assert.deepEqual(m, {
    open: { total: 0, byTyp: {} },
    applied: { total: 0, byTyp: {} },
    all: { total: 0, byTyp: {} },
  });
  assert.deepEqual(computeLektoratMetrics(null).all, { total: 0, byTyp: {} });
});

test('nur jüngster Check pro Seite zählt (checked_at max)', () => {
  const rows = [
    { page_id: 1, checked_at: '2026-01-01T10:00:00.000Z', errors_json: errs(F('stil', 'a'), F('stil', 'b')), applied_errors_json: null },
    { page_id: 1, checked_at: '2026-01-02T10:00:00.000Z', errors_json: errs(F('grammatik', 'c')), applied_errors_json: null },
  ];
  const m = computeLektoratMetrics(rows);
  // Der jüngere Check (grammatik/c) gewinnt für open/all.
  assert.equal(m.all.total, 1);
  assert.deepEqual(m.all.byTyp, { grammatik: 1 });
  assert.equal(m.open.total, 1);
});

test('applied vereinigt über ALLE Checks der Seite, open = errs minus applied', () => {
  const rows = [
    // Älterer Check: eine Korrektur angenommen (original 'a').
    { page_id: 7, checked_at: '2026-03-01T09:00:00.000Z', errors_json: errs(F('stil', 'a')), applied_errors_json: errs(F('stil', 'a')) },
    // Jüngster Check: 'a' (bereits angenommen) + 'b' (offen) im aktuellen Findings-Stand.
    { page_id: 7, checked_at: '2026-03-05T09:00:00.000Z', errors_json: errs(F('stil', 'a'), F('grammatik', 'b')), applied_errors_json: null },
  ];
  const m = computeLektoratMetrics(rows);
  // all = jüngster Check = 2 Findings
  assert.equal(m.all.total, 2);
  // applied = Union über alle Checks = { stil:a }
  assert.deepEqual(m.applied.byTyp, { stil: 1 });
  // open = jüngste errs OHNE angenommene originals = nur 'b' (grammatik)
  assert.equal(m.open.total, 1);
  assert.deepEqual(m.open.byTyp, { grammatik: 1 });
});

test('Findings ohne typ werden nicht gezählt', () => {
  const rows = [
    { page_id: 3, checked_at: '2026-01-01T00:00:00.000Z', errors_json: JSON.stringify([{ original: 'x' }, F('stil', 'y')]), applied_errors_json: null },
  ];
  const m = computeLektoratMetrics(rows);
  assert.equal(m.all.total, 1);
  assert.deepEqual(m.all.byTyp, { stil: 1 });
});

test('defektes JSON → als leer behandelt (kein Wurf)', () => {
  const rows = [
    { page_id: 5, checked_at: '2026-01-01T00:00:00.000Z', errors_json: '{kaputt', applied_errors_json: 'auch kaputt' },
  ];
  const m = computeLektoratMetrics(rows);
  assert.equal(m.all.total, 0);
  assert.equal(m.open.total, 0);
});

test('mehrere Seiten aggregieren nach Typ', () => {
  const rows = [
    { page_id: 1, checked_at: '2026-01-01T00:00:00.000Z', errors_json: errs(F('stil', 'a'), F('grammatik', 'b')), applied_errors_json: null },
    { page_id: 2, checked_at: '2026-01-01T00:00:00.000Z', errors_json: errs(F('stil', 'c')), applied_errors_json: null },
  ];
  const m = computeLektoratMetrics(rows);
  assert.equal(m.open.total, 3);
  assert.deepEqual(m.open.byTyp, { stil: 2, grammatik: 1 });
});
