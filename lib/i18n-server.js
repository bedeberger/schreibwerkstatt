'use strict';
// Server-seitiger i18n-Resolver für `__i18n:KEY__`-Marker. Liest die Locale-
// Dateien aus `public/js/i18n/{de,en}.json` einmalig und cached. Kein Param-
// Interpolations-Support — wird hier nicht gebraucht (Marker stehen für
// statische Labels, dynamische Werte landen separat im Prompt).

const fs = require('fs');
const path = require('path');

const I18N_DIR = path.join(__dirname, '..', 'public', 'js', 'i18n');
const FALLBACK = 'de';
const _cache = Object.create(null);

function _load(locale) {
  if (_cache[locale]) return _cache[locale];
  try {
    const raw = fs.readFileSync(path.join(I18N_DIR, `${locale}.json`), 'utf8');
    _cache[locale] = JSON.parse(raw);
  } catch {
    _cache[locale] = {};
  }
  return _cache[locale];
}

function _normalize(locale) {
  if (!locale) return FALLBACK;
  const head = String(locale).split('-')[0].toLowerCase();
  return head === 'en' ? 'en' : 'de';
}

/** Übersetzt einen einzelnen Key. Fällt auf DE zurück, dann auf den Key selbst. */
function tServer(key, locale) {
  const loc = _normalize(locale);
  const dict = _load(loc);
  if (dict[key]) return dict[key];
  if (loc !== FALLBACK) {
    const fb = _load(FALLBACK);
    if (fb[key]) return fb[key];
  }
  return key;
}

/** Ersetzt alle `__i18n:KEY__`-Marker in einem String. */
function resolveI18n(text, locale) {
  if (typeof text !== 'string' || !text.includes('__i18n:')) return text;
  return text.replace(/__i18n:([a-zA-Z0-9._-]+)__/g, (_, key) => tServer(key, locale));
}

/** Deep-Walker: kopiert {data,...}-Mindmap-Struktur und ersetzt `topic`-Marker. */
function resolveI18nTree(node, locale) {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(n => resolveI18nTree(n, locale));
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') out[k] = resolveI18n(v, locale);
    else if (v && typeof v === 'object') out[k] = resolveI18nTree(v, locale);
    else out[k] = v;
  }
  return out;
}

module.exports = { tServer, resolveI18n, resolveI18nTree };
