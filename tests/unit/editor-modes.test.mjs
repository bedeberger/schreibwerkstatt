// Editor-Modus-Invarianten (CLAUDE.md "Editor-Modi (4 Stück, Konsistenz kritisch)").
//
// Sechs harte Invarianten, deren Bruch zu Datenverlust oder UI-Inkonsistenzen
// führt. Statische Source-Checks fangen Drift bei Refactors: wer die Guards/
// Reset-Reihenfolgen umbaut, muss bewusst hier mitkorrigieren.
//
// Invarianten:
//  I1  enterFocusMode verlangt editMode (focusActive ⇒ editMode).
//  I2  cancelEdit ruft exitFocusMode, wenn focusActive.
//  I3  saveEdit im Fokus bleibt im Fokus (editMode wird NICHT geräumt);
//      ausserhalb Fokus räumt saveEdit editMode + Listener auf.
//  I4  resetPage Reset-Reihenfolge: exitFocusMode → _stopAutosave → resetChat
//      → editMode/editDirty=false → checkDone=false.
//  I5  Chat-Snapshot: chat-base#onVisible schreibt _checkDoneBeforeChat = checkDone
//      bevor checkDone auf false gesetzt wird.
//  I6  toggleChatCard / toggleIdeenCard restaurieren checkDone aus
//      _checkDoneBeforeChat beim Schliessen, wenn Findings vorhanden.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

// ── I1: enterFocusMode verlangt editMode ─────────────────────────────────────
test('I1: enterFocusMode bricht ab, wenn editMode false', () => {
  const src = read('public/js/editor/focus/card.js');
  // Guard muss editMode (oder editMode-Verneinung) prüfen UND früh return-en.
  // Wir matchen den präzisen Soll-Pattern: enterFocusMode-Funktionsbody
  // enthält `!app.editMode` UND `return;` davor.
  const m = src.match(/enterFocusMode\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'enterFocusMode gefunden');
  const body = m[0];
  assert.match(body, /!app\.editMode/,
    'Guard fehlt: enterFocusMode muss app.editMode prüfen');
  assert.match(body, /if\s*\([^)]*!app\.editMode[^)]*\)\s*return/,
    'Guard muss bei !editMode mit return abbrechen (focusActive ⇒ editMode)');
});

// ── I2: cancelEdit ruft exitFocusMode ────────────────────────────────────────
test('I2: cancelEdit ruft exitFocusMode wenn focusActive', () => {
  const src = read('public/js/editor/notebook/edit.js');
  const m = src.match(/async cancelEdit\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'cancelEdit gefunden');
  const body = m[0];
  assert.match(body, /if\s*\(\s*this\.focusActive\s*\)\s*this\.exitFocusMode\s*\(\s*\)/,
    'cancelEdit muss exitFocusMode rufen, wenn focusActive');
  assert.match(body, /this\.editMode\s*=\s*false/, 'cancelEdit räumt editMode');
  assert.match(body, /this\.editDirty\s*=\s*false/, 'cancelEdit räumt editDirty');
});

// ── I3: saveEdit — Fokus bleibt im Fokus ─────────────────────────────────────
test('I3: saveEdit hat Fokus-Branch, der editMode NICHT räumt', () => {
  const src = read('public/js/editor/notebook/edit.js');
  const m = src.match(/async saveEdit\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'saveEdit gefunden');
  const body = m[0];
  // Branch-Struktur: nach erfolgreichem PUT muss `if (this.focusActive) { … } else { … this.editMode = false; … }`
  // existieren. Im if-Zweig darf editMode NICHT auf false gehen.
  const ifElseMatch = body.match(/if\s*\(\s*this\.focusActive\s*\)\s*\{([\s\S]*?)\}\s*else\s*\{([\s\S]*?)\}/);
  assert.ok(ifElseMatch,
    'saveEdit braucht if(focusActive){...}else{...}-Branch für Fokus-Stay');
  const focusBranch = ifElseMatch[1];
  const exitBranch = ifElseMatch[2];
  assert.doesNotMatch(focusBranch, /this\.editMode\s*=\s*false/,
    'Fokus-Branch darf editMode NICHT räumen (User soll weiterschreiben)');
  assert.match(exitBranch, /this\.editMode\s*=\s*false/,
    'Nicht-Fokus-Branch räumt editMode');
});

// ── I4: resetPage Reset-Reihenfolge ──────────────────────────────────────────
test('I4: resetPage hält Reset-Reihenfolge: focus → autosave → chat → edit → lektorat', () => {
  const src = read('public/js/app/app-view.js');
  const m = src.match(/resetPage\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'resetPage gefunden');
  const body = m[0];

  // Positionen sammeln und Ordnung asserten.
  const pos = (re) => {
    const r = body.search(re);
    assert.ok(r >= 0, `Marker fehlt in resetPage: ${re}`);
    return r;
  };
  const pExitFocus = pos(/this\.focusActive\s*\)\s*this\.exitFocusMode/);
  const pStopAuto  = pos(/this\._stopAutosave\?\.\(\)/);
  const pResetChat = pos(/this\.resetChat\s*\(\)/);
  const pEditOff   = pos(/this\.editMode\s*=\s*false/);
  const pCheckOff  = pos(/this\.checkDone\s*=\s*false/);

  assert.ok(pExitFocus < pStopAuto,
    'exitFocusMode muss VOR _stopAutosave laufen (liest editMode/editDirty)');
  assert.ok(pStopAuto < pResetChat,
    '_stopAutosave vor resetChat');
  assert.ok(pResetChat < pEditOff,
    'resetChat vor editMode=false');
  assert.ok(pEditOff < pCheckOff,
    'editMode=false vor checkDone=false (Lektorat-State zuletzt)');
});

// ── I5: chat-base#onVisible Snapshot-Reihenfolge ────────────────────────────
test('I5: chat-base#onVisible snapshotet checkDone bevor es auf false geht', () => {
  const src = read('public/js/chat/chat-base.js');
  const m = src.match(/async function onVisible\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'onVisible gefunden');
  const body = m[0];

  const pSnapshot = body.search(/root\._checkDoneBeforeChat\s*=\s*root\.checkDone/);
  const pClear    = body.search(/root\.checkDone\s*=\s*false/);
  assert.ok(pSnapshot >= 0 && pClear >= 0, 'Snapshot+Clear vorhanden');
  assert.ok(pSnapshot < pClear,
    'Snapshot von checkDone MUSS vor dem Clear erfolgen — sonst speichert wir den geräumten Wert');
});

// ── I6: Restore beim Chat/Ideen-Close ────────────────────────────────────────
test('I6: toggleChatCard restauriert checkDone aus _checkDoneBeforeChat', () => {
  const src = read('public/js/app/app-view.js');
  const m = src.match(/toggleChatCard\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'toggleChatCard gefunden');
  const body = m[0];
  assert.match(body, /_checkDoneBeforeChat\s*&&\s*this\.lektoratFindings/,
    'Restore-Bedingung: nur wenn Snapshot true UND Findings vorhanden');
  assert.match(body, /this\.checkDone\s*=\s*true/,
    'Restore setzt checkDone wieder true');
  assert.match(body, /this\._checkDoneBeforeChat\s*=\s*false/,
    'Snapshot-Flag wird nach Restore zurückgesetzt');
});

test('I6: toggleIdeenCard restauriert checkDone analog zu Chat', () => {
  const src = read('public/js/app/app-view.js');
  const m = src.match(/toggleIdeenCard\s*\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(m, 'toggleIdeenCard gefunden');
  const body = m[0];
  assert.match(body, /_checkDoneBeforeChat\s*&&\s*this\.lektoratFindings/,
    'Restore-Bedingung wie bei Chat');
  assert.match(body, /this\.checkDone\s*=\s*true/);
  assert.match(body, /this\._checkDoneBeforeChat\s*=\s*false/);
});

// ── Bonus: Hotkey-Routing (CLAUDE.md Punkt 7) ────────────────────────────────
test('Cmd+Shift+E Hotkey routet zustandsabhängig (focus → exit, edit → enter)', () => {
  // Der Hotkey-Handler lebt in editor/focus/trampoline.js oder card.js.
  // Wir prüfen nur die Routing-Logik (keys exit/enter/start).
  const srcCard = read('public/js/editor/focus/card.js');
  const trampolinePath = path.join(repo, 'public/js/editor/focus/trampoline.js');
  const srcTramp = fs.existsSync(trampolinePath) ? fs.readFileSync(trampolinePath, 'utf8') : '';
  const combined = srcCard + '\n' + srcTramp;
  // toggleFocusMode oder Handler müssen zwischen `_focusState === 'active'`
  // (→ exit) und `_focusState === 'idle'` (→ enter) routen.
  assert.match(combined, /_focusState\s*===\s*['"]active['"][\s\S]*?exitFocusMode/,
    'Hotkey/Toggle: active-Branch ruft exitFocusMode');
  assert.match(combined, /_focusState\s*===\s*['"]idle['"][\s\S]*?enterFocusMode/,
    'Hotkey/Toggle: idle-Branch ruft enterFocusMode');
});
