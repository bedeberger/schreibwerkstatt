// Konstanten + Helper für Figurengraph/Familie/Soziogramm.
// Wird von allen Render-Pfaden geteilt.

export const DEFAULT_FONT = { size: 13, face: 'system-ui, -apple-system, sans-serif' };

// Node-Label aus einer Figur: Kurzname + optionales Geburtsdatum in zweiter Zeile.
export const nodeLabel = f => (f.kurzname || f.name) + (f.geburtstag ? '\n* ' + f.geburtstag : '');

// ── Sozialschicht-Palette (Schweiz, Mittelland, 1990er–2010er) ───────────────
export const SCHICHT_COLOR = {
  wirtschaftselite:    { background: '#FFF3CC', border: '#A07800', highlight: { background: '#FFE566', border: '#7A5A00' } },
  gehobenes_buergertum:{ background: '#D4E8FF', border: '#2d6a9f', highlight: { background: '#BDD8FF', border: '#1d4b73' } },
  mittelschicht:       { background: '#E8F4E8', border: '#3a7a3a', highlight: { background: '#D0EBD0', border: '#275927' } },
  arbeiterschicht:     { background: '#F5EAD4', border: '#8B5E26', highlight: { background: '#EDD9A8', border: '#6B3F0D' } },
  migrantenmilieu:     { background: '#FDEBD0', border: '#C0602A', highlight: { background: '#FAD5A8', border: '#9A4010' } },
  prekariat:           { background: '#F5EDED', border: '#8B3A3A', highlight: { background: '#EDD5D5', border: '#6B1A1A' } },
  unterwelt:           { background: '#3A3A3A', border: '#111',    highlight: { background: '#505050', border: '#000' },
                         font: { ...DEFAULT_FONT, color: '#fff' } },
  andere:              { background: '#FFF5DC', border: '#c4a55a', highlight: { background: '#FFEEBB', border: '#8a6a20' } },
};

// Vertikale Ebene pro Schicht (0 = oben)
export const SCHICHT_LEVEL = {
  wirtschaftselite:    0,
  gehobenes_buergertum:1,
  mittelschicht:       2,
  arbeiterschicht:     3,
  migrantenmilieu:     4,
  prekariat:           5,
  unterwelt:           6,
  andere:              2,
};

// ── Beziehungstyp-Styling (Figurengraph) ─────────────────────────────────────
export const BZ = {
  elternteil:      { color: '#888',    highlight: '#555',    arrows: 'to',   dashes: false },
  kind:            { color: '#888',    highlight: '#555',    arrows: 'from', dashes: false },
  geschwister:     { color: '#2d6a9f', highlight: '#1d4b73', arrows: '',     dashes: [5,5] },
  freund:          { color: '#639922', highlight: '#3B6D11', arrows: '',     dashes: [4,3] },
  feind:           { color: '#E24B4A', highlight: '#B03030', arrows: '',     dashes: [4,3] },
  kollege:         { color: '#c4a55a', highlight: '#8a6a20', arrows: '',     dashes: [4,3] },
  bekannt:         { color: '#999',    highlight: '#555',    arrows: '',     dashes: [4,3] },
  liebesbeziehung: { color: '#D46EA0', highlight: '#A0446E', arrows: '',     dashes: [4,3] },
  rivale:          { color: '#9B4B00', highlight: '#6B3000', arrows: '',     dashes: [4,3] },
  mentor:          { color: '#2d6a9f', highlight: '#1d4b73', arrows: 'to',   dashes: [4,3] },
  schuetzling:     { color: '#2d6a9f', highlight: '#1d4b73', arrows: 'from', dashes: [4,3] },
  patronage:       { color: '#7B3FA0', highlight: '#5A1F80', arrows: 'to',   dashes: false },
  geschaeft:       { color: '#B8860B', highlight: '#7A5A00', arrows: '',     dashes: [6,3] },
  andere:          { color: '#bbb',    highlight: '#888',    arrows: '',     dashes: [4,3] },
};

// ── Beziehungskategorie-Farben (Soziogramm) ───────────────────────────────────
export const BZ_SOZIO_COLOR = {
  familie:  '#888',
  macht:    '#7B3FA0',
  konflikt: '#E24B4A',
  geschaeft:'#B8860B',
  liebe:    '#D46EA0',
  sozial:   '#639922',
};
export const BZ_SOZIO_CAT = {
  elternteil: 'familie', kind: 'familie', geschwister: 'familie',
  patronage: 'macht',  mentor: 'macht', schuetzling: 'macht',
  feind: 'konflikt', rivale: 'konflikt',
  geschaeft: 'geschaeft', kollege: 'geschaeft',
  liebesbeziehung: 'liebe',
  freund: 'sozial', bekannt: 'sozial', andere: 'sozial',
};

// Typen mit fester Pfeilrichtung im Standardgraph
export const DIRECTED_TYPES = ['elternteil', 'kind', 'mentor', 'schuetzling', 'patronage'];
