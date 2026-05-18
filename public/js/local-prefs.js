// Per-User-/Per-Buch-Prefs im localStorage. Quota-tolerant (alle Calls in
// try/catch). Keys: `sw:<bereich>:<email>:<bookId>[:<scope>]`.
//
// Bereiche:
//   - lastPage:<email>:<bookId>            -> letzte geöffnete Seiten-ID
//   - filters:<email>:<bookId>:<scope>     -> Filter-Objekt pro Karten-Scope

const PREFIX = 'sw';

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
function safeRemove(key) {
  try { localStorage.removeItem(key); } catch {}
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

export function clearLastPageId(email, bookId) {
  if (!bookId) return;
  safeRemove(lastPageKey(email, bookId));
}

export function getFilters(email, bookId, scope) {
  if (!bookId || !scope) return null;
  const raw = safeGet(filtersKey(email, bookId, scope));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export function setFilters(email, bookId, scope, filters) {
  if (!bookId || !scope) return;
  try {
    safeSet(filtersKey(email, bookId, scope), JSON.stringify(filters || {}));
  } catch {}
}
