'use strict';
// Admin-Tab „Geraete": listet alle Device-Tokens (native Mac-Focus-Clients)
// user-uebergreifend mit gemeldeter Client-Version, Nutzungszaehler und letzter
// Aktivitaet. Read-only — Ausstellen/Widerrufen bleibt beim User unter /me.
// Die installierten Versionen sind gegen das neueste GitHub-Release (latestVersion)
// abgleichbar, damit veraltete Clients sichtbar werden.

const express = require('express');
const { requireAdmin } = require('../lib/admin-mw');
const deviceTokens = require('../db/device-tokens');
const macclientRelease = require('../lib/macclient-release');
const logger = require('../logger');

const router = express.Router();
router.use(requireAdmin);

router.get('/', async (req, res) => {
  try {
    const devices = deviceTokens.listAllDeviceTokens();
    let latestVersion = null;
    try {
      const rel = await macclientRelease.getLatestRelease();
      if (rel && rel.available) latestVersion = rel.version;
    } catch { /* Release-Abruf nie den Tab blockieren lassen */ }
    res.json({ devices, latestVersion });
  } catch (e) {
    logger.error(`admin-devices list failed: ${e.message}`);
    res.status(500).json({ error_code: 'LIST_FAILED', message: e.message });
  }
});

module.exports = router;
