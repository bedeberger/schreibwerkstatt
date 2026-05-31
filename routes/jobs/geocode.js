'use strict';
// Geocode-Resolve-Job (KI-first): normalisiert beschreibende/fiktive Schauplatz-
// Labels der Orte-Karte auf eine praezise reale Anfrage (Toponym + Laendercode)
// und geocodet diese. Laeuft VOR dem externen Geocoder, weil dieser auf rohe
// Labels («Badi Olten») oft Fehltreffer liefert. Rein rueckwaertsgewandt (liest
// bestehende Ortslabels, kein Buchtext-Generieren). KI-Call laeuft als Job →
// Token-/Statistik-Tracking via aiCall.
//
// Kontext fuers Disambiguieren (alles optional): Buch-Land (schauplatz_land),
// Buch-Kontext-Freitext (buch_kontext) und die Wohnadressen der mit dem Ort
// verknuepften Figuren (location_figures → figures.wohnadresse).
const express = require('express');
const { db, getBookSettings } = require('../../db/schema');
const {
  makeJobLogger, updateJob, completeJob, failJob, i18nError,
  aiCall, getPrompts, tps,
  createJob, enqueueJob, findActiveJobId, jsonBody,
} = require('./shared');
const { geocode } = require('../../lib/geocode');
const { toIntId } = require('../../lib/validate');
const { setContext } = require('../../lib/log-context');

const geocodeRouter = express.Router();
const MAX_ITEMS = 200;
const BOOK_CONTEXT_MAX = 400;
const MAX_HINTS_PER_ITEM = 3;

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

// Wohnadressen der mit den Orten verknuepften Figuren → Map(locationId → [adr]).
// Soft-Hinweis fuers Disambiguieren (z.B. gleichnamige Orte); die KI gewichtet,
// der geografische Anker des Labels selbst hat im Prompt Vorrang.
function _figureHints(itemIds) {
  const ids = itemIds.filter(n => Number.isInteger(n));
  const byLoc = new Map();
  if (!ids.length) return byLoc;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT lf.location_id AS lid, f.wohnadresse AS wohn
       FROM location_figures lf JOIN figures f ON f.id = lf.figure_id
      WHERE lf.location_id IN (${placeholders})
        AND f.wohnadresse IS NOT NULL AND TRIM(f.wohnadresse) != ''`
  ).all(...ids);
  for (const r of rows) {
    if (!byLoc.has(r.lid)) byLoc.set(r.lid, []);
    const list = byLoc.get(r.lid);
    const v = String(r.wohn).trim();
    if (list.length < MAX_HINTS_PER_ITEM && !list.includes(v)) list.push(v);
  }
  return byLoc;
}

async function runGeocodeResolveJob(jobId, items, bookId, userEmail) {
  const logger = makeJobLogger(jobId);
  try {
    logger.info(`Geocode-Resolve: ${items.length} Label(s)`);
    updateJob(jobId, { statusText: 'job.phase.geocodeResolving', progress: 10 });
    const settings = bookId ? getBookSettings(bookId, userEmail) : null;
    const language = settings?.language || 'de';
    const region = settings?.schauplatz_land || null;
    const bookContext = (settings?.buch_kontext || '').trim().slice(0, BOOK_CONTEXT_MAX) || null;

    const hintsByLoc = _figureHints(items.map(it => it.id));
    const { buildSystemGeocodeResolve, buildGeocodeResolvePrompt, SCHEMA_GEOCODE_RESOLVE } = await getPrompts();
    const promptItems = items.map(it => ({
      id: String(it.id),
      name: it.name,
      hints: hintsByLoc.get(it.id) || [],
    }));

    const tok = { in: 0, out: 0, ms: 0 };
    // Output skaliert mit der Label-Anzahl: pro Label ein { id, ort, land }-Objekt
    // (~30 Output-Tokens). Statischer Cap truncated sonst grosse Batches still.
    const maxOut = 800 + promptItems.length * 60;
    const expectedChars = Math.max(1200, promptItems.length * 70);
    const result = await aiCall(jobId, tok,
      buildGeocodeResolvePrompt(promptItems, { region, bookContext }),
      buildSystemGeocodeResolve(),
      10, 60, expectedChars, 0.3, maxOut, undefined, SCHEMA_GEOCODE_RESOLVE,
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
  if (!book_id) return res.status(400).json({ error_code: 'BOOK_ID_REQUIRED' });
  const items = (Array.isArray(req.body?.items) ? req.body.items : [])
    .map(it => ({ id: toIntId(it?.id), name: String(it?.name || '').trim() }))
    .filter(it => it.id != null && it.name)
    .slice(0, MAX_ITEMS);
  if (!items.length) return res.status(400).json({ error_code: 'ITEMS_REQUIRED' });
  setContext({ book: book_id });
  {
    const { requireBookAccess, sendACLError } = require('../../lib/acl');
    try { requireBookAccess(req, book_id, 'lektor'); }
    catch (e) { if (sendACLError(res, e)) return; throw e; }
  }
  const userEmail = req.session?.user?.email || null;
  const entityKey = `${book_id}|${items.map(i => i.id).sort((a, b) => a - b).join(',')}`;
  const existing = findActiveJobId('geocode-resolve', entityKey, userEmail);
  if (existing) return res.json({ jobId: existing, existing: true });
  const jobId = createJob('geocode-resolve', book_id, userEmail,
    'job.label.geocodeResolve', { count: items.length }, entityKey);
  enqueueJob(jobId, () => runGeocodeResolveJob(jobId, items, book_id, userEmail));
  res.json({ jobId });
});

module.exports = { geocodeRouter, runGeocodeResolveJob };
