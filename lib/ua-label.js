'use strict';
// Auto-Label aus User-Agent fuer Multi-Device-Presence. Bewusst minimalistisch:
// Regex-Match auf Browser-Familie + OS-Familie, Output `"<Browser> · <OS>"`.
// Keine npm-Dep (ua-parser-js etc.) — die App speichert das Label nur als
// User-Hint, exakte Identifikation ist nicht das Ziel.

function uaLabel(uaRaw) {
  const ua = typeof uaRaw === 'string' ? uaRaw : '';
  if (!ua) return 'Unbekanntes Gerät';

  const browser = _browser(ua);
  const os = _os(ua);
  if (!browser && !os) return 'Unbekanntes Gerät';
  if (!browser) return os;
  if (!os) return browser;
  return `${browser} · ${os}`;
}

function _browser(ua) {
  // Reihenfolge wichtig: Edge enthaelt "Chrome", Chrome enthaelt "Safari",
  // Safari enthaelt nicht "Chrome". Edge/Opera vor Chrome vor Safari pruefen.
  if (/\bEdg\//.test(ua)) return 'Edge';
  if (/\bOPR\/|\bOpera\b/.test(ua)) return 'Opera';
  if (/\bFirefox\//.test(ua)) return 'Firefox';
  if (/\bChrome\//.test(ua) && !/\bChromium\//.test(ua)) return 'Chrome';
  if (/\bChromium\//.test(ua)) return 'Chromium';
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'Safari';
  return '';
}

function _os(ua) {
  if (/\bAndroid\b/.test(ua)) return 'Android';
  if (/\biPhone\b|\biPad\b|\biPod\b/.test(ua)) return 'iOS';
  if (/\bMac OS X\b|\bMacintosh\b/.test(ua)) return 'macOS';
  if (/\bWindows NT\b|\bWindows\b/.test(ua)) return 'Windows';
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS';
  if (/\bLinux\b/.test(ua)) return 'Linux';
  return '';
}

module.exports = { uaLabel };
