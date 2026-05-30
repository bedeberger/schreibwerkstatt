// EAN-13-Barcode-Generierung (z.B. aus einer ISBN-13). Pure Encoder + pdfkit-
// Vektor-Renderer. Eine ISBN-13 (Präfix 978/979) IST bereits eine gültige
// EAN-13-Nummer — es findet keine Umrechnung statt, nur Prüfziffer-Recompute.
//
// Spec: EAN-13 codiert 13 Ziffern in 95 Module + Quiet Zones (links 11X,
// rechts 7X). Die erste Ziffer wird NICHT als Balken gezeichnet, sondern wählt
// das L/G-Paritätsmuster der linken 6 Ziffern. Modulbreite X = 0.33 mm bei
// 100 % Vergrösserung (SC2) — sicherste Scanbarkeit. Vektor (Rechtecke) statt
// Raster → PDF/A-tauglich und scharf bei jeder Auflösung.

const MM_TO_PT = 72 / 25.4; // pdfkit rechnet in PostScript-Points (72/inch)
const X_MODULE_MM = 0.33;   // Modulbreite @ 100 % SC2

// L-Codes pro Ziffer (7 Module, 1 = Balken/dunkel). R = Komplement von L,
// G = R rückwärts gelesen. Aus diesen drei leiten sich alle Muster ab.
const L_CODES = [
  '0001101', '0011001', '0010011', '0111101', '0100011',
  '0110001', '0101111', '0111011', '0110111', '0001011',
];
const R_CODES = L_CODES.map((c) => c.replace(/[01]/g, (b) => (b === '0' ? '1' : '0')));
const G_CODES = R_CODES.map((c) => c.split('').reverse().join(''));

// Paritätsmuster der linken 6 Ziffern, indexiert über die erste Ziffer.
const PARITY = [
  'LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG',
  'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL',
];

const GUARD_START = '101';   // normale Schutzmarke (links + rechts)
const GUARD_CENTER = '01010'; // Mittel-Schutzmarke

// Nur Ziffern behalten (ISBN-Strings enthalten oft Bindestriche/Spaces).
function normalizeDigits(raw) {
  return String(raw || '').replace(/[^0-9]/g, '');
}

// EAN-13-Prüfziffer: gerade Positionen (1-basiert) ×3, ungerade ×1.
function checkDigit(digits12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    sum += Number(digits12[i]) * (i % 2 === 0 ? 1 : 3);
  }
  return (10 - (sum % 10)) % 10;
}

// Akzeptiert 12 (Prüfziffer wird ergänzt) oder 13 Ziffern (Prüfziffer wird
// validiert). Gibt die normalisierten 13 Ziffern zurück oder wirft.
function toEan13(raw) {
  const d = normalizeDigits(raw);
  if (d.length === 12) return d + String(checkDigit(d));
  if (d.length === 13) {
    if (Number(d[12]) !== checkDigit(d.slice(0, 12))) {
      throw new Error(`EAN-13: ungültige Prüfziffer in "${raw}"`);
    }
    return d;
  }
  throw new Error(`EAN-13: erwarte 12 oder 13 Ziffern, erhielt ${d.length} ("${raw}")`);
}

function isValidEan13(raw) {
  try { toEan13(raw); return true; } catch { return false; }
}

// Baut die komplette 95-Modul-Bitfolge (ohne Quiet Zones). first = erste Ziffer.
function encodeModules(ean13) {
  const first = Number(ean13[0]);
  const leftParity = PARITY[first];
  let bits = GUARD_START;
  for (let i = 0; i < 6; i++) {
    const digit = Number(ean13[1 + i]);
    bits += leftParity[i] === 'L' ? L_CODES[digit] : G_CODES[digit];
  }
  bits += GUARD_CENTER;
  for (let i = 0; i < 6; i++) {
    bits += R_CODES[Number(ean13[7 + i])];
  }
  bits += GUARD_START;
  return bits; // 3 + 42 + 5 + 42 + 3 = 95
}

// Zeichnet den Barcode in ein pdfkit-Doc. x/y = obere linke Ecke des Symbols
// inkl. linker Quiet Zone. Gibt { width, height } in pt zurück (Gesamtmass mit
// Quiet Zones + menschenlesbarer Zeile), damit Aufrufer Platz reservieren können.
//
// opts.scale  — Vergrösserungsfaktor (Default 1.0 = 100 %/SC2)
// opts.height — Balkenhöhe in mm (Default 22.85, SC2-Nennmass)
// opts.font   — registrierter pdfkit-Font für die Ziffern-Zeile (Default 'Helvetica')
// opts.color  — Balkenfarbe (Default '#000000')
function drawEan13(doc, x, y, ean13Raw, opts = {}) {
  const ean = toEan13(ean13Raw);
  const scale = opts.scale > 0 ? opts.scale : 1.0;
  const x1 = X_MODULE_MM * MM_TO_PT * scale;      // Modulbreite in pt
  const barH = (opts.height > 0 ? opts.height : 22.85) * MM_TO_PT * scale;
  const color = opts.color || '#000000';
  const QUIET_LEFT = 11; // Module
  const QUIET_RIGHT = 7;
  const bits = encodeModules(ean);

  // Guard-Balken (Start/Mitte/Ende) ragen unter die Datenbalken (Standard).
  const guardExtend = 5 * x1;
  const fontSize = Math.max(6, 9 * scale);
  const textGap = 1 * x1;

  // Positionen der Guards (Modul-Indizes), an denen Balken länger sind.
  const guardRanges = [[0, 3], [45, 50], [92, 95]];
  const inGuard = (i) => guardRanges.some(([a, b]) => i >= a && i < b);

  doc.save();
  doc.fillColor(color);
  let cursor = x + QUIET_LEFT * x1;
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') {
      const h = inGuard(i) ? barH + guardExtend : barH;
      doc.rect(cursor, y, x1, h).fill();
    }
    cursor += x1;
  }

  // Menschenlesbare Ziffern: erste Ziffer links der Balken, dann 2 Sechsergruppen
  // unter linker/rechter Hälfte. Balken tragen die Daten; Text ist Fallback.
  doc.font(opts.font || 'Helvetica').fontSize(fontSize).fillColor(color);
  const textY = y + barH + guardExtend - fontSize + textGap;
  // erste Ziffer in der linken Quiet Zone
  doc.text(ean[0], x, textY, { width: QUIET_LEFT * x1 - textGap, align: 'right', lineBreak: false });
  // linke Gruppe (Ziffern 2..7) unter den 42 Modulen nach Start-Guard
  const leftGroupX = x + (QUIET_LEFT + 3) * x1;
  doc.text(ean.slice(1, 7).split('').join(' '), leftGroupX, textY, {
    width: 42 * x1, align: 'center', lineBreak: false,
  });
  // rechte Gruppe (Ziffern 8..13) nach Center-Guard
  const rightGroupX = x + (QUIET_LEFT + 50) * x1;
  doc.text(ean.slice(7).split('').join(' '), rightGroupX, textY, {
    width: 42 * x1, align: 'center', lineBreak: false,
  });
  doc.restore();

  const totalW = (QUIET_LEFT + 95 + QUIET_RIGHT) * x1;
  const totalH = barH + guardExtend + textGap + fontSize;
  return { width: totalW, height: totalH };
}

module.exports = { toEan13, checkDigit, isValidEan13, encodeModules, drawEan13, normalizeDigits };
