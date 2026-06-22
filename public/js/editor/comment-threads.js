// Pure Thread-Gruppierung für Share-Link-Kommentare. Bewusst ohne Browser-/
// Modul-Abhängigkeiten, damit die Logik in Node unit-testbar ist.

// Rohzeilen (Root + Antworten gemischt) zu Threads gruppieren. Antworten nach
// Zeit aufsteigend. Reihenfolge der Roots bleibt wie geliefert — der Aufrufer
// sortiert on-page nach Dokumentposition.
export function groupThreads(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const repliesByParent = {};
  for (const c of list) {
    if (c.parent_id) (repliesByParent[c.parent_id] = repliesByParent[c.parent_id] || []).push(c);
  }
  return list
    .filter(c => !c.parent_id)
    .map(root => ({
      root,
      replies: (repliesByParent[root.id] || [])
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
    }));
}
