'use strict';
// Facade des Auth-Routers. Mountet die verfahrens-unabhaengige Schale und
// dahinter die Router der Anmeldeverfahren, jeder hinter einem Gate auf
// `auth.method`.
//
// Reihenfolge ist Absicht: die Schale beantwortet `/login`, `/auth/logout`,
// `/invite/:token` und die ENV-Pfade fuer jedes Verfahren gleich; erst danach
// kommt das, was nur ein Verfahren kennt.

const express = require('express');
const providers = require('./providers');

const router = express.Router();

router.use(require('./shell'));
providers.mountAll(router);

module.exports = router;
