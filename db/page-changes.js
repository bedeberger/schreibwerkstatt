'use strict';
// Collab-Feed: Seiten eines Buchs, die seit `since` von einer ANDEREN Partei
// editiert oder geloescht wurden. Einziger Konsument ist
// GET /content/books/:book_id/changes (routes/content/books.js) — der Browser
// fragt ihn im Collab-Poll, in der Baum-Drift-Probe und nach jedem Anstoss des
// Event-Streams.
//
// „Andere Partei" = anderer User ODER ein anderes EIGENES Geraet. Mit `deviceId`
// wird nur der Echo DIESES Geraets ausgefiltert: gleiche E-Mail UND (Geraet ==
// anfragendes Geraet ODER Geraet unbekannt/NULL — Server-/Job-Writes gelten
// weiter als eigener Edit). Ohne `deviceId` (Legacy-Client) faellt der Filter auf
// reine E-Mail-Exklusion zurueck.
//
// Das Geraete-Label wird nur fuer die EIGENEN Geraete des Anfragers aufgeloest
// (gleicher Join-Scope wie loadPage) — fremde Geraetenamen leaken nicht.

const { db } = require('./connection');

const LIMIT = 200;

function _selfFilter(col, deviceCol, deviceId) {
  return deviceId
    ? `AND NOT (${col} = ? AND (${deviceCol} IS NULL OR ${deviceCol} = ?))`
    : `AND (? IS NULL OR ${col} <> ?)`;
}

function listBookChanges(bookId, email, since, deviceId = null) {
  const selfArgs = deviceId ? [email, deviceId] : [email, email];

  const updates = db.prepare(`
    SELECT p.page_id, p.page_name, p.chapter_id,
           p.updated_at AS changed_at, p.last_editor_email,
           u.display_name AS last_editor_name,
           d.label        AS last_editor_device_label
      FROM pages p
      LEFT JOIN app_users         u ON u.email = p.last_editor_email
      LEFT JOIN app_users_devices d ON d.device_id = p.last_editor_device_id
                                    AND d.user_email = ?
     WHERE p.book_id = ?
       AND p.updated_at > ?
       AND p.last_editor_email IS NOT NULL
       ${_selfFilter('p.last_editor_email', 'p.last_editor_device_id', deviceId)}
     ORDER BY p.updated_at ASC
     LIMIT ${LIMIT}
  `).all(email, bookId, since, ...selfArgs);

  const deletions = db.prepare(`
    SELECT page_id, page_name, deleted_at AS changed_at, deleted_by_email AS last_editor_email,
           u.display_name AS last_editor_name,
           d.label        AS last_editor_device_label
      FROM page_deletions
      LEFT JOIN app_users         u ON u.email = deleted_by_email
      LEFT JOIN app_users_devices d ON d.device_id = page_deletions.device_id
                                    AND d.user_email = ?
     WHERE book_id = ?
       AND deleted_at > ?
       ${_selfFilter('deleted_by_email', 'page_deletions.device_id', deviceId)}
     ORDER BY deleted_at ASC
     LIMIT ${LIMIT}
  `).all(email, bookId, since, ...selfArgs);

  // Gleicher Zeitpunkt: Update vor Delete, damit der Client eine Seite nicht
  // erst entfernt und dann wieder als geaendert markiert.
  return [
    ...updates.map(r => ({ ...r, kind: 'update' })),
    ...deletions.map(r => ({ ...r, kind: 'delete' })),
  ].sort((a, b) => {
    const at = a.changed_at || '';
    const bt = b.changed_at || '';
    if (at !== bt) return at.localeCompare(bt);
    return (a.kind === 'delete' ? 1 : 0) - (b.kind === 'delete' ? 1 : 0);
  }).slice(0, LIMIT);
}

module.exports = { listBookChanges };
