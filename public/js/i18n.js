// Leichtgewichtiges i18n ohne Dependencies.
//
// Ablauf:
//   1. configureI18n(locale) lädt de.json als Fallback + die Ziel-Locale.
//   2. Alpine-Methoden (i18nMethods) liefern `t()` reaktiv über `this.$store.shell.uiLocale`.
//   3. changeLocale(loc) lädt neu + persistiert via PATCH /me/settings.
//
// Key-Konvention: 'bereich.feld' (z.B. 'header.logout', 'profile.title').
// Platzhalter: {name} → Parameter-Map: t('foo', { name: 'Anna' }).

import { formatLastRun as _formatLastRunImpl } from './utils.js';

const FALLBACK_LOCALE = 'de';
const SUPPORTED_LOCALES = ['de', 'en'];

let _locale = FALLBACK_LOCALE;
let _messages = {};
let _fallback = null;

async function _load(locale) {
  const r = await fetch(`/js/i18n/${locale}.json`);
  if (!r.ok) throw new Error(`Locale ${locale} nicht verfügbar (${r.status}).`);
  return r.json();
}

/** Lädt Fallback (de) + Ziel-Locale. Idempotent – kann mehrfach aufgerufen werden. */
export async function configureI18n(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) locale = FALLBACK_LOCALE;
  if (!_fallback) _fallback = await _load(FALLBACK_LOCALE);
  _locale = locale;
  if (locale === FALLBACK_LOCALE) {
    _messages = _fallback;
  } else {
    try { _messages = await _load(locale); }
    catch (e) { console.error('[i18n]', e.message, '– Fallback auf de.'); _messages = _fallback; }
  }
}

/** Aktuell aktive Locale. */
export function getLocale() { return _locale; }

/** Liste der unterstützten Locales. */
export function getSupportedLocales() { return SUPPORTED_LOCALES.slice(); }

/** Übersetzt einen Key. Fallback: de-Wert; letzter Fallback: der Key selbst (sichtbares Debug-Signal). */
export function tRaw(key, params) {
  let msg = _messages[key];
  if (msg === undefined) msg = _fallback?.[key];
  if (msg === undefined) msg = key;
  if (params) {
    msg = msg.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : `{${k}}`));
  }
  return msg;
}

/** Übersetzt eine Backend-Fehlerantwort. Akzeptiert:
 *  - { error_code: 'CODE', params: {...} } → t('error.CODE', params)
 *  - { error: 'freier Text' }              → Text direkt (Legacy-Fallback)
 *  - null / undefined / {}                  → common.unknownError
 */
export function tErrorRaw(response) {
  if (!response) return tRaw('common.unknownError');
  if (response.error_code) return tRaw('error.' + response.error_code, response.params || {});
  if (response.error)      return response.error;
  return tRaw('common.unknownError');
}

// Alpine-Methoden: `t` referenziert `this.$store.shell.uiLocale`, damit Alpine bei Sprachwechsel re-evaluiert.
// `this?.` ist Pflicht: Wird die Methode aus einem Scope aufgerufen, in dem Alpine
// den Receiver verliert (z. B. via `window.__app.t()` aus einer x-effect-Expression
// einer spät hydratisierten Combobox), wäre `this` undefined und der reine
// Reaktivitäts-Touch würde die ganze Alpine-Effect-Kette crashen. Übersetzung
// fällt dann auf die globale `_locale` zurück (tRaw), statt die Karte zu killen.
export const i18nMethods = {
  t(key, params) {
    void this?.$store?.shell?.uiLocale;
    return tRaw(key, params);
  },

  /** Backend-Fehler übersetzen. Siehe tErrorRaw für Schema. */
  tError(response) {
    void this?.$store?.shell?.uiLocale;
    return tErrorRaw(response);
  },

  /** ISO-Timestamp → relativer Lokalisiertext. Lazy-Import um Zykel zu vermeiden. */
  formatLastRun(isoStr) {
    if (!isoStr) return '';
    return _formatLastRunImpl(isoStr, (k, p) => tRaw(k, p), this?.$store?.shell?.uiLocale);
  },

  /** Sprache wechseln, neue Messages laden und auf Server persistieren. */
  async changeLocale(locale) {
    if (!SUPPORTED_LOCALES.includes(locale)) return;
    if (locale === this.$store.shell.uiLocale) return;
    await configureI18n(locale);
    this.$store.shell.uiLocale = locale;
    const region = this.$store.shell.defaultRegion || (locale === 'en' ? 'US' : 'CH');
    document.documentElement.setAttribute('lang', `${locale}-${region}`);
    fetch('/me/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locale }),
    }).catch(e => console.error('[i18n] Persist fehlgeschlagen:', e));
  },
};
