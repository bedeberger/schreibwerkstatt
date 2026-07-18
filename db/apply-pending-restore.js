'use strict';
// Boot-Swap fuer den Admin-DB-Restore. Wird von db/connection.js VOR dem Oeffnen
// der DB aufgerufen. Liegt eine hochgeladene + validierte Restore-Datei als
// `<DB_FILE>.restore-pending` vor, wird die aktuelle DB zuerst als Sicherheits-
// Snapshot weggeschrieben und dann durch die Pending-Datei ersetzt. Migrationen
// laufen danach normal (routes-agnostisch, server.js), sodass ein aelterer
// Restore vorwaerts migriert wird.
//
// Dependency-leicht (nur fs/path/better-sqlite3), damit es sicher beim Boot vor
// jedem anderen App-State laeuft. Kein Winston hier (Logger-Init noch offen) —
// bewusst console.

const fs = require('fs');
const Database = require('better-sqlite3');

const PENDING_SUFFIX = '.restore-pending';

// Konsistente Sicherheitskopie der aktuellen DB in `safetyPath`. Bevorzugt
// `VACUUM INTO` (eine kohaerente Einzeldatei); faellt bei Fehler auf ein
// File-Set-Copy (main + -wal + -shm) zurueck. Gibt true bei Erfolg zurueck.
function safetySnapshot(dbFile, safetyPath) {
  try {
    const cur = new Database(dbFile);
    try {
      try { cur.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* best effort */ }
      cur.exec(`VACUUM INTO '${safetyPath.replace(/'/g, "''")}'`);
    } finally {
      cur.close();
    }
    return true;
  } catch (e) {
    console.error(`[db-restore] VACUUM-Sicherung fehlgeschlagen (${e.message}) – versuche File-Copy.`);
    try {
      fs.copyFileSync(dbFile, safetyPath);
      for (const ext of ['-wal', '-shm']) {
        if (fs.existsSync(dbFile + ext)) fs.copyFileSync(dbFile + ext, safetyPath + ext);
      }
      return true;
    } catch (e2) {
      console.error(`[db-restore] File-Copy-Sicherung fehlgeschlagen: ${e2.message}`);
      return false;
    }
  }
}

// Wendet einen Pending-Restore an, falls vorhanden. Idempotent: ohne Pending-
// Datei No-op. Gibt { safetyPath } zurueck, wenn geswappt wurde, sonst null.
function applyPendingRestore(dbFile) {
  const pending = dbFile + PENDING_SUFFIX;
  if (!fs.existsSync(pending)) return null;

  let safetyPath = null;
  if (fs.existsSync(dbFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const candidate = `${dbFile}.pre-restore-${stamp}.sqlite`;
    if (safetySnapshot(dbFile, candidate)) safetyPath = candidate;
    else console.error('[db-restore] WARNUNG: keine Sicherheitskopie – Restore wird trotzdem angewandt (auf Wunsch des Admins).');
  }

  // Veraltete WAL/SHM der abzuloesenden DB entfernen, sonst wuerde SQLite sie
  // faelschlich auf die eingeswappte Datei anwenden und diese beschaedigen.
  for (const ext of ['-wal', '-shm']) {
    try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* best effort */ }
  }

  fs.renameSync(pending, dbFile);
  console.log(`[db-restore] Pending-Restore angewandt. Sicherheitskopie: ${safetyPath || 'KEINE'}`);
  return { safetyPath };
}

module.exports = { applyPendingRestore, PENDING_SUFFIX };
