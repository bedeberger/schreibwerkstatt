'use strict';
// Unit-Tests für lib/ai.js – nur reine Logik (extractBalancedJson, parseJSON).
// Lauf: `node --test tests/unit/`

const test = require('node:test');
const assert = require('node:assert/strict');

// parseJSON schreibt bei Misserfolg in ai_parse_fails/. Damit Tests nichts anlegen,
// setzen wir SESSION_SECRET + eine dummy API-Key – lib/ai.js hängt daran nicht, nur
// Sub-Module, aber so bleibt das Setup identisch zum Prod-Boot.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';

const { parseJSON } = require('../../lib/ai');

// extractBalancedJson ist nicht direkt exportiert – wir testen es indirekt
// über parseJSON mit Trailing-Content, das nur gematcht werden kann, wenn die
// balancierte Extraktion korrekt stackt.

test('parseJSON: direktes JSON', () => {
  assert.deepEqual(parseJSON('{"a":1}'), { a: 1 });
});

test('parseJSON: mit ```json Code-Fence', () => {
  assert.deepEqual(parseJSON('```json\n{"a":1}\n```'), { a: 1 });
});

test('parseJSON: Trailing-Kommentar nach JSON', () => {
  // Das Modell hängt oft Erklärungen nach dem JSON an – balancedJson muss greifen.
  assert.deepEqual(
    parseJSON('{"a":1}\n\nDas war die Antwort.'),
    { a: 1 },
  );
});

test('parseJSON: trailing comma (via jsonrepair)', () => {
  assert.deepEqual(parseJSON('{"a":1,}'), { a: 1 });
});

test('parseJSON: verschachtelte Strukturen mit Trailing-Content', () => {
  const input = '{"fehler":[{"typ":"stil","text":"x"}]}\n\nHinweis: Ich habe geprüft.';
  assert.deepEqual(parseJSON(input), { fehler: [{ typ: 'stil', text: 'x' }] });
});

test('parseJSON: Strings mit Klammern stören nicht', () => {
  assert.deepEqual(
    parseJSON('{"a":"text mit { und [ innen","b":2}'),
    { a: 'text mit { und [ innen', b: 2 },
  );
});

test('parseJSON: escapete Quotes in Strings', () => {
  assert.deepEqual(
    parseJSON('{"a":"er sagte \\"hallo\\""}'),
    { a: 'er sagte "hallo"' },
  );
});

test('parseJSON: Typ-Mismatch `{"a":[}` wird nicht fälschlich aus Trailing-Mülltext erweitert', () => {
  // Früher zählte die Extraktion `{` und `[` in denselben depth-Counter; ein defekter
  // Input wie `{"a":[}` wurde "balanciert" erkannt und dann durch jsonrepair geflickt
  // – aber ein harmloses `{` im Nachtext hätte die Grenze verfälschen können.
  // Heute erkennt der Typ-sensitive Stack das als ungültig und fällt auf jsonrepair zurück.
  const result = parseJSON('{"a":[}');
  assert.deepEqual(result, { a: [] }); // jsonrepair-Fallback, nicht "balanciertes" Missverständnis
});

test('parseJSON: reiner Klartext → jsonrepair liefert String (dokumentiertes Verhalten)', () => {
  // Dokumentiert, dass die bestehende Fallback-Kette sehr permissiv ist.
  // Caller müssen anschliessend strukturell prüfen (z.B. `if (!Array.isArray(result.fehler))`).
  assert.equal(parseJSON('das ist kein JSON'), 'das ist kein JSON');
});

// ── Retry-Verhalten bei transient `overloaded_error` ──────────────────────────
// Claude liefert gelegentlich 503 mit `{"error":{"type":"overloaded_error", ...}}`
// (z. B. "API key validation is temporarily unavailable"). Status 503 ist nicht
// im hard-coded RETRY_STATUS-Set, deshalb wird die Erkennung body-basiert gemacht.
test('callAI: retried bei 503 + overloaded_error im Body und gibt finalen Text zurück', async () => {
  // fetch mocken: zuerst 503-Overloaded, dann SSE-Erfolg.
  const origFetch = globalThis.fetch;
  process.env.API_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.CLAUDE_RETRY_MAX = '3';

  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      return new Response(
        JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: 'API key validation is temporarily unavailable. Please retry.' },
        }),
        { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/json' } },
      );
    }
    // Minimaler SSE-Erfolgsstream.
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"ok\\":1}"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(sse, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  try {
    // Lazy-require, damit env-Vars vor dem ersten require gesetzt sind.
    delete require.cache[require.resolve('../../lib/ai')];
    const { callAI } = require('../../lib/ai');
    const res = await callAI('hi', 'sys', null, 100, null, 'claude');
    assert.equal(res.text, '{"ok":1}');
    assert.equal(calls, 2, 'sollte einmal retryen');
  } finally {
    globalThis.fetch = origFetch;
    delete require.cache[require.resolve('../../lib/ai')];
  }
});

// ── Anthropic-Prefill (assistantPrefix) ──────────────────────────────────────
// Claude antwortet ab dem letzten assistant-Block. Wir senden `'{'` als Prefill,
// damit Claude zwingend JSON ausgibt — verhindert Markdown-Fences und Meta-Text.
// Der Stream enthält nur die Fortsetzung; lib/ai.js muss den Prefix beim
// Rückgabe-`text` wieder vorne anhängen, sonst ist das JSON kaputt.
test('callAI: assistantPrefix wird ans messages-Array angehängt und vor Rückgabe-Text wieder eingefügt', async () => {
  const origFetch = globalThis.fetch;
  process.env.API_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'sk-test';

  let capturedBody = null;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"\\"ok\\":1}"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    delete require.cache[require.resolve('../../lib/ai')];
    const { callAI, parseJSON } = require('../../lib/ai');
    const res = await callAI('hi', 'sys', null, 100, null, 'claude', null, '{');
    // Letzte Message muss assistant-Prefill sein.
    assert.equal(capturedBody.messages.length, 2);
    assert.equal(capturedBody.messages[1].role, 'assistant');
    assert.equal(capturedBody.messages[1].content, '{');
    // Stream lieferte nur die Fortsetzung; Rückgabe muss vollständig sein.
    assert.equal(res.text, '{"ok":1}');
    assert.deepEqual(parseJSON(res.text), { ok: 1 });
  } finally {
    globalThis.fetch = origFetch;
    delete require.cache[require.resolve('../../lib/ai')];
  }
});

test('callAI: ohne assistantPrefix bleibt messages-Array unverändert (Backwards-Compat)', async () => {
  const origFetch = globalThis.fetch;
  process.env.API_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'sk-test';

  let capturedBody = null;
  globalThis.fetch = async (_url, opts) => {
    capturedBody = JSON.parse(opts.body);
    const sse = [
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1,"output_tokens":0}}}',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"{\\"ok\\":1}"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
      'data: [DONE]',
      '',
    ].join('\n');
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };

  try {
    delete require.cache[require.resolve('../../lib/ai')];
    const { callAI } = require('../../lib/ai');
    const res = await callAI('hi', 'sys', null, 100, null, 'claude');
    assert.equal(capturedBody.messages.length, 1);
    assert.equal(capturedBody.messages[0].role, 'user');
    assert.equal(res.text, '{"ok":1}');
  } finally {
    globalThis.fetch = origFetch;
    delete require.cache[require.resolve('../../lib/ai')];
  }
});
