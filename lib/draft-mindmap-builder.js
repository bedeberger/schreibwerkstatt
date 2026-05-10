'use strict';
// Pure Function: figures-Row + Detail-Daten → jsMind-Mindmap.
// Wiederverwendet die Default-Struktur aus routes/draft-figures.js#defaultMindmap;
// füllt vorhandene Felder als Sub-Knoten der passenden Default-Container.
// Leere Felder fallen weg (Knoten behält i18n-Marker → Frontend rendert ihn
// als leerer Default). User entwickelt im Editor weiter.

const { defaultMindmap } = require('../routes/draft-figures.js');

function _newId(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}

function _kvNode(prefix, key, label, value) {
  if (!value || !String(value).trim()) return null;
  return { id: _newId(prefix), topic: `${label}: ${String(value).trim()}` };
}

function _findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children || []) {
    const f = _findNode(c, id);
    if (f) return f;
  }
  return null;
}

function _ensureChildren(node) {
  if (!Array.isArray(node.children)) node.children = [];
  return node.children;
}

/** Baut eine Mindmap aus einer figures-Row + Tags + Relations.
 *  fig: { name, kurzname, typ, geburtstag, geschlecht, beruf, wohnadresse,
 *         beschreibung, sozialschicht, praesenz, rolle, motivation, konflikt,
 *         entwicklung, tags?: [string], relationsOut?: [...], relationsIn?: [...] }
 *  Beziehungs-Items: { typ, beschreibung, partner_name }.
 *  Labels: locale-neutral (DE-Default-Beschriftungen). Werkstatt-Frontend
 *  rendert sie 1:1; eine Zukunfts-Lokalisierung passiert hier nicht — der
 *  Aufrufer ist ohnehin per User-Locale serverseitig adressiert. */
function buildMindmapFromFigure(fig) {
  const root = defaultMindmap(fig.name || 'Figur');
  const data = root.data;

  // Steckbrief
  const steckbrief = _findNode(data, 'steckbrief');
  const aussehen = _findNode(data, 'aussehen');
  const hintergrund = _findNode(data, 'hintergrund');
  const beziehungen = _findNode(data, 'beziehungen');
  const konflikt = _findNode(data, 'konflikt');
  const bogen = _findNode(data, 'bogen');
  const persoenlichkeit = _findNode(data, 'persoenlichkeit');

  // Aussehen ← beschreibung (oft die längere narrative Notiz aus Komplettanalyse)
  if (aussehen && fig.beschreibung && fig.beschreibung.trim()) {
    _ensureChildren(aussehen).push({
      id: _newId('aussehen-desc'),
      topic: fig.beschreibung.trim().slice(0, 280),
    });
  }

  // Hintergrund ← Stammdaten
  if (hintergrund) {
    const kids = _ensureChildren(hintergrund);
    const candidates = [
      _kvNode('hintergrund', 'kurzname', 'Kurzname', fig.kurzname),
      _kvNode('hintergrund', 'geschlecht', 'Geschlecht', fig.geschlecht),
      _kvNode('hintergrund', 'geburtstag', 'Geburtstag', fig.geburtstag),
      _kvNode('hintergrund', 'beruf', 'Beruf', fig.beruf),
      _kvNode('hintergrund', 'wohnadresse', 'Wohnort', fig.wohnadresse),
      _kvNode('hintergrund', 'sozial', 'Sozialschicht', fig.sozialschicht),
      _kvNode('hintergrund', 'rolle', 'Rolle', fig.rolle),
      _kvNode('hintergrund', 'praesenz', 'Präsenz', fig.praesenz),
    ].filter(Boolean);
    kids.push(...candidates);
  }

  // Beziehungen ← figure_relations (out + in, dedupe per partner+typ)
  if (beziehungen) {
    const kids = _ensureChildren(beziehungen);
    const seen = new Set();
    const all = [
      ...(fig.relationsOut || []).map(r => ({ ...r, dir: 'out' })),
      ...(fig.relationsIn  || []).map(r => ({ ...r, dir: 'in'  })),
    ];
    for (const r of all) {
      if (!r.partner_name || !r.typ) continue;
      const key = `${r.dir}|${r.typ}|${r.partner_name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const beschr = (r.beschreibung || '').trim();
      const topic = beschr
        ? `${r.typ} → ${r.partner_name}: ${beschr.slice(0, 140)}`
        : `${r.typ} → ${r.partner_name}`;
      kids.push({ id: _newId('beziehung'), topic });
    }
  }

  // Konflikt ← konflikt
  if (konflikt && fig.konflikt && fig.konflikt.trim()) {
    _ensureChildren(konflikt).push({
      id: _newId('konflikt-desc'),
      topic: fig.konflikt.trim().slice(0, 280),
    });
  }

  // Bogen ← entwicklung
  if (bogen && fig.entwicklung && fig.entwicklung.trim()) {
    _ensureChildren(bogen).push({
      id: _newId('bogen-desc'),
      topic: fig.entwicklung.trim().slice(0, 280),
    });
  }

  // Persönlichkeit ← Tags (kompakte Liste)
  if (persoenlichkeit && Array.isArray(fig.tags) && fig.tags.length) {
    const kids = _ensureChildren(persoenlichkeit);
    for (const tag of fig.tags) {
      if (!tag || !String(tag).trim()) continue;
      kids.push({ id: _newId('eig'), topic: String(tag).trim() });
    }
  }

  // Subtext > Want ← motivation
  const want = _findNode(data, 'want');
  if (want && fig.motivation && fig.motivation.trim()) {
    _ensureChildren(want).push({
      id: _newId('want-desc'),
      topic: fig.motivation.trim().slice(0, 280),
    });
  }

  return root;
}

/** Mappt figures.typ auf Werkstatt-Archetype (whitelist).
 *  figures.typ ist Freitext aus KI-Extraktion; mappen nur, wenn klare Übereinstimmung. */
function mapArchetype(typ) {
  if (!typ) return null;
  const norm = String(typ).toLowerCase().trim();
  if (norm.includes('protagonist')) return 'protagonist';
  if (norm.includes('antagonist')) return 'antagonist';
  if (norm.includes('mentor')) return 'mentor';
  if (norm.includes('nemesis')) return 'nemesis';
  if (norm.includes('neben')) return 'nebenfigur';
  return null;
}

module.exports = { buildMindmapFromFigure, mapArchetype };
