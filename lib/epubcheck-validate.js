'use strict';
// EPUBCheck-CLI-Wrapper (W3C-Referenzvalidator). Spawnt das Binary mit JSON-
// Report-Output und gibt einen strukturierten Bericht zurück. Pendant zu
// lib/pdfa-validate.js (veraPDF) — gleiches non-fatal-Muster.
//
// Wenn das Binary nicht verfügbar ist (Dev-Setups ohne epubcheck), liefert die
// Funktion `{ available: false }`. Der Job-Wrapper interpretiert das als
// „Validation skipped" und liefert das EPUB trotzdem aus, mit einem Hinweis im
// Job-Result.
//
// Konfiguration:
//   EPUBCHECK_BIN          → ENV Boot-Layer: Pfad zum epubcheck-Binary (Default: 'epubcheck' im PATH)
//   epub.validate.disabled → app_settings: true überspringt Validierung komplett.

const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');
const appSettings = require('./app-settings');

const BIN = process.env.EPUBCHECK_BIN || 'epubcheck';
const TIMEOUT_MS = 60_000;

function _isDisabled() {
  return appSettings.get('epub.validate.disabled') === true;
}

function _run(args) {
  return new Promise((resolve, reject) => {
    // epubcheck liefert Exit-Code 1 bei Validierungsfehlern — das ist kein
    // Spawn-Fehler, der Report wird trotzdem geschrieben. Nur ENOENT (Binary
    // fehlt) wird als Fehler hochgereicht.
    const child = execFile(BIN, args, { timeout: TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        const e = new Error('epubcheck-not-installed');
        e.code = 'EPUBCHECK_MISSING';
        return reject(e);
      }
      resolve({ stdout, stderr, code: err ? err.code : 0 });
    });
    child.on('error', () => {});
  });
}

/**
 * Validiert einen EPUB-Buffer gegen die EPUB-Spezifikation (epubcheck).
 *
 * Returns:
 *   { available: false }                                            — Binary fehlt / disabled
 *   { available: true, passed, errors, warnings, fatals, report }   — Standard-Fall
 *   wirft bei Spawn-Fehlern, die nicht ENOENT sind
 */
async function validateEpub(buffer) {
  if (_isDisabled()) return { available: false, reason: 'disabled' };
  const rnd = crypto.randomBytes(8).toString('hex');
  // epubcheck liest aus einer Datei; der JSON-Report wird in eine zweite Datei
  // geschrieben (--json <pfad>, nicht stdout). Beide danach aufräumen.
  const tmpEpub = path.join(os.tmpdir(), `epubcheck-${rnd}.epub`);
  const tmpJson = path.join(os.tmpdir(), `epubcheck-${rnd}.json`);
  await fs.writeFile(tmpEpub, buffer);
  try {
    try {
      await _run([tmpEpub, '--json', tmpJson, '--quiet']);
    } catch (e) {
      if (e.code === 'EPUBCHECK_MISSING') {
        logger.warn('epubcheck binary not found — EPUB-Validierung übersprungen.');
        return { available: false, reason: 'binary-missing' };
      }
      throw e;
    }
    let report;
    try {
      report = JSON.parse(await fs.readFile(tmpJson, 'utf8'));
    } catch {
      logger.warn('epubcheck: JSON-Report nicht lesbar — verworfen.');
      return { available: false, reason: 'unparseable-output' };
    }
    const messages = Array.isArray(report?.messages) ? report.messages : [];
    let errors = 0, warnings = 0, fatals = 0;
    for (const m of messages) {
      const sev = String(m?.severity || '').toUpperCase();
      if (sev === 'FATAL') fatals += 1;
      else if (sev === 'ERROR') errors += 1;
      else if (sev === 'WARNING') warnings += 1;
    }
    const passed = fatals === 0 && errors === 0;
    return { available: true, passed, errors, warnings, fatals, report };
  } finally {
    fs.unlink(tmpEpub).catch(() => {});
    fs.unlink(tmpJson).catch(() => {});
  }
}

module.exports = { validateEpub };
