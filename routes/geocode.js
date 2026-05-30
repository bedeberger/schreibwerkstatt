'use strict';
// Geocoding-Proxy fuer die Orte-Karte. Schlaegt Koordinaten zu einem Ortsnamen
// vor; der User korrigiert per Marker-Drag. Kein KI-Call → normale Route (keine
// Job-Queue). Auth greift global. Kern + Provider-Logik leben in lib/geocode.js
// (geteilt mit dem naechtlichen Auto-Verortungs-Cron).
const express = require('express');
const { geocode, parseNominatimResults, parsePhotonResults } = require('../lib/geocode');

const router = express.Router();
const MAX_QUERY_LEN = 200;

router.get('/', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error_code: 'QUERY_REQUIRED' });
  if (q.length > MAX_QUERY_LEN) return res.status(400).json({ error_code: 'QUERY_TOO_LONG' });

  const lang = /^(de|en)$/.test(String(req.query.lang)) ? String(req.query.lang) : 'de';
  const region = /^[A-Za-z]{2}$/.test(String(req.query.region)) ? String(req.query.region) : null;

  const candidates = await geocode(q, { lang, region });
  res.json({ candidates });
});

module.exports = router;
module.exports.parseNominatimResults = parseNominatimResults;
module.exports.parsePhotonResults = parsePhotonResults;
