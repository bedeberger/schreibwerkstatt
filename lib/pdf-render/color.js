'use strict';
// K-only-Schwarz für die Druckvorstufe. Wandelt achromatische (grau/schwarze)
// Textfarben in reines DeviceCMYK-K um ([0,0,0,K]), damit sie im Druck NICHT als
// 4-farbiges „Rich-Black" separiert werden (Passer-/Moiré-Risiko auf kleinen
// Serifen, matschiges Schwarz). Chromatische Farben (Links, farbige Headings)
// bleiben unangetastet RGB.
//
// Nur für die Druckpfade (PDF/X, unmarkiert) sinnvoll — NICHT für PDF/A-2b: dort
// gilt sRGB-OutputIntent, DeviceCMYK ohne CMYK-OutputIntent bricht die Konformität
// (veraPDF flaggt es). Der Aufrufer gated deshalb auf !config.pdfa.enabled.

// Achromatisch, wenn die drei RGB-Kanäle nah beieinander liegen. #1a4d8f (Link)
// hat Spannweite 117 → bleibt RGB; #1a1a1a/#666666/#999999 → K-only.
const _ACHROMATIC_SPREAD = 16;

const _NAMED = { black: [0, 0, 0], white: [255, 255, 255] };

// Parst einen Farbwert in [r,g,b] (0..255) oder null, wenn kein RGB-Literal.
// Bewusst NUR Strings (#rgb/#rrggbb/black/white) und 3-elementige Arrays — CMYK
// (Länge 4), Gradients, Patterns und alles andere geben null zurück (idempotent:
// eine bereits konvertierte K-Farbe wird nicht erneut angefasst).
function _parseRgb(color) {
  if (typeof color === 'string') {
    const s = color.trim().toLowerCase();
    if (_NAMED[s]) return _NAMED[s].slice();
    if (s[0] === '#') {
      let hex = s.slice(1);
      if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
      if (hex.length !== 6 || /[^0-9a-f]/.test(hex)) return null;
      const n = parseInt(hex, 16);
      return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    }
    return null;
  }
  if (Array.isArray(color) && color.length === 3 && color.every(v => typeof v === 'number')) {
    return color.slice();
  }
  return null;
}

// Gibt eine DeviceCMYK-K-Farbe [0,0,0,K] (K in 0..100) zurück, wenn die Farbe
// achromatisch ist, sonst null. Der Grauwert bleibt erhalten (helles Grau bleibt
// hell), nur der Farbraum wechselt auf reines K.
function _rgbToKOnly(color) {
  const rgb = _parseRgb(color);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  if (Math.max(r, g, b) - Math.min(r, g, b) > _ACHROMATIC_SPREAD) return null;
  const avg = (r + g + b) / 3;
  const k = Math.round(Math.max(0, Math.min(100, (1 - avg / 255) * 100)));
  return [0, 0, 0, k];
}

// Monkey-patcht doc.fillColor: achromatische Fill-Farben laufen als K-only raus.
// strokeColor (Linien/Regeln) bleibt unberührt — dort ist Rich-Black unkritisch,
// und Trennlinien sollen ihren Grauton behalten. doc.image ist ohnehin
// unabhängig von fillColor.
function _patchBlackToK(doc) {
  const orig = doc.fillColor.bind(doc);
  doc.fillColor = function patchedFillColor(color, opacity) {
    const k = _rgbToKOnly(color);
    return orig(k || color, opacity);
  };
}

module.exports = { _rgbToKOnly, _patchBlackToK };
