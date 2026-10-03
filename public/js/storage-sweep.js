// Räumt localStorage-Einträge ab, deren Bezug verschwunden ist. Ohne das
// wächst der Speicher monoton: jede Seite, auf der je ein Lektorat lief, jedes
// gelöschte Buch hinterlässt Merker, die nie mehr gelesen werden — und der
// Platz fehlt dann den Offline-Entwürfen (editor/draft-storage.js), bei denen
// ein Quota-Fehler echter Datenverlust ist.
//
// Zwei Achsen, beide nur mit einer frischen, vollständigen Server-Antwort als
// Grundlage (fehlt sie, wird nichts entfernt):
//   - Job-Merker (`*_job_*` mit UUID-Wert): Reconnect-Anker laufender Jobs.
//     Steht der Job nicht mehr in `GET /jobs/queue`, ist er fertig/weg.
//   - Buch-Prefs (`sw:<bereich>:<email>:<bookId>…`): Ansichtsstand pro Buch.
//     Ist das Buch nicht mehr in der Buchliste des Users, ist es gelöscht oder
//     nicht mehr freigegeben.
// Entwürfe fasst dieser Sweep nie an.
import { lsGet, lsKeys, lsRemove } from './safe-storage.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_KEY_RE = /^[a-z][\w-]*_job_/;

// Buch-Prefs mit Konto im Schlüssel: `sw:<bereich>:<email>:<bookId>[:…]`.
const BOOK_AREAS_WITH_EMAIL = ['lastPage', 'filters', 'treeOpen', 'diaryAnniversaryOpen', 'plotActsCollapsed'];
// Buch-Prefs ohne Konto: `sw:<bereich>:<bookId>`.
const BOOK_PREFIXES_NO_EMAIL = ['sw:snapshotDrift:dismissed:'];

// entries: [[key, value], …]. Liefert die Schlüssel verwaister Job-Merker.
export function findStaleJobKeys(entries, activeJobIds) {
  const active = new Set(activeJobIds.map(String));
  const out = [];
  for (const [key, value] of entries) {
    if (!JOB_KEY_RE.test(key) || !UUID_RE.test(value || '')) continue;
    if (!active.has(value)) out.push(key);
  }
  return out;
}

function bookIdAfter(key, prefix) {
  if (!key.startsWith(prefix)) return null;
  const rest = key.slice(prefix.length);
  const id = rest.split(':', 1)[0];
  return /^\d+$/.test(id) ? id : null;
}

// Liefert die Schlüssel von Buch-Prefs, deren Buch nicht in `liveBookIds` ist.
// Nur die Prefs von `email` — ein zweites Konto im selben Browser hat eine
// andere Buchliste und wird hier nicht beurteilt.
export function findOrphanBookKeys(keys, email, liveBookIds) {
  const live = new Set(liveBookIds.map(String));
  const prefixes = [
    ...BOOK_AREAS_WITH_EMAIL.map(a => `sw:${a}:${email || ''}:`),
    ...BOOK_PREFIXES_NO_EMAIL,
  ];
  const out = [];
  for (const key of keys) {
    for (const p of prefixes) {
      const id = bookIdAfter(key, p);
      if (id && !live.has(id)) { out.push(key); break; }
    }
  }
  return out;
}

// Snapshot vor dem Request, Abgleich danach: ein Merker, der währenddessen
// neu geschrieben wurde (Job gerade gestartet), hat einen anderen Wert und
// bleibt stehen.
export async function sweepStaleJobKeys(fetchQueue) {
  const before = lsKeys('').filter(k => JOB_KEY_RE.test(k)).map(k => [k, lsGet(k)]);
  if (!before.length) return 0;
  let queue;
  try { queue = await fetchQueue(); } catch { return 0; }
  if (!Array.isArray(queue)) return 0;
  const stale = findStaleJobKeys(before, queue.map(j => j?.id).filter(Boolean));
  const snap = new Map(before);
  let n = 0;
  for (const key of stale) {
    if (lsGet(key) !== snap.get(key)) continue;
    lsRemove(key);
    n++;
  }
  return n;
}

// Eine leere Liste ist kein Beleg (Fehlpfad, frisches Konto) — dann nichts tun.
export function sweepOrphanBookKeys(email, books) {
  if (!email || !Array.isArray(books) || !books.length) return 0;
  const orphans = findOrphanBookKeys(lsKeys('sw:'), email, books.map(b => b?.id).filter(id => id != null));
  for (const key of orphans) lsRemove(key);
  return orphans.length;
}
