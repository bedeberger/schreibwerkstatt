'use strict';
// Schlagworte an Quellen (`source_tags`). Ein Schlagwort ist eine Eigenschaft
// des Bibliothekseintrags, nicht der Zuordnung zu einem Buch — es gilt darum in
// allen Arbeiten, in denen die Quelle liegt, und setzen darf es nur der
// Besitzer (Schranke in routes/sources.js, wie bei jedem anderen Pool-Feld).
//
// Gelesen werden die Schlagworte einer Quelle mit der Zeile selbst
// (`tags_json` in shared.js#SOURCE_COLS); hier liegen nur der Schreibpfad und
// die Sicht „welche Schlagworte hat meine Bibliothek".

const { db } = require('../connection');
const { NOW_ISO_SQL } = require('../now');
const { normalizeTags } = require('./shared');

const _stmtClear = db.prepare('DELETE FROM source_tags WHERE source_id = ?');
const _stmtInsert = db.prepare(`
  INSERT OR IGNORE INTO source_tags (source_id, tag, created_at)
  VALUES (?, ?, ${NOW_ISO_SQL})
`);

// Schreibweise je Schlagwort: MIN(tag) waehlt bei „ZHAW"/„zhaw" deterministisch
// eine Form (der PK ist NOCASE, die gespeicherten Strings koennen abweichen).
const _stmtPoolTags = db.prepare(`
  SELECT MIN(t.tag) AS tag, COUNT(*) AS count
    FROM source_tags t
    JOIN sources s ON s.id = t.source_id
   WHERE s.owner_email = ?
   GROUP BY t.tag COLLATE NOCASE
`);

/** Schlagworte einer Quelle ersetzen (Full-Replace, wie jede Liste an der
 *  Quelle). Leeres Array entfernt alle. */
const setSourceTags = db.transaction((sourceId, tags) => {
  const sid = parseInt(sourceId);
  _stmtClear.run(sid);
  for (const tag of normalizeTags(tags)) _stmtInsert.run(sid, tag);
});

/** Alle Schlagworte der Bibliothek eines Users mit der Zahl ihrer Quellen,
 *  alphabetisch. */
function listPoolTags(ownerEmail) {
  return _stmtPoolTags.all(ownerEmail)
    .sort((a, b) => a.tag.localeCompare(b.tag, 'de', { sensitivity: 'base' }));
}

module.exports = { setSourceTags, listPoolTags };
