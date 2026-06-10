// Drift-Guard: Die Event-Subtyp-Whitelist existiert in zwei Runtimes – als
// KI-Vertrag im Prompt-Enum (ESM, public/js/prompts/komplett/schemas.js) und
// als Server-Persistenz-Gate (CJS, db/event-subtyp.js). Beide MÜSSEN dieselben
// Werte führen, sonst mappt der Save gültige KI-Subtypen still auf 'sonstiges'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { EVENT_SUBTYP_ENUM } from '../../public/js/prompts/komplett/schemas.js';

const require = createRequire(import.meta.url);
const { EVENT_SUBTYP_WL } = require('../../db/event-subtyp.js');

test('Event-Subtyp-Whitelist: Prompt-Enum == DB-Whitelist (keine Drift)', () => {
  const promptSet = new Set(EVENT_SUBTYP_ENUM);
  const dbSet = EVENT_SUBTYP_WL;

  const fehltInDb = [...promptSet].filter(v => !dbSet.has(v));
  const fehltImPrompt = [...dbSet].filter(v => !promptSet.has(v));

  assert.deepEqual(fehltInDb, [], `Im Prompt, aber nicht in db/event-subtyp.js: ${fehltInDb.join(', ')}`);
  assert.deepEqual(fehltImPrompt, [], `In db/event-subtyp.js, aber nicht im Prompt: ${fehltImPrompt.join(', ')}`);
  assert.equal(promptSet.size, dbSet.size);
});
