'use strict';
// Pure: extrahiert die psychologischen Kerne einer Figuren-Werkstatt-Mindmap
// (Subtext + Bogen + Konflikt) für den Cross-Feature-Kontext der Plot-KI-Jobs.
// Liest die stabilen Default-Container-IDs (steckbrief>bogen, steckbrief>konflikt,
// subtext>want/need/wound/lie — siehe routes/draft-figures.js#defaultMindmap), die
// über Import + Default-Anlage erhalten bleiben (der User hängt Kinder an, ersetzt
// die Container nicht). User-Kinder tragen Klartext-Topics (keine i18n-Marker) →
// kein Locale-Resolve nötig.

function _find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children || []) {
    const f = _find(c, id);
    if (f) return f;
  }
  return null;
}

function _childTopics(node) {
  if (!node || !Array.isArray(node.children)) return [];
  return node.children
    .map(c => (c && typeof c.topic === 'string' ? c.topic.trim() : ''))
    .filter(Boolean);
}

// → { bogen:[…], konflikt:[…], want:[…], need:[…], wound:[…], lie:[…] } oder null,
// wenn nichts ausgearbeitet ist (alle Container leer / keine Mindmap).
function extractPsychologie(mindmap) {
  const data = mindmap && mindmap.data;
  if (!data) return null;
  const out = {
    bogen:    _childTopics(_find(data, 'bogen')),
    konflikt: _childTopics(_find(data, 'konflikt')),
    want:     _childTopics(_find(data, 'want')),
    need:     _childTopics(_find(data, 'need')),
    wound:    _childTopics(_find(data, 'wound')),
    lie:      _childTopics(_find(data, 'lie')),
  };
  const any = Object.values(out).some(arr => arr.length);
  return any ? out : null;
}

// Hat die Figur einen ausgearbeiteten Bogen ODER Subtext (≥1 Kind unter bogen/
// want/need/wound/lie)? Für die Cross-Coverage „geplante Figur ohne geplante Tiefe".
function hasDevelopedArc(mindmap) {
  const p = extractPsychologie(mindmap);
  if (!p) return false;
  return (p.bogen.length + p.want.length + p.need.length + p.wound.length + p.lie.length) > 0;
}

module.exports = { extractPsychologie, hasDevelopedArc };
