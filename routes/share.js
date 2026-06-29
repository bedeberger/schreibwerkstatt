'use strict';
// Share-Link-Routes — Facade über routes/share/. Public-Reader (GET /share/:token,
// POST .../comment) + Auth-Owner-API (GET/POST/PATCH/DELETE /share/api/...).
//
// Mount in server.js VOR Auth-Guard, damit Reader-Route ohne Session erreichbar
// bleibt. Owner-API-Routen prüfen Session selbst (requireSession in share/api.js).
//
// Reader ZUERST registrieren: die `/:token`-Pattern (Single-Segment) und die
// `/api/...`-Routen (≥2 Segmente mit literalen Segmenten `api`/`comments`/`links`)
// kollidieren nicht, aber die Reihenfolge spiegelt die ursprüngliche Definition.
//
// Geteilte Helfer (Templates, Content-Rendering, data-bid-Auflösung,
// Kommentar-Serialisierung, Body-Parser): lib/share-helpers.js.

const express = require('express');
const router = express.Router();

require('./share/reader').register(router);
require('./share/api').register(router);

module.exports = router;
