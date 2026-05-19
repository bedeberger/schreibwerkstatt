// Folder-Import: AI-Fallback fuer Datums-Pattern-Erkennung wenn die regel-
// basierte Heuristik scheitert (Mischformen, ungewoehnliche Conventions).
// Das KI-Modell bekommt ein Sample der Dateinamen + Pfad-Kontext und liefert
// pro Datei ein ISO-Datum zurueck.

import { _obj, _str } from './schema-utils.js';

export function buildDateDetectPrompt(samples) {
  const list = samples.map(s => {
    const ctx = [];
    if (Number.isFinite(s.year)) ctx.push('Jahr=' + s.year);
    if (Number.isFinite(s.month)) ctx.push('Monat=' + s.month);
    const ctxStr = ctx.length ? ' (' + ctx.join(', ') + ')' : '';
    return `- ${s.path}${ctxStr}`;
  }).join('\n');

  return `Analysiere folgende Dateinamen aus einem Tagebuch-Import-Verzeichnis. Jede Datei steht fuer einen Eintrag eines bestimmten Tages. Aus dem Pfad (Jahr/Monat-Ordner) und dem Dateinamen sollst du fuer jede Datei das exakte ISO-Datum (YYYY-MM-DD) ableiten.

Regeln:
- Dateiname kann das volle Datum enthalten (z.B. "2024-03-05") oder nur den Tag (z.B. "05", "5. Maerz", "Tag-05")
- Pfad-Kontext (Jahr aus Ordnernamen, Monat aus Ordnernamen) ergaenzt fehlende Teile
- Bei Konflikt (Datei sagt anderes Datum als Pfad) gewinnt das Datum aus dem Dateinamen
- Wenn kein Datum ableitbar ist, lasse "iso" leer (Empty-String)

Dateien:
${list}

Antworte mit diesem JSON-Schema:
{
  "dateien": [
    { "path": "exakter Pfad wie oben", "iso": "YYYY-MM-DD oder leerer String" }
  ]
}`;
}

export const SCHEMA_DATE_DETECT = _obj({
  dateien: {
    type: 'array',
    items: _obj({ path: _str, iso: _str }),
  },
});
