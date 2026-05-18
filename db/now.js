'use strict';
// SQL-Konstante fuer ISO-8601-Timestamp mit Z-Suffix. Ersetzt `datetime('now')`
// in INSERT/UPDATE-Statements: `datetime('now')` liefert "YYYY-MM-DD HH:MM:SS"
// (UTC ohne TZ-Marker), JS `new Date("...")` parsed das als lokale Browser-Zeit
// statt UTC und `toLocaleString({ timeZone: appTimezone })` zeigt dann die
// UTC-Uhrzeit unter dem app.timezone-Label. ISO+Z parsed JS unmissverstaendlich
// als UTC und der Display-Formatter konvertiert korrekt in app.timezone.

const NOW_ISO_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

module.exports = { NOW_ISO_SQL };
