'use strict';
// Normalisierte Content-Endpunkte (Buecher, Kapitel, Seiten) im App-Domain-Shape —
// Facade über routes/content/.
//
// Diese Schicht ist nur dünne HTTP-Logik: Validierung, Token-Check, Logging-
// Context, ACL-Guards — die eigentliche Storage-Logik (inkl. Mapper + cleanPageHtml)
// lebt in [lib/content-store.js](../lib/content-store.js).
//
// Aufteilung (Submodule registrieren auf denselben Router):
//   content/books.js    — Buch-Ebene (Liste/Detail/Tree/Changes/Sync/Order/CRUD),
//                          Buch-weite Geräte-Präsenz + Volltextsuche.
//   content/pages.js     — Seiten-Ebene (Detail/Save/Create/Delete), Page-Presence,
//                          Page-Revisions.
//   content/chapters.js  — Kapitel-Ebene (Detail/Create/Update/Delete).
//   content/assets.js    — OTA-/Release-Assets der nativen Clients.
//   content/shared.js    — geteilte Guards/Helfer/Konstanten.
//
// Routen-Pfade sind über die Module hinweg disjunkt (literale erste Segmente
// /books · /chapters · /pages · /search · /editor-bundle.zip · /macclient* ·
// /android*) → die Registrierungs-Reihenfolge ändert das Matching nicht.

const express = require('express');
const { bookParamHandler } = require('../lib/log-context');

const router = express.Router();
router.param('book_id', bookParamHandler);

require('./content/books').register(router);
require('./content/chapters').register(router);
require('./content/pages').register(router);
require('./content/assets').register(router);

module.exports = router;
