'use strict';
// AsyncLocalStorage-basiertes Logging-Context-Layer.
// Middleware/Job-Wrapper rufen `runWithContext({ ... }, fn)` auf; alle
// `logger.*`-Calls innerhalb (auch in async/await-Ketten) erben den Ctx
// automatisch. Das Winston-Format liest den Store via `getContext()`.
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function runWithContext(ctx, fn) {
  return als.run(ctx, fn);
}

function getContext() {
  return als.getStore() || {};
}

function setContext(patch) {
  const store = als.getStore();
  if (store) Object.assign(store, patch);
}

// Express-Param-Handler für `:book_id`-Routes: injiziert die Buch-ID in den
// ALS-Logging-Context, damit nachfolgende `logger.*`-Calls den `book`-Slot
// im Tag-Format `[scope|user|book|jobId]` füllen.
function bookParamHandler(req, _res, next, v) {
  const id = parseInt(v, 10);
  if (id) setContext({ book: id });
  next();
}

module.exports = { als, runWithContext, getContext, setContext, bookParamHandler };
