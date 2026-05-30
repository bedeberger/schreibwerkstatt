'use strict';
// Ghostscript-Post-Step: konvertiert ein gerendertes PDF in PDF/X-3:2003.
// RGB bleibt erhalten (X-3 erlaubt geraeteunabhaengige Farbe); ein gebuendeltes
// Output-Intent-ICC (Druckbedingung, z.B. PSO Uncoated v3 / FOGRA52) wird als
// OutputIntent eingebettet. Die Druckerei separiert selbst gegen dieses Profil
// — es findet KEINE CMYK-Bild-Separation in der App statt.
//
// Muster analog lib/pdfa-validate.js: externes CLI, env-gated, non-fatal.
// Fehlt das gs-Binary oder das ICC -> { available:false }, der Job liefert das
// urspruengliche PDF (PDF/A oder unmarkiert) mit Warnung im Result.
//
// Konfiguration (ENV Boot-Layer):
//   GS_BIN        → Pfad zum gs-Binary (Default: 'gs' im PATH)
//   GS_DISABLED   → 'true' ueberspringt die Konvertierung komplett (Kill-Switch)
//   PDFX_ICC_PATH → Pfad zum Output-Intent-ICC
//                   (Default: assets/icc/PSOuncoated_v3_FOGRA52.icc, falls gebuendelt)

const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logger = require('../logger');

const TIMEOUT_MS = 120_000;
const DEFAULT_ICC = path.join(__dirname, '..', 'assets', 'icc', 'PSOuncoated_v3_FOGRA52.icc');

function _isDisabled() {
  return String(process.env.GS_DISABLED || '').toLowerCase() === 'true';
}

// PDFX_def.ps: setzt GTS_PDFXVersion + OutputIntent mit eingebettetem ICC.
// N=4: das Output-Intent-Profil beschreibt die CMYK-Druckbedingung (FOGRA),
// auch wenn der Dokumentinhalt RGB bleibt. Kein User-String fliesst hier ein
// (condition/identifier sind app-/env-kontrolliert), trotzdem PS-escapen.
function _buildPdfxDef(iccPath, { condition, identifier, title }) {
  const ps = s => String(s || '').replace(/([\\()])/g, '\\$1');
  const iccPs = iccPath.replace(/\\/g, '/');
  return `%!
/ICCProfile (${ps(iccPs)}) def
[ /GTS_PDFXVersion (PDF/X-3:2003)
  /Title (${ps(title)})
  /DOCINFO pdfmark
[/_objdef {icc_PDFX} /type /stream /OBJ pdfmark
[{icc_PDFX} <</N 4>> /PUT pdfmark
[{icc_PDFX} ICCProfile (r) file /PUT pdfmark
[/_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark
[{OutputIntent_PDFX} <<
  /Type /OutputIntent
  /S /GTS_PDFX
  /OutputCondition (${ps(condition)})
  /OutputConditionIdentifier (${ps(identifier)})
  /Info (${ps(condition)})
  /DestOutputProfile {icc_PDFX}
>> /PUT pdfmark
[{Catalog} <</OutputIntents [ {OutputIntent_PDFX} ]>> /PUT pdfmark
`;
}

function _run(args) {
  const bin = process.env.GS_BIN || 'gs';
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        const e = new Error('ghostscript-not-installed');
        e.code = 'GS_MISSING';
        return reject(e);
      }
      if (err) { err.stderr = stderr; return reject(err); }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Konvertiert einen PDF-Buffer in PDF/X-3.
 *
 * Returns:
 *   { available: false, reason }                 — gs/ICC fehlt, disabled oder Fehler (non-fatal)
 *   { available: true, buffer, identifier }      — konvertiertes PDF/X-3
 */
async function convertToPdfX(buffer, opts = {}) {
  if (_isDisabled()) return { available: false, reason: 'disabled' };

  const iccPath = opts.iccPath || process.env.PDFX_ICC_PATH || DEFAULT_ICC;
  try {
    await fs.access(iccPath);
  } catch {
    logger.warn(`PDF/X: Output-Intent-ICC nicht gefunden (${iccPath}) — Konvertierung uebersprungen.`);
    return { available: false, reason: 'icc-missing' };
  }

  const tag = crypto.randomBytes(8).toString('hex');
  const inPath  = path.join(os.tmpdir(), `pdfx-in-${tag}.pdf`);
  const outPath = path.join(os.tmpdir(), `pdfx-out-${tag}.pdf`);
  const defPath = path.join(os.tmpdir(), `pdfx-def-${tag}.ps`);

  const identifier = opts.identifier || 'FOGRA52';
  const def = _buildPdfxDef(iccPath, {
    condition:  opts.condition || 'PSO Uncoated v3 (FOGRA52)',
    identifier,
    title:      opts.title || 'Document',
  });

  try {
    await fs.writeFile(inPath, buffer);
    await fs.writeFile(defPath, def, 'latin1');
    // -dNOSAFER: das PS-`file`-Operator muss das ICC lesen duerfen. Alle Pfade
    // sind app-/env-kontrolliert (kein User-String), darum vertretbar.
    await _run([
      '-dPDFX',
      '-dBATCH', '-dNOPAUSE', '-dNOOUTERSAVE', '-dNOSAFER',
      '-sDEVICE=pdfwrite',
      '-dPDFSETTINGS=/prepress',
      '-dCompatibilityLevel=1.4',
      '-sColorConversionStrategy=UseDeviceIndependentColor',
      '-dRenderIntent=3',
      `-sOutputFile=${outPath}`,
      defPath,
      inPath,
    ]);
    const out = await fs.readFile(outPath);
    if (!out || out.length === 0) return { available: false, reason: 'empty-output' };
    return { available: true, buffer: out, identifier };
  } catch (e) {
    if (e.code === 'GS_MISSING') {
      logger.warn('Ghostscript binary not found — PDF/X-Konvertierung uebersprungen.');
      return { available: false, reason: 'binary-missing' };
    }
    logger.warn(`PDF/X-Konvertierung fehlgeschlagen: ${e.message}`, { stderr: String(e.stderr || '').slice(0, 500) });
    return { available: false, reason: 'convert-error' };
  } finally {
    fs.unlink(inPath).catch(() => {});
    fs.unlink(outPath).catch(() => {});
    fs.unlink(defPath).catch(() => {});
  }
}

module.exports = { convertToPdfX };
