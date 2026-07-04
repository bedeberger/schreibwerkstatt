// Unit tests for lib/wp-media.js: Bild-Resolver fuer den Blog-Push.
// data:-URI dekodieren + hochladen, fremde URL fetchen + hochladen, blog-eigene
// URL unveraendert behalten, MIME/Fehler -> verwerfen (null).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

process.env.SSRF_SKIP_DNS_CHECK = '1'; // Reserved-TLD-Hosts im Test nicht aufloesen

const { makeImageResolver, _decodeDataUri, _filenameFromUrl } =
  await import('../../lib/wp-media.js');

function fakeWp() {
  const uploads = [];
  return {
    uploads,
    async uploadMedia({ data, filename, mimeType }) {
      uploads.push({ len: data.length, filename, mimeType });
      return { id: 100 + uploads.length, source_url: `https://blog.test/wp-content/uploads/${filename}` };
    },
  };
}

test('_decodeDataUri: base64 png', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const dec = _decodeDataUri(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(dec.mime, 'image/png');
  assert.deepEqual(dec.data, png);
});

test('_filenameFromUrl: uses url basename with extension', () => {
  assert.equal(_filenameFromUrl('https://x.test/path/foto.jpg', 'image/jpeg'), 'foto.jpg');
  assert.equal(_filenameFromUrl('https://x.test/noext', 'image/png'), 'noext.png');
});

test('resolver: blog-hosted src unchanged, no upload', async () => {
  const wp = fakeWp();
  const resolve = makeImageResolver({ wp, blogOrigin: 'https://blog.test' });
  const r = await resolve('https://blog.test/wp-content/uploads/a.jpg');
  assert.deepEqual(r, { src: 'https://blog.test/wp-content/uploads/a.jpg', id: null });
  assert.equal(wp.uploads.length, 0);
});

test('resolver: data:-URI decoded and uploaded', async () => {
  const wp = fakeWp();
  const resolve = makeImageResolver({ wp, blogOrigin: 'https://blog.test' });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const r = await resolve(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(wp.uploads.length, 1);
  assert.equal(wp.uploads[0].mimeType, 'image/png');
  assert.match(r.src, /^https:\/\/blog\.test\/wp-content\/uploads\//);
  assert.equal(typeof r.id, 'number');
});

test('resolver: external image fetched then uploaded', async () => {
  const wp = fakeWp();
  const bytes = Buffer.from([1, 2, 3, 4]);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
  });
  const resolve = makeImageResolver({ wp, blogOrigin: 'https://blog.test', fetchImpl });
  const r = await resolve('https://cdn.example.com/pic.jpg');
  assert.equal(wp.uploads.length, 1);
  assert.equal(wp.uploads[0].mimeType, 'image/jpeg');
  assert.match(r.src, /wp-content\/uploads\/pic\.jpg/);
});

test('resolver: disallowed MIME -> null, no upload', async () => {
  const wp = fakeWp();
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'text/html' },
    arrayBuffer: async () => new ArrayBuffer(4),
  });
  const resolve = makeImageResolver({ wp, blogOrigin: 'https://blog.test', fetchImpl });
  const r = await resolve('https://cdn.example.com/notimage.html');
  assert.equal(r, null);
  assert.equal(wp.uploads.length, 0);
});

test('resolver: follows 3xx redirect to allowed host, then uploads', async () => {
  const wp = fakeWp();
  const bytes = Buffer.from([1, 2, 3, 4]);
  let calls = 0;
  const fetchImpl = async (u, opts) => {
    assert.equal(opts.redirect, 'manual'); // Redirects müssen manuell laufen
    calls++;
    if (calls === 1) {
      return { ok: false, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://cdn2.example.com/final.jpg' : null) } };
    }
    return {
      ok: true, status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  };
  const resolve = makeImageResolver({ wp, blogOrigin: 'https://blog.test', fetchImpl });
  const r = await resolve('https://cdn.example.com/pic.jpg');
  assert.equal(calls, 2);
  assert.equal(wp.uploads.length, 1);
  assert.match(r.src, /final\.jpg/);
});

test('resolver: rejects redirect to internal IP (SSRF bypass) -> null, no upload', async () => {
  const wp = fakeWp();
  const fetchImpl = async () => ({
    ok: false, status: 302,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? 'http://169.254.169.254/latest/meta-data/' : null) },
  });
  const resolve = makeImageResolver({ wp, blogOrigin: 'https://blog.test', fetchImpl });
  const r = await resolve('https://cdn.example.com/pic.jpg');
  assert.equal(r, null);
  assert.equal(wp.uploads.length, 0);
});

test('resolver: redirect loop halts at hop limit -> null', async () => {
  const wp = fakeWp();
  const fetchImpl = async () => ({
    ok: false, status: 302,
    headers: { get: (k) => (k.toLowerCase() === 'location' ? 'https://cdn.example.com/again.jpg' : null) },
  });
  const resolve = makeImageResolver({ wp, blogOrigin: 'https://blog.test', fetchImpl });
  const r = await resolve('https://cdn.example.com/pic.jpg');
  assert.equal(r, null);
  assert.equal(wp.uploads.length, 0);
});

test('resolver: fetch failure -> null (never throws)', async () => {
  const wp = fakeWp();
  const fetchImpl = async () => { throw new Error('ECONNREFUSED'); };
  const resolve = makeImageResolver({ wp, blogOrigin: 'https://blog.test', fetchImpl });
  const r = await resolve('https://cdn.example.com/pic.jpg');
  assert.equal(r, null);
});

test('resolver: empty/relative src -> null', async () => {
  const wp = fakeWp();
  const resolve = makeImageResolver({ wp, blogOrigin: 'https://blog.test' });
  assert.equal(await resolve(''), null);
  assert.equal(await resolve('/relative/path.jpg'), null);
});
