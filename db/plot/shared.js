'use strict';
// Kleine Helfer, die sich mehrere Plot-Module teilen (Facade: db/plot.js).

// Fehler mit .code für die Route (400 + error_code). Ein Wurf innerhalb einer
// db.transaction rollt die ganze Transaktion zurück — es wird nichts geschrieben.
function _codedError(code) {
  const e = new Error(code);
  e.code = code;
  return e;
}

// Positive Ganzzahl (Zahl oder Ziffern-String) → Number, sonst null. Strenger als
// parseInt: „3abc", 2.5, true, Objekte fallen durch (Order-Payload-Typprüfung).
function _posInt(raw) {
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : null;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    const n = parseInt(raw, 10);
    return n > 0 ? n : null;
  }
  return null;
}

module.exports = { _codedError, _posInt };
