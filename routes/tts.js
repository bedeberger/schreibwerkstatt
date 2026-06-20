'use strict';
// Text-to-Speech-Proxy (self-hosted) — „Proof-Listening" (Gegenstueck zum
// STT-Diktat). Frontend liest im Notebook-Editor den Seitentext satzweise vor:
// pro Satz ein POST /tts/speak; der Server holt Host/Model/Voice/Key aus
// app_settings und forwarded an einen OpenAI-kompatiblen Speech-Endpunkt
// `${host}/v1/audio/speech`. Die zurueckkommenden Audio-Bytes werden 1:1 ans
// Frontend durchgereicht (kein Persistieren). Credentials/Host verlassen den
// Server nie.
//
// Dritte Sync-Proxy-Ausnahme zur Job-Queue-Regel (analog routes/stt.js und
// routes/languagetool.js): kurzer Request/Response-Synthesecall, kein
// KI-Analysejob, kein Token-Budget, kein callAI. TTS liest verbatim vor —
// keine generative KI.
//
// Disabled / no-Host -> 404 { error: 'tts_disabled' } (Frontend behandelt als
// "Feature aus", der Vorlese-Button ist ohnehin nicht im DOM).

const express = require('express');
const logger = require('../logger');
const appSettings = require('../lib/app-settings');
const { toIntId } = require('../lib/validate');
const { setContext } = require('../lib/log-context');
const { getBookLocale } = require('../db/schema');

const router = express.Router();
const TEXT_MAX = 8 * 1024; // 8 KB — ein Satz/Absatz pro Request, nie ganze Seiten
const UPSTREAM_TIMEOUT_MS = 20_000;

// response_format -> MIME fuer den Audio-Download. Deckt die OpenAI-Speech-
// Formate ab; ein unbekanntes Format faellt auf den Upstream-Content-Type bzw.
// audio/mpeg zurueck.
const FORMAT_MIME = {
  mp3:  'audio/mpeg',
  opus: 'audio/ogg',
  aac:  'audio/aac',
  flac: 'audio/flac',
  wav:  'audio/wav',
  pcm:  'audio/L16',
};

router.post('/speak', express.json({ limit: TEXT_MAX + 2048 }), async (req, res) => {
  const enabled = appSettings.get('tts.enabled') === true;
  const host = String(appSettings.get('tts.host') || '').replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!enabled || !host) {
    return res.status(404).json({ error: 'tts_disabled' });
  }

  const bookId = toIntId(req.query.bookId);
  const pageId = toIntId(req.query.pageId);
  if (bookId) setContext({ book: bookId });
  const userEmail = req.session?.user?.email || null;
  const log = logger.child({ job: 'tts', user: userEmail || '-', book: bookId || '-' });

  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  const trimmed = text.trim();
  const ctx = `page=${pageId || '-'} chars=${trimmed.length}`;
  if (!trimmed) {
    return res.status(400).json({ error: 'tts_no_text' });
  }
  if (text.length > TEXT_MAX) {
    log.warn(`reject too-large ${ctx} max=${TEXT_MAX}`);
    return res.status(413).json({ error: 'tts_text_too_large', max: TEXT_MAX });
  }

  const model = String(appSettings.get('tts.model') || '').trim();
  // Stimme locale-aware: die Buch-Locale gewinnt (SSoT wie bei STT die Sprache).
  // Ist fuer ihren Sprachcode eine Stimme gesetzt (tts.voice.<lang>, z. B.
  // tts.voice.de), wird die genommen; sonst die Standard-Stimme (tts.voice).
  // Region wird abgeschnitten (de-CH -> de). Ohne Buchscope greift der Default.
  let lang = '';
  if (bookId) {
    try { lang = getBookLocale(bookId, userEmail) || ''; } catch { /* noop */ }
  }
  lang = lang.split('-')[0].trim().toLowerCase();
  const localeVoice = lang ? String(appSettings.get(`tts.voice.${lang}`) || '').trim() : '';
  const voice = localeVoice || String(appSettings.get('tts.voice') || '').trim();
  const format = String(appSettings.get('tts.format') || 'mp3').trim().toLowerCase();
  const speedRaw = Number(appSettings.get('tts.speed'));
  const speed = Number.isFinite(speedRaw) ? speedRaw : 1;
  const apiKey = String(appSettings.get('tts.api_key') || '').trim();

  const payload = { model, input: trimmed, response_format: format, speed };
  if (voice) payload.voice = voice;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const upstream = await fetch(`${host}/v1/audio/speech`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!upstream.ok) {
      log.warn(`upstream ${upstream.status} ${ctx} latency=${Date.now() - t0}ms`);
      return res.status(502).json({ error: 'tts_upstream', upstream_status: upstream.status });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    const mime = FORMAT_MIME[format] || upstream.headers.get('content-type') || 'audio/mpeg';
    log.info(`ok ${ctx} bytes=${buf.length} ${Date.now() - t0}ms`);
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'no-store');
    return res.end(buf);
  } catch (err) {
    const isAbort = err && (err.name === 'AbortError' || err.code === 'ABORT_ERR');
    log.warn(`fetch ${isAbort ? 'TIMEOUT' : err.message} ${ctx} latency=${Date.now() - t0}ms`);
    return res.status(isAbort ? 408 : 502).json({ error: isAbort ? 'tts_timeout' : 'tts_upstream' });
  } finally {
    clearTimeout(timer);
  }
});

module.exports = router;
