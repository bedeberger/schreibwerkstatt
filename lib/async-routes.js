'use strict';
// Async-Handler in Express 4 + finaler JSON-Fehler-Handler.
//
// Express 4 faengt nur synchrone Throws eines Handlers. Ein `async`-Handler, der
// nach einem `await` wirft, liefert eine rejected Promise, die niemand ansieht:
// der Request haengt bis zum Client-Timeout, der Fehler landet bestenfalls als
// unhandledRejection im Log. `install()` patcht darum einmal beim Boot die
// Aufrufstelle, an der Express JEDEN Handler ausfuehrt (Layer#handle_request /
// #handle_error, dazu router.param-Callbacks): liefert der Handler eine Promise,
// geht deren Rejection per `next(err)` an die Fehler-Kette. Kein Umschreiben
// der ~120 async-Handler, keine neue Dependency.
//
// Arity bleibt erhalten: Express unterscheidet Request- (<= 3) und Fehler-
// Handler (4) an `fn.length` — der Patch wrappt keine Funktionen, er wertet nur
// den Rueckgabewert aus.
//
// Nach bereits gesendeten Headern wird nicht mehr an `next(err)` gereicht (das
// endete im finalhandler mit `socket.destroy()` und kappte z.B. einen
// SSE-Stream), sondern nur geloggt.

const logger = require('../logger');

let _installed = false;

function _isThenable(v) {
  return v != null && typeof v.then === 'function';
}

function _forward(res, next, err) {
  if (res && res.headersSent) {
    logger.error(`Async-Handler-Fehler nach gesendeten Headern: ${err?.stack || err?.message || err}`);
    return;
  }
  next(err || new Error('async handler rejected without reason'));
}

function install() {
  if (_installed) return;
  _installed = true;
  const Layer = require('express/lib/router/layer');
  const Router = require('express/lib/router');

  Layer.prototype.handle_request = function handle(req, res, next) {
    const fn = this.handle;
    if (fn.length > 3) return next();
    try {
      const ret = fn(req, res, next);
      if (_isThenable(ret)) ret.then(null, (err) => _forward(res, next, err));
    } catch (err) {
      next(err);
    }
  };

  Layer.prototype.handle_error = function handle_error(error, req, res, next) {
    const fn = this.handle;
    if (fn.length !== 4) return next(error);
    try {
      const ret = fn(error, req, res, next);
      if (_isThenable(ret)) ret.then(null, (err) => _forward(res, next, err));
    } catch (err) {
      next(err);
    }
  };

  const origParam = Router.param;
  Router.param = function param(name, fn) {
    if (typeof name === 'string' && typeof fn === 'function') {
      const wrapped = function asyncParam(req, res, next, val, key) {
        const ret = fn.call(this, req, res, next, val, key);
        if (_isThenable(ret)) ret.then(null, (err) => _forward(res, next, err));
        return ret;
      };
      return origParam.call(this, name, wrapped);
    }
    return origParam.call(this, name, fn);
  };
}

/** Finaler Fehler-Handler (als letzte Middleware registrieren).
 *  Client-Fehler mit `status` 4xx (body-parser: zu gross, kaputtes JSON) behalten
 *  ihren Status; alles andere ist `500 { error_code: 'INTERNAL' }`. Keine
 *  Fehlerdetails an den Client — die stehen im Log. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) {
    logger.error(`Fehler nach gesendeten Headern (${req.method} ${req.originalUrl}): ${err?.stack || err?.message || err}`);
    return;
  }
  const status = Number(err?.status || err?.statusCode);
  if (status >= 400 && status < 500) {
    const code = err.type === 'entity.too.large' ? 'PAYLOAD_TOO_LARGE'
      : err.type === 'entity.parse.failed' ? 'INVALID_JSON'
        : 'BAD_REQUEST';
    return res.status(status).json({ error_code: code });
  }
  logger.error(`Unbehandelter Fehler (${req.method} ${req.originalUrl}): ${err?.stack || err?.message || err}`);
  return res.status(500).json({ error_code: 'INTERNAL' });
}

module.exports = { install, errorHandler };
