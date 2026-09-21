'use strict';
// Wrapper fuer asynchrone Auth-Handler.
//
// Express 4 faengt die Rejection eines `async`-Handlers NICHT: der Fehler wird
// zur unbehandelten Promise-Rejection, und der Request bleibt offen, bis der
// Browser aufgibt. Auf den Anmeldepfaden ist das die schlechteste aller
// Antworten — der Nutzer sieht einen haengenden Ladebalken statt einer
// Fehlermeldung, und im Log steht nichts, was zur Route zurueckfuehrt.
//
// Darum laeuft jeder async-Handler unter routes/auth/ durch diesen Wrapper.
// Er antwortet mit 500 und einem `error_code`, damit die Client-Seite dem
// Vertrag aus docs/clients.md folgt.

const logger = require('../../logger');

function asyncRoute(label, handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch((err) => {
      logger.error(`${label}: ${err && err.stack ? err.stack : err}`);
      if (res.headersSent) return;
      res.status(500).json({ error_code: 'INTERNAL_ERROR' });
    });
  };
}

module.exports = { asyncRoute };
