'use strict';
const express = require('express');
const { handleEventStream } = require('./stream');

// Push-Kanal der SPA (SSE). Native Clients halten keinen Stream und pollen wie
// bisher — der Stream beschleunigt, alle Daten gibt es weiter über die
// gewohnten Routen.
const router = express.Router();

router.get('/stream', handleEventStream);

module.exports = router;
