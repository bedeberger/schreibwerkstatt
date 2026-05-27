'use strict';
// Block-Level-Merge-Telemetrie. Frontend meldet Auto-Merge-/Konflikt-Events;
// persistiert als kumulierte Counter (db/merge-telemetry), gescraped via /metrics.
// Session-authed (Mount nach Auth-Guard). Fire-and-forget aus dem Client.

const express = require('express');
const { bumpMergeCounter } = require('../db/merge-telemetry');
const logger = require('../logger');

const router = express.Router();
const jsonBody = express.json();

// Erlaubte Basis-Events. 'conflict_resolved' fuehrt zusaetzlich einen
// Auflösungs-Mix (local/remote/both) als getrennte Counter.
const ALLOWED_EVENTS = new Set([
  'silent_success',
  'conflict_shown',
  'conflict_resolved',
  'fallback_overwrite',
]);
const RESOLVE_CHOICES = ['local', 'remote', 'both'];

router.post('/merge', jsonBody, (req, res) => {
  if (!req.session?.user?.email) return res.status(401).json({ error_code: 'LOGIN_REQ' });
  const event = (req.body?.event || '').toString();
  if (!ALLOWED_EVENTS.has(event)) {
    return res.status(400).json({ error_code: 'INVALID_EVENT' });
  }
  try {
    if (event === 'conflict_resolved') {
      const mix = req.body?.mix && typeof req.body.mix === 'object' ? req.body.mix : {};
      for (const choice of RESOLVE_CHOICES) {
        const n = parseInt(mix[choice], 10);
        if (n > 0) bumpMergeCounter(`conflict_resolved_${choice}`, n);
      }
    } else {
      bumpMergeCounter(event, 1);
    }
    res.json({ ok: true });
  } catch (e) {
    logger.error('[telemetry/merge] DB-Fehler: ' + e.message);
    res.status(500).json({ error_code: 'DB_ERROR' });
  }
});

module.exports = router;
