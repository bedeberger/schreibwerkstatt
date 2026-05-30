'use strict';
// Geocode-Resolve-Job: KI-Fallback fuer die Orte-Karte. Greift, wenn die
// regelbasierte Heuristik (lib/geocode.js: parseToponym + Zwei-Pass) keinen
// Treffer liefert. Normalisiert beschreibende/fiktive Schauplatz-Labels auf einen
// realen Toponym + Laendercode und geocodet diesen dann. Rein rueckwaertsgewandt
// (liest bestehende Ortslabels, kein Buchtext-Generieren).
//
// Zwei Einstiege teilen Prompt/Schema:
//   - runGeocodeResolveJob: Frontend on-demand (Batch via aiCall, Token-Tracking)
//   - aiResolveLocation: Cron-DI (EIN Label via callAI, kein Job-Kontext)
const express = require('express');
const { getBookSettings } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, tps,
  createJob, enqueueJob, findActiveJobId, jsonBody,
} = require('./shared');
const { geocode } = require('../../lib/geocode');
const { callAI } = require('../../lib/ai');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');

const geocodeRouter = express.Router();
const MAX_ITEMS = 200;

// KI-Resultat → Map(idStr → { ort, land }). Verwirft Eintraege ohne realen Anker
// (leeres «ort», z.B. rein fiktive Orte). land nur als gueltiger ISO-2-Code.
function _parseResolved(result) {
  const map = new Map();
  const arr = Array.isArray(result?.orte) ? result.orte : [];
  for (const r of arr) {
    if (!r || r.id == null) continue;
    const ort = String(r.ort || '').trim();
    if (!ort) continue;
    const land = /^[A-Za-z]{2}$/.test(String(r.land || '').trim()) ? String(r.land).trim().toLowerCase() : null;
    map.set(String(r.id), { ort, land });
  }
  return map;
}

// Cron-Pfad: EIN Label → { ort, land } | null. Nutzt callAI direkt (kein Job).
// Wird via DI an lib/geocode.geocodeAllBooks gereicht (haelt lib frei von routes).
async function aiResolveLocation(name, { language = 'de', region = null } = {}) {
  try {
    const { buildSystemGeocodeResolve, buildGeocodeResolvePrompt, SCHEMA_GEOCODE_RESOLVE } = await getPrompts();
    const items = [{ id: '0', name: String(name || '').trim() }];
    const result = await callAI(
      buildGeocodeResolvePrompt(items, region),
      buildSystemGeocodeResolve(),
      null, 600, null, undefined, SCHEMA_GEOCODE_RESOLVE,
    );
    return _parseResolved(result).get('0') || null;
  } catch {
    return null;
  }
}

async function runGeocodeResolveJob(jobId, items, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    logger.info(`Geocode-Resolve: ${items.length} Label(s)`);
    updateJob(jobId, { statusText: 'job.phase.geocodeResolving', progress: 10 });
    const settings = bookId ? getBookSettings(bookId, userEmail) : null;
    const language = settings?.language || 'de';
    const region = settings?.schauplatz_land || null;

    const { buildSystemGeocodeResolve, buildGeocodeResolvePrompt, SCHEMA_GEOCODE_RESOLVE } = await getPrompts();
    const promptItems = items.map(it => ({ id: String(it.id), name: it.name }));

    const tok = { in: 0, out: 0, ms: 0 };
    const result = await aiCall(jobId, tok,
      buildGeocodeResolvePrompt(promptItems, region),
      buildSystemGeocodeResolve(),
      10, 60, 1200, 0.3, 2000, undefined, SCHEMA_GEOCODE_RESOLVE,
    );
    if (!Array.isArray(result?.orte)) throw i18nError('job.error.geocodeOrteMissing');
    const resolved = _parseResolved(result);

    updateJob(jobId, { statusText: 'job.phase.geocodeLookup', progress: 65 });
    const results = [];
    for (const it of items) {
      const r = resolved.get(String(it.id));
      if (!r) { results.push({ id: it.id, lat: null, lng: null }); continue; }
      const cands = await geocode(r.ort, { lang: language, region: r.land || region });
      const c = cands[0];
      results.push(c
        ? { id: it.id, lat: c.lat, lng: c.lng, displayName: c.displayName, ort: r.ort }
        : { id: it.id, lat: null, lng: null, ort: r.ort });
    }

    const hits = results.filter(r => r.lat != null).length;
    completeJob(jobId, { results, tokensIn: tok.in, tokensOut: tok.out },
      tps(tok), `${hits}/${items.length} via KI verortet`);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error(`Geocode-Resolve Fehler: ${e.message}`, { stack: e.stack });
    failJob(jobId, e);
  }
}

geocodeRouter.post('/geocode-resolve', jsonBody, (req, res) => {
  const book_id = toIntId(req.body?.book_id);
  const items = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map(it => ({ id: it?.id, name: String(it?.name || '').trim() }))
    .filter(it => it.id != null && it.name)
    .slice(0, MAX_ITEMS);
  if (!items.length) return res.status(400).json({ error_code: 'ITEMS_REQUIRED' });
  if (book_id) setContext({ book: book_id });
  if (book_id) {
    const { requireBookAccess, sendACLError } = require('../../lib/acl');
    try { requireBookAccess(req, book_id, 'lektor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }
  const userEmail = req.session?.user?.email || null;
  const entityKey = `${book_id || 0}|${items.map(i => i.id).sort().join(',')}`;
  const existing = findActiveJobId('geocode-resolve', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('geocode-resolve', book_id || 0, userEmail,
    'job.label.geocodeResolve', { count: items.length }, entityKey);
  enqueueJob(jobId, () => runGeocodeResolveJob(jobId, items, book_id || null, userEmail));
  res.json({ jobId });
});

module.exports = { geocodeRouter, runGeocodeResolveJob, aiResolveLocation };
