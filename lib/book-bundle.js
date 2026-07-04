'use strict';

// Pure Builder/Parser/Validator fuer das `.swbook`-Migrationsformat (Buch
// zwischen App-Instanzen zuegeln). Kein Express, keine DB — nur Datenformung,
// damit Round-Trip + Validierung ohne Harness testbar bleiben.
//
// Bundle (ZIP):
//   manifest.json  { format, version, exportedAt, sourceBookId, appVersion, includes }
//   book.json      { book:{ name, description, settings }, tree:[ node… ] }
//   analysis.json  (optional) Komplettanalyse-Entities (Figuren/Orte/Szenen/…)
//   lektorat.json  (optional) gespeicherte Seiten-Checks (page_checks)
//   chats.json     (optional) Chat-Sessions + Nachrichten
// node = { type:'chapter', name, srcId, children:[node…] }
//      | { type:'page', name, html, srcId, images?:[{oldId,mime,width,height,b64}] }
// `srcId` = Quell-Page-/Chapter-ID; der Import baut daraus die ID-Remap-Maps,
// damit die optionalen Extra-Dateien ihre page_id/chapter_id-Referenzen
// umschreiben koennen. `images` traegt die im Seiten-HTML referenzierten
// Manuskript-Bild-BLOBs (base64) mit, damit sie bei Restore/Migration mitwandern
// (die /content/page-image/:id-Refs werden beim Anlegen auf neue IDs umgeschrieben).
// Reihenfolge = Array-Order. Hierarchie = Nesting (max Tiefe 3, wie chapters).

const FORMAT = 'schreibwerkstatt-book';
const VERSION = 2; // v2: srcId auf Nodes + manifest.includes + optionale Extra-Dateien
const MAX_DEPTH = 3; // chapters sind selbst auf 3 Ebenen begrenzt
const EXTRA_KEYS = ['analysis', 'lektorat', 'chats'];

function _err(code, msg) {
  const e = new Error(msg || code);
  e.code = code;
  return e;
}

// ── Export ────────────────────────────────────────────────────────────────────

function buildManifest({ sourceBookId, exportedAt, appVersion = null, includes = null }) {
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: exportedAt || null,
    sourceBookId: sourceBookId ?? null,
    appVersion,
    includes: normalizeIncludes(includes),
  };
}

// Welche optionalen Extra-Dateien das Bundle enthaelt. Tolerant: fehlend/falsch
// → alles false. Aus beliebigem Input (z.B. manifest.includes) lesbar.
function normalizeIncludes(src) {
  const out = {};
  for (const k of EXTRA_KEYS) out[k] = !!(src && src[k]);
  return out;
}

// bookTree-Output (lib/content-store) + html-Map (pageId -> html) -> node-Tree.
// chapters[] = Top-Level; jedes Kapitel hat pages[] (Meta) + subchapters[].
// topPages[] = kapitellose Top-Level-Seiten. Reihenfolge wird 1:1 uebernommen.
function treeToNodes(bookTree, htmlById, imagesByPage) {
  const nodes = [];
  // bookTree liefert chapters + topPages getrennt; die book_order-Reihenfolge
  // ist innerhalb beider Listen korrekt, aber Interleaving (Page zwischen zwei
  // Top-Level-Kapiteln) geht hier verloren — Top-Pages werden vorangestellt.
  // Fuer Migration unkritisch: Struktur + Inhalt bleiben vollstaendig.
  for (const p of (bookTree.topPages || [])) {
    nodes.push(_pageNode(p, htmlById, imagesByPage));
  }
  for (const c of (bookTree.chapters || [])) {
    nodes.push(_chapterNode(c, htmlById, imagesByPage));
  }
  return nodes;
}

function _chapterNode(ch, htmlById, imagesByPage) {
  const children = [];
  for (const p of (ch.pages || [])) children.push(_pageNode(p, htmlById, imagesByPage));
  for (const sub of (ch.subchapters || [])) children.push(_chapterNode(sub, htmlById, imagesByPage));
  return {
    type: 'chapter',
    name: ch.name || '',
    srcId: ch.id ?? null,
    children,
  };
}

function _pageNode(p, htmlById, imagesByPage) {
  const node = {
    type: 'page',
    name: p.name || '',
    html: (htmlById && htmlById.get(p.id)) || '',
    srcId: p.id ?? null,
  };
  const images = imagesByPage && imagesByPage.get(p.id);
  if (Array.isArray(images) && images.length) node.images = images;
  return node;
}

function buildBookJson({ book, settings, nodes }) {
  return {
    book: {
      name: book?.name || '',
      description: book?.description || '',
      settings: settings ? _cleanSettings(settings) : null,
    },
    tree: Array.isArray(nodes) ? nodes : [],
  };
}

// Nur authored Konfig; instanzspezifisches (allow_lektor_book_chat) wird beim
// Import ohnehin zurueckgesetzt, hier aber unschaedlich mitgeschrieben.
const _SETTINGS_KEYS = [
  'language', 'region', 'buchtyp', 'buch_kontext', 'erzaehlperspektive',
  'erzaehlzeit', 'is_finished', 'daily_goal_chars', 'orte_real',
  'schauplatz_land', 'entities_enabled',
];
function _cleanSettings(s) {
  const out = {};
  for (const k of _SETTINGS_KEYS) if (s[k] !== undefined) out[k] = s[k];
  return out;
}

// ── Import ──────────────────────────────────────────────────────────────────

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw _err('BAD_MANIFEST', 'manifest missing');
  if (manifest.format !== FORMAT) throw _err('BAD_MANIFEST', `unexpected format ${manifest.format}`);
  if (!Number.isInteger(manifest.version) || manifest.version < 1) throw _err('BAD_MANIFEST', 'bad version');
  if (manifest.version > VERSION) throw _err('UNSUPPORTED_VERSION', `bundle version ${manifest.version} > ${VERSION}`);
  return true;
}

function validateBookJson(bookJson) {
  if (!bookJson || typeof bookJson !== 'object') throw _err('SWBOOK_EMPTY', 'book.json missing');
  if (!bookJson.book || typeof bookJson.book.name !== 'string' || !bookJson.book.name.trim()) {
    throw _err('SWBOOK_EMPTY', 'book.name missing');
  }
  if (!Array.isArray(bookJson.tree) || !bookJson.tree.length) throw _err('SWBOOK_EMPTY', 'tree empty');
  return true;
}

// Flacht den node-Tree in eine geordnete Op-Liste fuer den Import-Worker aus.
// Pure — keine DB. Kapitel bekommen fortlaufende tempIds; Pages referenzieren
// ihr Parent-Kapitel via parentTempId (null = Top-Level).
//   ops: [{ op:'chapter', tempId, parentTempId, name, srcId },
//         { op:'page', parentTempId, name, html, srcId }]
// `srcId` reicht die Quell-ID durch, damit der Import-Worker beim Anlegen die
// Remap-Maps (srcPageId/srcChapterId → neue ID) fuer die Extra-Dateien fuellen
// kann (null, wenn das Bundle keine srcIds traegt, z.B. v1-Altbestand).
// Tiefe > MAX_DEPTH wird gekappt: tiefere Kapitel werden nicht angelegt, ihre
// Pages haengen am letzten erlaubten Vorfahr. `cappedChapters` zaehlt das.
function planFromNodes(nodes) {
  const ops = [];
  let tempSeq = 0;
  let cappedChapters = 0;

  function walk(list, parentTempId, depth) {
    for (const n of (list || [])) {
      if (!n || typeof n !== 'object') continue;
      if (n.type === 'page') {
        ops.push({
          op: 'page',
          parentTempId,
          name: typeof n.name === 'string' ? n.name : '',
          html: typeof n.html === 'string' ? n.html : '',
          srcId: Number.isFinite(n.srcId) ? n.srcId : null,
          images: Array.isArray(n.images) ? n.images : [],
        });
      } else if (n.type === 'chapter') {
        if (depth > MAX_DEPTH) {
          // Kapitel kappen: Inhalt am aktuellen Parent weiterfuehren.
          cappedChapters += 1;
          walk(n.children, parentTempId, depth); // Pages landen am Parent
          continue;
        }
        const tempId = tempSeq++;
        ops.push({
          op: 'chapter',
          tempId,
          parentTempId,
          name: typeof n.name === 'string' ? n.name : '',
          srcId: Number.isFinite(n.srcId) ? n.srcId : null,
        });
        walk(n.children, tempId, depth + 1);
      }
    }
  }
  walk(nodes, null, 1);
  return { ops, cappedChapters };
}

module.exports = {
  FORMAT, VERSION, MAX_DEPTH, EXTRA_KEYS,
  buildManifest, normalizeIncludes, treeToNodes, buildBookJson,
  validateManifest, validateBookJson, planFromNodes,
};
