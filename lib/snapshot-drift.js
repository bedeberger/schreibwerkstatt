'use strict';

// Fassungs-Drift: „lohnt sich eine neue Fassung?" — misst, wie stark der aktuelle
// Buchstand von der juengsten Fassung (book_snapshots) abweicht, ohne selbst eine
// Fassung anzulegen. Drei Achsen:
//   1) Text — Anteil des editierten Wort-Volumens (symmetrisch: 0% unveraendert,
//      ~100% Voll-Umschrieb). Fundiert per Wort-Diff je Seite (Match ueber srcId),
//      neu/entfernt zaehlen mit ihrem vollen Wort-Volumen.
//   2) Publikation — geaenderte Titelei-/Impressum-Felder (book_publication).
//   3) Buch-Einstellungen — Buchtyp, Perspektive, Ziele … (book_settings).
//
// `worthwhile` = Text-Drift >= Schwelle ODER Publikation/Einstellungen geaendert
// (genau die zwei vom Autor genannten Ausloeser).
//
// Pure — keine DB, kein Express. node:test-bar.

const { htmlToPlainText } = require('./html-text');
const { diffWords } = require('diff');

// Ab dieser Text-Drift (Anteil des editierten Wort-Volumens) gilt eine neue Fassung
// als empfehlenswert. 0.10 = „~10% aller Texte geaendert".
const TEXT_THRESHOLD = 0.10;

// Publikations-Metadaten, deren Aenderung eine neue Auflage rechtfertigt
// (Spiegel von public/js/book-snapshot-diff.js#PUB_TEXT/BOOL_FIELDS).
const PUB_TEXT_FIELDS = [
  'author_name', 'isbn', 'subtitle', 'year', 'publisher', 'series', 'series_index',
  'dedication', 'imprint', 'copyright', 'frontmatter', 'author_bio',
];
const PUB_BOOL_FIELDS = ['has_cover', 'has_author_image'];

// Buch-Einstellungen, die inhaltlich zur Fassung gehoeren (Spiegel dessen, was
// der Restore in routes/snapshots.js zurueckschreibt; ohne ACL-Feld).
const SETTINGS_FIELDS = [
  'language', 'region', 'buchtyp', 'buch_kontext', 'erzaehlperspektive',
  'erzaehlzeit', 'is_finished', 'daily_goal_chars', 'orte_real', 'schauplatz_land',
  'entities_enabled',
];

// content = buildBookJson-Format ({ book, tree:[node…] }) oder direkt das Node-Array.
// Seiten in Lesereihenfolge, Text bereits normalisiert (gleiche Quelle wie page_stats).
function _flattenPages(content) {
  const nodes = Array.isArray(content) ? content : (content && Array.isArray(content.tree) ? content.tree : []);
  const out = [];
  (function walk(list) {
    for (const node of (list || [])) {
      if (!node || typeof node !== 'object') continue;
      if (node.type === 'page') {
        out.push({
          srcId: Number.isFinite(node.srcId) ? node.srcId : null,
          text: htmlToPlainText(typeof node.html === 'string' ? node.html : ''),
        });
      } else if (node.type === 'chapter') {
        walk(node.children);
      }
    }
  })(nodes);
  return out;
}

function _wordCount(t) {
  const s = (t || '').trim();
  return s ? s.split(/\s+/).length : 0;
}

// Editiertes Wort-Volumen zwischen zwei Texten (hinzugefuegt + entfernt). Ein
// ersetztes Wort zaehlt als 1 entfernt + 1 hinzugefuegt → symmetrisch zum Nenner
// (base+cur), sodass ein Voll-Umschrieb ~100% ergibt.
function _changedWords(a, b) {
  if (a === b) return 0;
  let n = 0;
  for (const part of diffWords(a || '', b || '')) {
    if (part.added || part.removed) n += _wordCount(part.value);
  }
  return n;
}

function _pubText(v) { return v == null ? '' : String(v).trim(); }

// Geaenderte Publikations-Felder als Key-Liste.
function _changedPubFields(fromMeta, toMeta) {
  const a = fromMeta || {};
  const b = toMeta || {};
  const out = [];
  for (const key of PUB_TEXT_FIELDS) {
    if (_pubText(a[key]) !== _pubText(b[key])) out.push(key);
  }
  for (const key of PUB_BOOL_FIELDS) {
    if (!!a[key] !== !!b[key]) out.push(key);
  }
  return out;
}

// Geaenderte Einstellungs-Felder als Key-Liste (lose Gleichheit ueber String-Form,
// damit 0/„0"/null/„" nicht als Aenderung durchschlagen).
function _changedSettingsFields(fromSettings, toSettings) {
  const a = fromSettings || {};
  const b = toSettings || {};
  const norm = (v) => (v == null ? '' : String(v).trim());
  const out = [];
  for (const key of SETTINGS_FIELDS) {
    if (norm(a[key]) !== norm(b[key])) out.push(key);
  }
  return out;
}

// Kern-Berechnung. baseline/current im buildBookJson-Format; Publikations-Metas
// in getMeta-Form; Settings in getBookSettings-Form. Alles optional (null = leer).
function computeDrift({
  baselineContent, currentContent,
  baselinePubMeta = null, currentPubMeta = null,
  baselineSettings = null, currentSettings = null,
  threshold = TEXT_THRESHOLD,
} = {}) {
  const basePages = _flattenPages(baselineContent);
  const curPages = _flattenPages(currentContent);

  const baseById = new Map();
  for (const p of basePages) if (p.srcId != null) baseById.set(p.srcId, p);
  const curById = new Map();
  for (const p of curPages) if (p.srcId != null) curById.set(p.srcId, p);

  let changedWords = 0;
  let denomWords = 0;
  let changedPages = 0;
  let addedPages = 0;
  let removedPages = 0;
  let unchangedPages = 0;

  // Aktuelle Seiten durchgehen: bekannt (Match) oder neu.
  for (const cp of curPages) {
    const bp = cp.srcId != null ? baseById.get(cp.srcId) : null;
    if (!bp) {
      const w = _wordCount(cp.text);
      changedWords += w; denomWords += w; addedPages += 1;
      continue;
    }
    const bw = _wordCount(bp.text);
    const cw = _wordCount(cp.text);
    denomWords += bw + cw;
    if (bp.text === cp.text) { unchangedPages += 1; continue; }
    changedWords += _changedWords(bp.text, cp.text);
    changedPages += 1;
  }
  // Seit der Fassung entfernte Seiten (in baseline, nicht mehr aktuell). srcId-lose
  // baseline-Seiten (Legacy/Defekt) sind positionsfrei → als entfernt gewertet.
  for (const bp of basePages) {
    if (bp.srcId != null && curById.has(bp.srcId)) continue;
    const w = _wordCount(bp.text);
    changedWords += w; denomWords += w; removedPages += 1;
  }

  const changeRatio = denomWords > 0 ? changedWords / denomWords : 0;

  const publicationFields = _changedPubFields(baselinePubMeta, currentPubMeta);
  const settingsFields = _changedSettingsFields(baselineSettings, currentSettings);
  const publicationChanged = publicationFields.length > 0;
  const settingsChanged = settingsFields.length > 0;

  const worthwhile = changeRatio >= threshold || publicationChanged || settingsChanged;

  return {
    thresholdPct: Math.round(threshold * 100),
    worthwhile,
    text: {
      changeRatio,
      changePct: Math.round(changeRatio * 100),
      changedWords,
      totalWords: denomWords,
      changedPages,
      addedPages,
      removedPages,
      unchangedPages,
    },
    publicationChanged,
    publicationFields,
    settingsChanged,
    settingsFields,
  };
}

module.exports = {
  computeDrift,
  TEXT_THRESHOLD,
  PUB_TEXT_FIELDS,
  PUB_BOOL_FIELDS,
  SETTINGS_FIELDS,
  // fuer Tests:
  _flattenPages,
  _changedWords,
};
