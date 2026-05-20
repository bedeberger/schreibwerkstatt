// Findings-Mark-Watcher: räumt `<mark class="lektorat-mark|chat-mark">`-Wrapper
// im contenteditable ab, sobald ihr Text vom Snapshot abweicht. Pflicht-Invariante:
// Caret/Selection darf NICHT im Mark stehen, wenn der Unwrap (insertBefore +
// removeChild) läuft — Chromium kollabiert sonst die Selection, Caret verschwindet,
// Tippen tot.
//
// Statische Source-Checks (kein DOM-Setup nötig). Drift-Schutz: wer den Watcher
// umbaut und Caret-Guard oder blur-Trigger entfernt, muss diesen Test bewusst
// mitkorrigieren.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const src = fs.readFileSync(path.join(repo, 'public/js/editor/notebook/edit.js'), 'utf8');

const installMatch = src.match(/_installFindingMarkWatcher\s*\(\)\s*\{[\s\S]*?\n  \},/);
assert.ok(installMatch, '_installFindingMarkWatcher gefunden');
const installBody = installMatch[0];

test('unwrapStale liest aktuelle Selection (anchor + focus)', () => {
  assert.match(installBody, /document\.getSelection\s*\(\s*\)/,
    'unwrapStale muss document.getSelection() abrufen');
  assert.match(installBody, /anchorNode/, 'anchorNode prüfen');
  assert.match(installBody, /focusNode/, 'focusNode prüfen (Selection-Range)');
});

test('unwrapStale überspringt Marks, in denen Caret/Selection steht (non-force)', () => {
  // Pflicht: vor dem Unwrap-Block (insertBefore/removeChild) `m.contains(anchor)`
  // ODER `m.contains(focus)` prüfen und mit `continue` aufschieben.
  assert.match(installBody, /m\.contains\(\s*anchor\s*\)/,
    'Caret-Anchor in Mark muss Unwrap aufschieben');
  assert.match(installBody, /m\.contains\(\s*focus\s*\)/,
    'Selection-Focus in Mark muss Unwrap aufschieben');
});

test('unwrapStale hat force-Override für blur-Pfad', () => {
  // Signatur: unwrapStale(force = false). Bei blur force=true → Caret-Check
  // übergangen, Marks werden trotzdem unwrapped.
  assert.match(installBody, /unwrapStale\s*=\s*\(\s*force[^)]*\)\s*=>/,
    'unwrapStale muss force-Parameter haben');
  assert.match(installBody, /!force\s*&&/,
    'Caret-Skip nur wenn !force');
});

test('blur-Listener registriert (capture) und ruft unwrapStale(true)', () => {
  // blur ist non-bubbling → capture nötig, damit Listener am Container greift.
  assert.match(installBody, /addEventListener\(\s*['"]blur['"]\s*,[^,]+,\s*true\s*\)/,
    'blur-Listener muss in Capture-Phase registriert sein');
  assert.match(installBody, /unwrapStale\s*\(\s*true\s*\)/,
    'blur-Handler muss unwrapStale(true) aufrufen (force)');
});

const uninstallMatch = src.match(/_uninstallFindingMarkWatcher\s*\(\)\s*\{[\s\S]*?\n  \},?/);
assert.ok(uninstallMatch, '_uninstallFindingMarkWatcher gefunden');
const uninstallBody = uninstallMatch[0];

test('_uninstallFindingMarkWatcher entfernt input UND blur Listener', () => {
  assert.match(uninstallBody, /removeEventListener\(\s*['"]input['"]/,
    'input-Listener muss removed werden');
  assert.match(uninstallBody, /removeEventListener\(\s*['"]blur['"]\s*,[^,]+,\s*true\s*\)/,
    'blur-Listener muss in Capture-Phase removed werden (sonst Leak)');
});

test('_uninstallFindingMarkWatcher nullt blur-Handler-Ref', () => {
  // Symmetrisch zu _findingMarkInputHandler — verhindert Stale-Ref nach Edit-Ende.
  assert.match(uninstallBody, /_findingMarkBlurHandler\s*=\s*null/,
    'Blur-Handler-Ref muss genullt werden');
});
