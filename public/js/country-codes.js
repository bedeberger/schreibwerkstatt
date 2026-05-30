// Länder-Picklist für Schauplatz-Verortung. Speicherformat ist
// ISO-3166-1-alpha-2 (lowercase); Labels werden über Intl.DisplayNames in der
// UI-Sprache erzeugt — kein hartcodierter Klartext, kein i18n-Key pro Land.
// Liste bewusst kuratiert (Schwerpunkt DACH + häufige Roman-Schauplätze), nicht
// die vollen ~250 ISO-Codes — eine knappe Combobox schlägt eine endlose Liste.

const COUNTRY_CODES = [
  'ch', 'de', 'at', 'li',
  'fr', 'it', 'es', 'pt', 'gb', 'ie', 'nl', 'be', 'lu',
  'dk', 'se', 'no', 'fi', 'is',
  'pl', 'cz', 'sk', 'hu', 'si', 'hr', 'gr', 'ro', 'bg',
  'ru', 'ua', 'tr',
  'us', 'ca', 'mx', 'br', 'ar',
  'cn', 'jp', 'kr', 'in', 'th', 'vn',
  'au', 'nz',
  'eg', 'ma', 'za', 'il',
];

/** Lokalisiertes Land-Label für einen ISO-2-Code. Fallback: Code in Versalien. */
export function countryLabel(code, lang = 'de') {
  const cc = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  try {
    return new Intl.DisplayNames([lang], { type: 'region' }).of(cc) || cc;
  } catch {
    return cc;
  }
}

/** Combobox-Optionen [{ value, label }], alphabetisch nach lokalisiertem Label. */
export function countryOptions(lang = 'de') {
  return COUNTRY_CODES
    .map(cc => ({ value: cc, label: countryLabel(cc, lang) }))
    .sort((a, b) => a.label.localeCompare(b.label, lang));
}

export { COUNTRY_CODES };
