'use strict';
// Slug-Generierung fuer book_categories.
// Stabile URL-/Suchschluessel pro Name.
//
// `slugify(name)`: lowercase + ASCII-Folding (Umlaute, Diakritika) + spaces
// und Sonderzeichen weg + multi-dash collapse + Trim 64 Zeichen.
// `uniqueSlug(base, exists)`: vergibt `-2`, `-3`, … bei Konflikt.

const UMLAUT_MAP = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };

function slugify(name) {
  if (typeof name !== 'string') return '';
  let s = name.toLowerCase();
  s = s.replace(/[äöüß]/g, ch => UMLAUT_MAP[ch] || ch);
  s = s.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/[^a-z0-9-]/g, '');
  s = s.replace(/-+/g, '-');
  s = s.replace(/^-+|-+$/g, '');
  return s.slice(0, 64);
}

// `exists(slug)` → true wenn DB-Konflikt. Liefert finalen Slug zurueck.
function uniqueSlug(base, exists) {
  const root = base || 'item';
  if (!exists(root)) return root;
  for (let n = 2; n < 10000; n++) {
    const candidate = `${root}-${n}`.slice(0, 64);
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`uniqueSlug: kein freier Slug fuer "${base}" gefunden`);
}

module.exports = { slugify, uniqueSlug };
