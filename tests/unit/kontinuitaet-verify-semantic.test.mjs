// Unit: semantischer Beleg-Fallback der Kontinuitäts-Verify-Stufe.
// (1) _verifyExcerpt signalisiert via `located`, ob das wörtliche Zitat gefunden
//     wurde (steuert den Fallback). (2) verifyKontinuitaetProbleme lädt bei NICHT
//     lokalisiertem Zitat die semantisch nächste Passage nach und speist sie in den
//     Verify-Prompt — statt auf den Kapitel-Anfang zurückzufallen. Best-effort/opt-in:
//     ohne Index/Backend bleibt der keyword-Pfad.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require_ = createRequire(import.meta.url);

const dir = mkdtempSync(join(tmpdir(), 'kont-verify-'));
process.env.DB_PATH = join(dir, 'test.db');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test';
require_('../../db/connection');
require_('../../db/migrations').runMigrations();

const jobShared = require_('../../routes/jobs/komplett/job-shared');
const embed = require_('../../lib/embed');
const semanticChunks = require_('../../db/semantic-chunks');
const { _verifyExcerpt, verifyKontinuitaetProbleme } = jobShared;

test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

const GROUPS = new Map([['k1', { name: 'Kapitel Eins', pages: [{ text: 'Der Wald lag still. Anna ging heim.' }] }]]);
const ORDER = ['k1'];

test('_verifyExcerpt: wörtliches Zitat → located:true, Fenster um das Zitat', () => {
  const r = _verifyExcerpt(GROUPS, ORDER, ['Kapitel Eins'], 'Anna ging heim');
  assert.equal(r.located, true);
  assert.match(r.text, /Anna ging heim/);
});

test('_verifyExcerpt: Zitat nicht im Text → located:false, Kapitel-Anfang', () => {
  const r = _verifyExcerpt(GROUPS, ORDER, ['Kapitel Eins'], 'existiert hier nicht');
  assert.equal(r.located, false);
  assert.match(r.text, /Der Wald lag still/);
});

test('_verifyExcerpt: kein passendes Kapitel → leer, located:false', () => {
  const r = _verifyExcerpt(GROUPS, ORDER, ['Kapitel Zwei'], 'egal');
  assert.deepEqual(r, { text: '', located: false });
});

test('verifyKontinuitaetProbleme: paraphrasiertes Zitat → semantische Passage im Verify-Prompt', async () => {
  const orig = {
    isEnabled: embed.isEnabled, getConfig: embed.getConfig, embedOne: embed.embedOne,
    bookStats: semanticChunks.bookStats, searchSimilar: semanticChunks.searchSimilar,
  };
  embed.isEnabled = () => true;
  embed.getConfig = () => ({ model: 'test-model' });
  embed.embedOne = async () => Float32Array.from([1, 0, 0]);
  semanticChunks.bookStats = () => ({ total: 1 });
  const searchCalls = [];
  semanticChunks.searchSimilar = (bookId, model, vec, opts) => {
    searchCalls.push({ bookId, model, opts });
    return [{ text: 'SEMANTISCHE_TREFFER_PASSAGE mit demselben Fakt anders formuliert.' }];
  };

  try {
    const seen = [];
    const call = async (_jobId, _tok, prompt) => { seen.push(prompt); return { bestaetigt: true }; };
    const prompts = {
      buildKontinuitaetVerifyPrompt: (bookName, p, exA, exB) => ({ exA, exB }),
      SCHEMA_KONTINUITAET_VERIFY: {},
    };
    const ctx = {
      call, prompts, sys: { SYSTEM_KONTINUITAET_BLOCKS: '' },
      jobId: 'no-such-job', tok: { in: 0, out: 0 }, bookName: 'Testbuch',
      groups: GROUPS, groupOrder: ORDER, log: { info() {}, warn() {} }, bookIdInt: 77,
    };
    const problem = {
      kapitel: ['Kapitel Eins'],
      stelle_a: '«dieses Zitat steht so nicht im Buch»', // keyword scheitert → semantisch
      stelle_b: '',
    };
    const out = await verifyKontinuitaetProbleme(ctx, { zusammenfassung: 'z', probleme: [problem] }, 95, 97);

    assert.equal(out.probleme.length, 1, 'bestaetigt=true → Befund bleibt erhalten');
    assert.equal(seen.length, 1, 'genau ein Verify-Call');
    assert.match(seen[0].exA, /SEMANTISCHE_TREFFER_PASSAGE/, 'stelle_a bekommt die semantische Passage statt Kapitel-Anfang');
    assert.equal(searchCalls.length, 1, 'nur für das nicht auflösbare Zitat gesucht (leeres stelle_b löst keine Suche aus)');
    assert.deepEqual(searchCalls[0].opts.kinds, ['page']);
    assert.equal(searchCalls[0].bookId, 77);
  } finally {
    Object.assign(embed, { isEnabled: orig.isEnabled, getConfig: orig.getConfig, embedOne: orig.embedOne });
    Object.assign(semanticChunks, { bookStats: orig.bookStats, searchSimilar: orig.searchSimilar });
  }
});

test('verifyKontinuitaetProbleme: ohne Embed-Index → keyword-Pfad, keine semantische Suche', async () => {
  const origEnabled = embed.isEnabled;
  const origSearch = semanticChunks.searchSimilar;
  embed.isEnabled = () => false; // Backend aus
  let searched = false;
  semanticChunks.searchSimilar = () => { searched = true; return []; };
  try {
    const seen = [];
    const ctx = {
      call: async (_j, _t, prompt) => { seen.push(prompt); return { bestaetigt: true }; },
      prompts: { buildKontinuitaetVerifyPrompt: (b, p, exA, exB) => ({ exA, exB }), SCHEMA_KONTINUITAET_VERIFY: {} },
      sys: { SYSTEM_KONTINUITAET_BLOCKS: '' },
      jobId: 'no-such-job', tok: { in: 0, out: 0 }, bookName: 'B',
      groups: GROUPS, groupOrder: ORDER, log: { info() {}, warn() {} }, bookIdInt: 77,
    };
    const out = await verifyKontinuitaetProbleme(ctx,
      { zusammenfassung: 'z', probleme: [{ kapitel: ['Kapitel Eins'], stelle_a: '«fehlt im Text»', stelle_b: '' }] }, 95, 97);
    assert.equal(out.probleme.length, 1);
    assert.equal(searched, false, 'kein semantischer Call ohne aktivierten Index');
    assert.match(seen[0].exA, /Der Wald lag still/, 'keyword-Fallback (Kapitel-Anfang) bleibt');
  } finally {
    embed.isEnabled = origEnabled;
    semanticChunks.searchSimilar = origSearch;
  }
});
