// Geteilte Konstanten der Ideen — von der Ideen-Karte (Seite/Kapitel) UND dem
// Ideen-Board benutzt, damit die beiden Oberflaechen nicht zwei Vorstellungen
// derselben Achse pflegen.
//
// Spiegel der Server-SSoT lib/ideen-status.js. Der Vertrag (gleiche Keys,
// gleiche Reihenfolge) ist durch tests/unit/ideen-status.test.mjs gegated. Ein
// Status-Key ist eine Persistenz-Konstante (Spaltenwert + CHECK + i18n-Key
// `ideen.status.<key>`): ergaenzen ja, umbenennen nein.

export const IDEE_STATUSES = ['offen', 'in_arbeit', 'erledigt', 'verworfen'];

// Die Stufen, die eine Pendenz noch OFFEN halten. Sie entscheiden ueber die
// Sidebar-Plakette und die Zaehler — `verworfen` gehoert nicht dazu.
export const IDEE_OPEN_STATUSES = ['offen', 'in_arbeit'];

// Verknuepfungs-Ziele einer Idee (`idea_links.target_kind`), Reihenfolge =
// Anzeige in Picker und Chips.
export const IDEA_LINK_KINDS = ['research', 'beat', 'motif'];

// Unbekannter/leerer Wert zaehlt als erste Stufe — dieselbe Regel wie
// `itemStatus` im Recherche-Board: eine Idee faellt nie aus dem Board, nur weil
// ihr Status nicht in der Liste steht.
export function ideeStatus(idee) {
  const s = idee?.status;
  return IDEE_STATUSES.includes(s) ? s : IDEE_STATUSES[0];
}

export function isOpenIdee(idee) {
  return IDEE_OPEN_STATUSES.includes(ideeStatus(idee));
}

// Der Anker einer Idee als Bahn-Schluessel. Genau EIN Anker ist gesetzt
// (XOR-CHECK im Schema); ohne Anker gaebe es die Zeile nicht.
export function ideeLaneKey(idee) {
  if (!idee) return '';
  return idee.page_id != null ? `page:${idee.page_id}` : `chapter:${idee.chapter_id}`;
}
