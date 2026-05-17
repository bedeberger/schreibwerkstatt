// Job-Result `updatedAt`-Staleness — Contract zwischen Server-Job und Frontend.
//
// CLAUDE.md "Harte Regel": Server-Jobs, deren Resultate auf einem Snapshot
// des BookStack-Seitenstands operieren (Lektorat-Findings mit Positionen,
// Chat-Antworten mit `vorschlaege.original`), liefern `updatedAt: pd.updated_at`.
// Der Client vergleicht im `onDone` mit `currentPage.updated_at`; weicht es ab,
// wird das Ergebnis verworfen statt angewandt.
//
// Verhaltens-Test des Frontend-Pfads lebt in stale-write.test.mjs. Hier:
// Drift-Schutz für das CONTRACT — wer ihn auf Server- oder Frontend-Seite
// versehentlich entfernt, bricht den Test.
//
// Geprüfte Stellen:
//  S1  routes/jobs/lektorat.js#runCheckJob — completeJob-Payload enthält
//      `updatedAt: pd.updated_at`.
//  S2  routes/jobs/chat.js#runChatJob — completeJob-Payload enthält
//      `updatedAt: pageUpdatedAt`.
//  F1  public/js/editor/lektorat.js#startCheckPoll.onDone — Discard-Guard
//      `r.updatedAt && this.currentPage?.updated_at && r.updatedAt !== ...`.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');

test('S1: routes/jobs/lektorat.js completeJob-Payload enthält updatedAt', () => {
  const src = read('routes/jobs/lektorat.js');
  // completeJob(jobId, { ... updatedAt: pd.updated_at ... })
  // Wir matchen tolerant: irgendwo zwischen completeJob-Start und nächster
  // Funktion muss `updatedAt:` an `pd.updated_at` gebunden sein.
  const m = src.match(/completeJob\s*\(\s*jobId\s*,\s*\{[\s\S]*?\}\s*,/g);
  assert.ok(m && m.length >= 1, 'mindestens ein completeJob-Aufruf');
  // Mindestens EIN completeJob im Single-Page-Check muss updatedAt setzen.
  const anyHasUpdatedAt = m.some(block => /updatedAt\s*:\s*pd\.updated_at/.test(block));
  assert.ok(anyHasUpdatedAt,
    'runCheckJob completeJob muss `updatedAt: pd.updated_at` setzen — sonst kann Client Staleness nicht erkennen');
});

test('S2: routes/jobs/chat.js completeJob-Payload enthält updatedAt', () => {
  const src = read('routes/jobs/chat.js');
  // Im Seiten-Chat-Pfad: `updatedAt: pageUpdatedAt` (Variable aus pd.updated_at).
  assert.match(src, /updatedAt\s*:\s*pageUpdatedAt/,
    'runChatJob completeJob muss `updatedAt: pageUpdatedAt` setzen');
  // pageUpdatedAt wird aus pd.updated_at abgeleitet — auch das prüfen.
  assert.match(src, /pageUpdatedAt\s*=\s*pd\.updated_at|const\s+pageUpdatedAt\s*=\s*[\w.]+\.updated_at/,
    'pageUpdatedAt muss aus dem Seiten-Read (pd.updated_at) stammen, nicht erfunden');
});

test('F1: editor/lektorat.js onDone hat Discard-Guard auf updatedAt-Mismatch', () => {
  const src = read('public/js/editor/lektorat.js');
  // Die Guard-Zeile vergleicht r.updatedAt mit this.currentPage?.updated_at
  // und returnt früh (kein Apply auf stale Snapshot).
  assert.match(
    src,
    /if\s*\(\s*r\.updatedAt\s*&&\s*this\.currentPage\?\.updated_at\s*&&\s*r\.updatedAt\s*!==\s*this\.currentPage\.updated_at\s*\)/,
    'onDone braucht expliziten Mismatch-Guard auf r.updatedAt vs currentPage.updated_at',
  );
  // Im Block muss klar dokumentiert sein, dass NICHTS angewandt wird (return).
  // Brace-Counting (Template-Literals & `${…}`-Expressions enthalten `}`,
  // simples indexOf('}') würde mitten im Template-Literal stoppen).
  const guardStart = src.search(/if\s*\(\s*r\.updatedAt/);
  const afterGuard = src.indexOf('{', guardStart);
  let depth = 1;
  let i = afterGuard + 1;
  let inStr = null, inTpl = 0;
  while (i < src.length && depth > 0) {
    const ch = src[i];
    const prev = src[i - 1];
    if (inStr) {
      if (ch === inStr && prev !== '\\') inStr = null;
    } else if (inTpl > 0) {
      if (ch === '`' && prev !== '\\') inTpl--;
      else if (ch === '$' && src[i + 1] === '{') { depth++; i++; }
      else if (ch === '}') { depth--; }
    } else {
      if (ch === '`') inTpl++;
      else if (ch === '"' || ch === "'") inStr = ch;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    i++;
  }
  const guardBlock = src.slice(afterGuard + 1, i - 1);
  assert.match(guardBlock, /\breturn\b/,
    'Discard-Branch muss return-en — sonst werden Findings doch angewandt');
  // Kein .originalHtml / .lektoratFindings im Discard-Branch — Sicherheit.
  assert.doesNotMatch(guardBlock, /this\.originalHtml\s*=/,
    'Discard-Branch darf originalHtml nicht überschreiben');
  assert.doesNotMatch(guardBlock, /this\.lektoratFindings\s*=/,
    'Discard-Branch darf lektoratFindings nicht setzen');
});

