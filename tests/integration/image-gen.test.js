'use strict';
// Integration-Test fuer lib/image-gen.js (Buch-Chat-Bildgenerierung). Mockt den
// OpenAI-kompatiblen Image-Upstream via globalem fetch-Stub und prueft:
// disabled->Wurf, kein Prompt->Wurf, b64_json->Buffer, url-Fallback->Nachladen,
// Upstream-Fehler->image_upstream, leere Antwort->image_empty.

const test = require('node:test');
const assert = require('node:assert/strict');

const { bootstrap } = require('./_helpers/setup');

let ctx;
let originalFetch;
let genHandler = null;   // /v1/images/generations
let urlHandler = null;   // beliebige Bild-URL (url-Fallback)

test.before(() => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-image';
  ctx = bootstrap();
  originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (genHandler && u.includes('/v1/images/generations')) return genHandler(u, opts);
    if (urlHandler && u.includes('example.test')) return urlHandler(u, opts);
    return originalFetch(url, opts);
  };
});

test.after(() => {
  global.fetch = originalFetch;
  ctx.cleanup();
});

function setImage({ enabled, host, model = '', apiKey = '' }) {
  const appSettings = require('../../lib/app-settings');
  appSettings.set('image.enabled', enabled, { updatedBy: 'test' });
  appSettings.set('image.host', host, { updatedBy: 'test' });
  appSettings.set('image.model', model, { updatedBy: 'test' });
  if (apiKey) appSettings.set('image.api_key', apiKey, { updatedBy: 'test' });
  appSettings.clearCache();
}

function jsonResp(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

test('disabled -> wirft image_disabled', async () => {
  setImage({ enabled: false, host: '' });
  const { generateImage } = require('../../lib/image-gen');
  await assert.rejects(() => generateImage({ prompt: 'a cat' }), e => e.code === 'image_disabled');
});

test('kein Prompt -> wirft image_no_prompt', async () => {
  setImage({ enabled: true, host: 'http://img.local' });
  const { generateImage } = require('../../lib/image-gen');
  await assert.rejects(() => generateImage({ prompt: '   ' }), e => e.code === 'image_no_prompt');
});

test('b64_json -> dekodiertes Buffer; Bearer + size + model geforwarded', async () => {
  setImage({ enabled: true, host: 'http://img.local/v1', model: 'flux', apiKey: 'sek' });
  const raw = Buffer.from('PNGDATA');
  let seen = null;
  genHandler = (url, opts) => {
    seen = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return jsonResp({ data: [{ b64_json: raw.toString('base64'), revised_prompt: 'a fluffy cat' }] });
  };
  const { generateImage } = require('../../lib/image-gen');
  const out = await generateImage({ prompt: 'a cat', size: '512x512' });
  assert.equal(out.mime, 'image/png');
  assert.equal(out.size, '512x512');
  assert.equal(out.revisedPrompt, 'a fluffy cat');
  assert.deepEqual(out.buffer, raw);
  // /v1-Suffix gestrippt, korrekt zusammengesetzt
  assert.equal(seen.url, 'http://img.local/v1/images/generations');
  assert.equal(seen.headers.Authorization, 'Bearer sek');
  assert.equal(seen.body.model, 'flux');
  assert.equal(seen.body.size, '512x512');
  genHandler = null;
});

test('url-Fallback -> Bild wird nachgeladen, mime aus Content-Type', async () => {
  setImage({ enabled: true, host: 'http://img.local' });
  const raw = Buffer.from('JPEGDATA');
  genHandler = () => jsonResp({ data: [{ url: 'http://example.test/x.jpg' }] });
  urlHandler = () => ({
    ok: true, status: 200,
    headers: { get: () => 'image/jpeg; charset=binary' },
    arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  });
  const { generateImage } = require('../../lib/image-gen');
  const out = await generateImage({ prompt: 'a cat' });
  assert.equal(out.mime, 'image/jpeg');
  assert.deepEqual(out.buffer, raw);
  genHandler = null; urlHandler = null;
});

test('Upstream !ok -> image_upstream', async () => {
  setImage({ enabled: true, host: 'http://img.local' });
  genHandler = () => jsonResp({ error: 'boom' }, 500);
  const { generateImage } = require('../../lib/image-gen');
  await assert.rejects(() => generateImage({ prompt: 'a cat' }), e => e.code === 'image_upstream');
  genHandler = null;
});

test('leere Antwort -> image_empty', async () => {
  setImage({ enabled: true, host: 'http://img.local' });
  genHandler = () => jsonResp({ data: [] });
  const { generateImage } = require('../../lib/image-gen');
  await assert.rejects(() => generateImage({ prompt: 'a cat' }), e => e.code === 'image_empty');
  genHandler = null;
});
