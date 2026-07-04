'use strict';
// Pure Last-Write-Wins-Klassifikation fuer den Blog-Pull. Vergleicht den WP-
// Modified-Stamp gegen den zuletzt gepullten Stand und den lokalen Seiten-Edit.
// Ausgelagert als reine Funktion, damit die vier Faelle ohne Job-/DB-Kontext
// testbar sind (tests/unit/blog-merge.test.mjs).

// Lexikografischer Vergleich zweier ISO-8601-Stamps (beide Z-suffixed, gleiche
// Laenge → String-Vergleich == Zeitvergleich). Leeres/fehlendes a nie neuer;
// fehlendes b immer aelter als ein vorhandenes a.
function newer(a, b) {
  if (!a) return false;
  if (!b) return true;
  return String(a) > String(b);
}

// Liefert die Pull-Aktion fuer einen WP-Post:
//  - 'create'   : kein Link -> neue Page anlegen
//  - 'update'   : WP neuer als der Link-Stand, App lokal unveraendert -> WP → App
//  - 'conflict' : beide Seiten seit dem letzten Pull veraendert -> User loest via Diff
//  - 'skip'     : App neuer (gehoert in den Push) oder beide unveraendert
function classifyPull({ hasLink, wpModifiedAt, linkModifiedAt, pageUpdatedAt, lastPulledAt }) {
  if (!hasLink) return 'create';
  const wpHasNew = newer(wpModifiedAt, linkModifiedAt);
  const appHasLocalEdit = newer(pageUpdatedAt, lastPulledAt);
  if (wpHasNew && appHasLocalEdit) return 'conflict';
  if (wpHasNew && !appHasLocalEdit) return 'update';
  return 'skip';
}

module.exports = { newer, classifyPull };
