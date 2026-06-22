'use strict';
// Bild-Generierung via self-hosted, OpenAI-kompatiblen Image-Endpunkt
// (`${host}/v1/images/generations`, z.B. ComfyUI-/SD-WebUI-/Flux-Bridge, vLLM,
// echtes OpenAI). Aufgerufen aus dem agentischen Buch-Chat-Tool `generate_image`.
//
// App-Philosophie (KI rueckwaertsgewandt): erzeugte Bilder sind reine
// Weltaufbau-/Chat-Visualisierung und gehen NIE in den Manuskript-Text. Diese
// Lib persistiert nichts und kennt keinen Buchinhalt — sie reicht nur einen
// Prompt an den Endpunkt durch und liefert das rohe Bild-Buffer zurueck.
//
// Host/Model/Key kommen aus app_settings und verlassen den Server nie. Eigener
// Call-Pfad neben lib/ai.js#callAI: das ist KEIN JSON-Call, sondern ein
// Binaer-Resultat — die „callAI liefert nur JSON"-Invariante gilt hier nicht.

const appSettings = require('./app-settings');
const logger = require('../logger');

// Raster-Image-Allowlist. Der Upstream-Content-Type ist nicht vertrauenswürdig
// (externer Dienst / MITM / Fehlkonfiguration) und wird persistiert + später
// same-origin als Content-Type ausgeliefert — `text/html`/`image/svg+xml` wären
// ein Stored-XSS-Vektor. Unbekanntes → image/png (rohe Bytes, nie ausführbar).
const SAFE_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

class ImageGenError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'ImageGenError';
    this.code = code;
  }
}

function imageGenEnabled() {
  return appSettings.get('image.enabled') === true
    && !!String(appSettings.get('image.host') || '').trim();
}

// Erzeugt ein Bild zum Prompt. Gibt { buffer, mime, size, revisedPrompt }.
// `signal` (Job-Abbruch) wird mit dem internen Timeout-Controller verknuepft.
async function generateImage({ prompt, size, signal } = {}) {
  if (!imageGenEnabled()) throw new ImageGenError('image_disabled');
  const p = String(prompt || '').trim();
  if (!p) throw new ImageGenError('image_no_prompt');

  const host = String(appSettings.get('image.host') || '').trim()
    .replace(/\/+$/, '').replace(/\/v1$/i, '');
  const model = String(appSettings.get('image.model') || '').trim();
  const apiKey = String(appSettings.get('image.api_key') || '').trim();
  const sz = String(size || appSettings.get('image.size') || '1024x1024').trim();
  const timeoutMs = Number(appSettings.get('image.timeout_ms')) || 120000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener('abort', onAbort);
  }
  const t0 = Date.now();
  try {
    const body = { prompt: p, n: 1, size: sz, response_format: 'b64_json' };
    if (model) body.model = model;
    const headers = {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    };
    const resp = await fetch(`${host}/v1/images/generations`, {
      method: 'POST', headers, body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      logger.warn(`image-gen upstream ${resp.status} latency=${Date.now() - t0}ms ${txt.slice(0, 200)}`);
      throw new ImageGenError('image_upstream', `upstream ${resp.status}`);
    }
    const json = await resp.json().catch(() => null);
    const item = json?.data?.[0];
    if (!item) throw new ImageGenError('image_empty', 'Antwort enthielt kein Bild');

    let buffer;
    let mime = 'image/png';
    if (item.b64_json) {
      buffer = Buffer.from(item.b64_json, 'base64');
    } else if (item.url) {
      // Endpunkt lieferte eine URL statt b64 — Bild nachladen.
      const imgResp = await fetch(item.url, { signal: ctrl.signal });
      if (!imgResp.ok) throw new ImageGenError('image_upstream', `image url ${imgResp.status}`);
      mime = (imgResp.headers.get('content-type') || '').split(';')[0].trim() || 'image/png';
      buffer = Buffer.from(await imgResp.arrayBuffer());
    } else {
      throw new ImageGenError('image_empty', 'Antwort hatte weder b64_json noch url');
    }
    if (!buffer.length) throw new ImageGenError('image_empty', 'leeres Bild-Buffer');

    logger.info(`image-gen ok size=${sz} bytes=${buffer.length} ${Date.now() - t0}ms`);
    return { buffer, mime, size: sz, revisedPrompt: item.revised_prompt || null };
  } catch (err) {
    if (err instanceof ImageGenError) throw err;
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    throw new ImageGenError(isAbort ? 'image_timeout' : 'image_upstream', err.message);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = { generateImage, imageGenEnabled, ImageGenError };
