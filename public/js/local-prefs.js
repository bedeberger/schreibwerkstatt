// Per-User-/Per-Buch-Prefs im localStorage. Quota-tolerant (über
// safe-storage.js). Keys: `sw:<bereich>:<email>:<bookId>[:<scope>]`.
//
// Bereiche:
//   - lastBookId:<email>                   -> Rückfall-Merker fürs Startbuch
//   - lastPage:<email>:<bookId>            -> letzte geöffnete Seiten-ID
//   - filters:<email>:<bookId>:<scope>     -> Filter-Objekt pro Karten-Scope
//   - userpref:<email>:<key>               -> book-unabhängiger User-Pref (JSON)

import { lsGet as safeGet, lsSet as safeSet, lsGetJSON, lsSetJSON } from './safe-storage.js';

const PREFIX = 'sw';

// Startbuch-Rückfall. Die WAHRHEIT dazu ist serverseitig
// (`book_shelf.last_opened_at`, ein Zeitstempel pro Buch und User) — dieser
// Merker greift nur, wenn kein Buch der Liste einen Server-Zeitstempel trägt:
// erster Besuch auf diesem Gerät, oder offline geschrieben und noch nicht
// gemeldet. Er ist bewusst kein zweiter Schiedsrichter: localStorage ist
// browserweit und nicht pro Tab, konkurrierende Tabs können daran nichts
// entscheiden. Geschrieben wird er an genau denselben Stellen wie der
// Server-Zeitstempel (`_touchBookOpened`), nie beim Boot allein.
function lastBookKey(email) {
  return `${PREFIX}:lastBookId:${email || ''}`;
}

export function getLastBookId(email) {
  const raw = safeGet(lastBookKey(email));
  return raw ? String(raw) : '';
}

export function setLastBookId(email, bookId) {
  if (!bookId) return;
  safeSet(lastBookKey(email), String(bookId));
}

function lastPageKey(email, bookId) {
  return `${PREFIX}:lastPage:${email || ''}:${bookId}`;
}

function filtersKey(email, bookId, scope) {
  return `${PREFIX}:filters:${email || ''}:${bookId}:${scope}`;
}

export function getLastPageId(email, bookId) {
  if (!bookId) return null;
  const raw = safeGet(lastPageKey(email, bookId));
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

export function setLastPageId(email, bookId, pageId) {
  if (!bookId || !pageId) return;
  safeSet(lastPageKey(email, bookId), String(pageId));
}

export function getFilters(email, bookId, scope) {
  if (!bookId || !scope) return null;
  return lsGetJSON(filtersKey(email, bookId, scope));
}

export function setFilters(email, bookId, scope, filters) {
  if (!bookId || !scope) return;
  lsSetJSON(filtersKey(email, bookId, scope), filters || {});
}

// Book-unabhängiger User-Pref. Für View-Settings, die nicht pro Buch variieren
// (z.B. Chart-Metric in BookStats). JSON-serialisiert, fallback-tolerant.
function userPrefKey(email, key) {
  return `${PREFIX}:userpref:${email || ''}:${key}`;
}

export function getUserPref(email, key, fallback = null) {
  if (!key) return fallback;
  return lsGetJSON(userPrefKey(email, key), fallback);
}

export function setUserPref(email, key, value) {
  if (!key) return;
  lsSetJSON(userPrefKey(email, key), value);
}
