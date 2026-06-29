'use strict';
// Provider-übergreifende Helfer: Mutex-Locks für lokale Provider, Connection-
// Fehler-Erkennung, i18n-keyed Unreachable-Error, Output-Runaway-Grenze.

// Sicherheitsgrenze für lokale Modelle: Abbruch wenn Output-Tokens das N-fache
// der Input-Tokens übersteigen. Verhindert endlose Wiederholungsschleifen.
const MAX_OUTPUT_RATIO = 4;

// Ollama und Llama verarbeiten parallele Anfragen schlecht (VRAM-Überlauf, Verbindungsabbruch).
// Dieser Mutex serialisiert alle lokalen KI-Calls global – Jobs laufen weiter parallel,
// nur die eigentlichen KI-Aufrufe kommen nacheinander am Server an.
function makeLock() {
  let queue = Promise.resolve();
  return function withLock(fn) {
    const next = queue.then(fn);
    queue = next.catch(() => {}); // Fehler nicht in die Queue-Chain leiten
    return next;
  };
}
const withOllamaLock = makeLock();
const withOpenAICompatLock = makeLock();

// Erkennt Verbindungs-Fehler (Provider offline/DNS/Timeout) anhand cause.code.
// Liefert null, wenn der Fehler keine Connection-Klasse ist.
const _CONN_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNRESET', 'ENETUNREACH']);
function _connErrorCode(err) {
  const code = err?.cause?.code || err?.code;
  if (code && _CONN_CODES.has(code)) return code;
  // node fetch wrappt DNS/Connect-Fehler oft als generisches "fetch failed".
  if (err?.message === 'fetch failed' && !err?.cause?.code) return 'FETCH_FAILED';
  return null;
}

// Wirft einen i18n-keyed Error für Provider-Unreachable. failJob übergibt
// `i18nParams` als `errorParams` an das Frontend; `t('error.OPENAI_COMPAT_UNREACHABLE', …)`
// rendert die Meldung in der User-Locale.
function _unreachableError(provider, host, fetchErr) {
  const code = _connErrorCode(fetchErr);
  const detail = code || fetchErr?.cause?.message || fetchErr?.message || 'unknown';
  const key = provider === 'ollama' ? 'error.OLLAMA_UNREACHABLE' : 'error.OPENAI_COMPAT_UNREACHABLE';
  const err = new Error(key);
  err.i18nParams = { host, detail };
  err.code = 'AI_UNREACHABLE';
  return err;
}

module.exports = {
  MAX_OUTPUT_RATIO,
  makeLock, withOllamaLock, withOpenAICompatLock,
  _connErrorCode, _unreachableError,
};
