'use strict';

// Einheitlicher Filename-Builder für User-Downloads (Buch-Export, Finetune-
// Export, PDF/EPUB/DOCX, Fassungen). Format: `<prefix>-<name>-YYYY-MM-DD-hh-mm-ss.<ext>`.
// Zeitstempel in app.timezone (lib/local-date.js), nicht in Server-TZ und nicht
// UTC — der User erwartet „jetzt" auf seiner Uhr, auch wenn der Container in UTC läuft.

const { currentTz } = require('./local-date');

function formatExportTimestamp(date = new Date(), tz = currentTz()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}-${parts.hour}-${parts.minute}-${parts.second}`;
}

// Dateisystem-tauglicher Namensteil: Diakritika fallen weg (ä → a, é → e),
// ß → ss, alles Übrige ausser [A-Za-z0-9._-] wird `_`. Bewusst NICHT
// lib/slug.js: der URL-Slug hat eigene Regeln (Kleinschreibung, Bindestriche),
// ein Dateiname behält die Schreibung des Buchtitels.
function fileSafeName(name) {
  return (name || 'book')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'book';
}

function buildExportFilename({ prefix, slug, ext, date }) {
  return `${prefix}-${fileSafeName(slug)}-${formatExportTimestamp(date)}.${ext}`;
}

module.exports = { formatExportTimestamp, fileSafeName, buildExportFilename };
