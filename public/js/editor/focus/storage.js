// Snapshot- und Counter-State im Browser-Storage.
//
// - Focus-Snapshot (sessionStorage): persistiert beim Eintritt in den Fokusmodus,
//   damit ein Reload (z.B. nach Klick auf "neu verbinden" im Session-Banner) die
//   Karte wieder öffnet, sobald die ursprüngliche Seite geladen ist.
//   sessionStorage = pro Tab/Fenster, überlebt F5 und OIDC-Redirect-Roundtrip,
//   nicht aber Tab-Close.
// - Tagesbaseline (localStorage): pro pageId genau ein Snapshot pro Tag. Bei
//   erster Messung wird der aktuelle Stand als Vergleichswert festgehalten,
//   jede weitere Messung am selben Tag liefert das Delta dazu. Stale Einträge
//   (andere Tage) werden lazy bei jedem Read geprunt.

import { COUNTER_DEBOUNCE_MS } from './constants.js';
import { getActiveEditorContainer } from '../shared/active-editor.js';

const FOCUS_SNAPSHOT_KEY = 'focus.snapshot';
const FOCUS_SNAPSHOT_TTL_MS = 60 * 60 * 1000;
const DAILY_BASELINE_KEY = 'focus.dailyBaseline';

export function writeFocusSnapshot(pageId) {
  if (!pageId) return;
  try {
    sessionStorage.setItem(FOCUS_SNAPSHOT_KEY, JSON.stringify({ pageId, ts: Date.now() }));
  } catch {}
}

export function clearFocusSnapshot() {
  try { sessionStorage.removeItem(FOCUS_SNAPSHOT_KEY); } catch {}
}

export function readFocusSnapshot() {
  try {
    const raw = sessionStorage.getItem(FOCUS_SNAPSHOT_KEY);
    if (!raw) return null;
    const snap = JSON.parse(raw);
    if (!snap || !snap.pageId || !snap.ts) return null;
    if (Date.now() - snap.ts > FOCUS_SNAPSHOT_TTL_MS) {
      clearFocusSnapshot();
      return null;
    }
    return snap;
  } catch { return null; }
}

function todayKey() {
  const d = new Date();
  return d.getFullYear() + '-'
       + String(d.getMonth() + 1).padStart(2, '0') + '-'
       + String(d.getDate()).padStart(2, '0');
}

function readDailyBaselines() {
  try {
    const raw = localStorage.getItem(DAILY_BASELINE_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
}

function writeDailyBaselines(obj) {
  try { localStorage.setItem(DAILY_BASELINE_KEY, JSON.stringify(obj)); }
  catch { /* quota / private mode — egal, Delta bleibt 0 */ }
}

// Liefert {dw, dc} (delta words/chars) für die heutige Sitzung der Seite.
// Schreibt bei Bedarf einen frischen Baseline-Eintrag und prunt stale.
export function dailyDelta(pageId, words, chars) {
  if (pageId == null) return { dw: 0, dc: 0 };
  const today = todayKey();
  const all = readDailyBaselines();
  let dirty = false;
  for (const id of Object.keys(all)) {
    if (all[id]?.date !== today) { delete all[id]; dirty = true; }
  }
  let entry = all[pageId];
  if (!entry || entry.date !== today) {
    entry = { date: today, words, chars };
    all[pageId] = entry;
    dirty = true;
  }
  if (dirty) writeDailyBaselines(all);
  return { dw: words - entry.words, dc: chars - entry.chars };
}

// `±0` für klare Optik bei Null statt nacktem `0`. Unicode-Minus für sauberen
// Tabulator-Look (gleiche Glyph-Breite wie Plus); ASCII-Hyphen ist schmaler.
export function fmtSigned(n) {
  if (n > 0) return '+' + n;
  if (n < 0) return '−' + Math.abs(n);
  return '±0';
}

// Edit-Mode-Counter: läuft sobald Edit-Modus aktiv ist (NICHT erst im Fokus).
// Setzt Tagesbaseline beim Edit-Start (nicht beim Focus-Eintritt) und tickt bei
// jeder Eingabe – damit zählen auch Edits ausserhalb des Fokusmodus zum
// „heute"-Delta. Idempotent: doppelter Install-Aufruf liefert dieselbe Teardown-
// Funktion zurück, ohne zweite Listener anzuhängen.
export function installEditCounter(app) {
  if (!app) return () => {};
  if (app._editCounterCtx) return app._editCounterCtx.teardown;

  const container = getActiveEditorContainer();
  if (!container) return () => {};

  let timer = 0;
  const compute = () => {
    const txt = container.textContent || '';
    const chars = txt.length;
    const words = txt.trim() ? txt.trim().split(/\s+/).length : 0;
    app.focusCountChars = chars;
    app.focusCountWords = words;
    const { dw, dc } = dailyDelta(app.currentPage?.id, words, chars);
    app.focusCountWordsDelta = fmtSigned(dw);
    app.focusCountCharsDelta = fmtSigned(dc);
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(compute, COUNTER_DEBOUNCE_MS);
  };

  container.addEventListener('input', schedule);
  container.addEventListener('compositionend', schedule);

  // Initial: Baseline für heute setzen (falls noch nicht vorhanden) und
  // aktuellen Stand anzeigen. Ohne diesen Call würde Delta erst nach erstem
  // Tastendruck überhaupt initialisiert.
  compute();

  const teardown = () => {
    clearTimeout(timer);
    container.removeEventListener('input', schedule);
    container.removeEventListener('compositionend', schedule);
    if (app._editCounterCtx?.teardown === teardown) app._editCounterCtx = null;
  };
  app._editCounterCtx = { teardown };
  return teardown;
}
