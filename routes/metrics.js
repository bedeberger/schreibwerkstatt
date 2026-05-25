'use strict';
// Prometheus-Endpoint /metrics. Bearer-Token-Auth via lib/bearer-auth
// (Scope `metrics:read`). Text-Format 0.0.4. Cache-Control: no-store —
// jeder Scrape liest Live-State.

const express = require('express');
const { requireBearer } = require('../lib/bearer-auth');
const { collectMetrics } = require('../lib/metrics-collector');
const logger = require('../logger');

const router = express.Router();

router.get('/', requireBearer('metrics:read'), (_req, res) => {
  try {
    const body = collectMetrics();
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.set('Cache-Control', 'no-store');
    res.send(body);
  } catch (e) {
    logger.error(`/metrics collect failed: ${e.message}`);
    res.status(500).type('text/plain').send('# metrics collection failed\n');
  }
});

module.exports = router;
