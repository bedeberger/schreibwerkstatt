'use strict';
// Bild-Resolver fuer den Blog-Push. Bestimmt pro <img>-src, ob das Bild in die
// WordPress-Mediathek geladen werden muss:
//   - bereits auf dem Blog gehostet (gleiche Origin) -> unveraendert behalten
//   - data:-URI oder fremd-gehostete http(s)-URL   -> Bytes holen + zu WP hochladen
//   - alles andere (relativ, unbekanntes Schema)    -> verwerfen (null)
// Fremde URLs werden vor dem Fetch durch den SSRF-Guard geschleust. Fehler
// (Netz, MIME, Groesse) fuehren zum Verwerfen des Bildes, nie zum Job-Abbruch.
// Reine Orchestrierung — der eigentliche Upload liegt in lib/wp-client.js.

const { safeFetch } = require('./ssrf-guard');

const ALLOWED_IMAGE_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif',
]);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 30_000;
const _EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/avif': 'avif',
};

function _decodeDataUri(src) {
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(src);
  if (!m) return null;
  const mime = m[1].trim().toLowerCase();
  const data = m[2]
    ? Buffer.from(m[3], 'base64')
    : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime, data };
}

function _filenameFromUrl(urlStr, mime) {
  const ext = _EXT[mime] || 'bin';
  try {
    const base = new URL(urlStr).pathname.split('/').filter(Boolean).pop() || '';
    if (base && /\.[a-z0-9]{2,5}$/i.test(base)) return base;
    if (base) return `${base}.${ext}`;
  } catch { /* fallthrough */ }
  return `image.${ext}`;
}

// Fabrik: liefert eine async `resolveImage(src)`-Funktion fuer appToWpHtmlWithMedia.
// Rueckgabe je src: `{ src, id }` (behalten/hochgeladen) oder `null` (verwerfen).
function makeImageResolver({ wp, blogOrigin, signal = null, logger = null, fetchImpl = null } = {}) {
  const doFetch = fetchImpl || globalThis.fetch;
  const warn = (msg) => { try { logger?.warn(`Blog-Media: ${msg}`); } catch { /* noop */ } };

  async function _upload(data, mime, filename) {
    if (!ALLOWED_IMAGE_MIME.has(mime)) { warn(`MIME ${mime || '?'} nicht erlaubt, Bild verworfen`); return null; }
    if (data.length > MAX_IMAGE_BYTES) { warn(`Bild ${data.length} B > Limit, verworfen`); return null; }
    const media = await wp.uploadMedia({ data, filename, mimeType: mime });
    const url = media && (media.source_url || media.guid?.rendered);
    if (!url) { warn('Upload lieferte keine source_url'); return null; }
    return { src: url, id: media.id != null ? media.id : null };
  }

  return async function resolveImage(src) {
    const trimmed = String(src || '').trim();
    if (!trimmed) return null;

    if (/^data:/i.test(trimmed)) {
      const dec = _decodeDataUri(trimmed);
      if (!dec) { warn('data:-URI nicht dekodierbar'); return null; }
      try { return await _upload(dec.data, dec.mime, `image.${_EXT[dec.mime] || 'bin'}`); }
      catch (e) { warn(`data:-Upload fehlgeschlagen: ${e.code || e.message}`); return null; }
    }

    let url;
    try { url = new URL(trimmed); }
    catch { warn(`src '${trimmed.slice(0, 60)}' keine absolute URL, verworfen`); return null; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') { warn(`Schema ${url.protocol} nicht unterstuetzt`); return null; }

    // Schon auf dem Blog gehostet -> unveraendert behalten (kein Re-Upload).
    if (blogOrigin && url.origin === blogOrigin) return { src: trimmed, id: null };

    // Fremde URL fetchen: safeFetch schleust JEDEN Redirect-Hop erneut durch
    // den SSRF-Guard (sonst umgeht ein 3xx auf eine interne Adresse den
    // Eingangs-Check) und deckelt Zeit und Bytes.
    let out;
    try {
      out = await safeFetch(trimmed, {
        signal: signal || undefined,
        fetchImpl: doFetch,
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_IMAGE_BYTES,
        maxRedirects: MAX_REDIRECTS,
        tooLargeCode: 'IMAGE_TOO_LARGE',
      });
    } catch (e) {
      if (e.code && e.code.startsWith('SSRF_')) warn(`SSRF-Guard blockt ${url.host} (oder ein Redirect-Ziel): ${e.code}`);
      else if (e.code === 'FETCH_REDIRECT_LIMIT') warn(`zu viele Redirects ab ${trimmed}`);
      else if (e.code === 'IMAGE_TOO_LARGE') warn('Bild > Limit, verworfen');
      else warn(`Fetch ${url.host} fehlgeschlagen: ${e.code || e.message}`);
      return null;
    }
    const resp = out.response;
    const current = out.url;
    if (!resp.ok) { warn(`Fetch HTTP ${resp.status}`); return null; }

    const mime = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const data = out.buffer;

    try { return await _upload(data, mime, _filenameFromUrl(current, mime)); }
    catch (e) { warn(`Upload von ${url.host} fehlgeschlagen: ${e.code || e.message}`); return null; }
  };
}

module.exports = {
  makeImageResolver,
  ALLOWED_IMAGE_MIME,
  MAX_IMAGE_BYTES,
  _decodeDataUri,
  _filenameFromUrl,
};
