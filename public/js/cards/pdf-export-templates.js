// Buchgestaltungs-Vorlagen für den Custom-PDF-Export: fertig durchgesetzte
// Profil-Konfigurationen, die der User als eigenes Profil anlegt und dann frei
// weiterbearbeitet.
//
// Eine Vorlage ist eine TEILKONFIGURATION, kein vollständiges Profil: sie nennt
// nur, was sie tatsächlich gestaltet. Den Rest füllt `validateConfig`
// ([lib/pdf-export-defaults.js](../../../lib/pdf-export-defaults.js)) beim
// Anlegen aus den Defaults auf — die Validierung IST der Merge. Dadurch bleibt
// hier nur die gestalterische Aussage stehen, und eine neue Default-Option
// erreicht die Vorlagen automatisch, statt still auf einem alten Wert
// einzufrieren.
//
// Bewusst NICHT gesetzt: die Textfelder in `extras` (Widmung, Impressum,
// Untertitel, ISBN, Klappentext …). Sie gehören dem Werk, nicht der Gestaltung —
// eine Vorlage, die sie mitbrächte, würde beim Anwenden fremden Text
// hineinschreiben oder vorhandenen leeren. Gesetzt werden nur die *Platzierungs*-
// Schalter daneben (Impressum auf Verso, Widmung auf Recto …).
//
// Schriftwahl ist an die Whitelist in [lib/font-fetch.js](../../../lib/font-fetch.js)
// gebunden (Familie UND Gewicht) — eine Vorlage mit nicht gelisteter Schrift
// liesse sich anlegen, aber nicht mehr speichern (`FONT_NOT_ALLOWED` beim PUT).
//
// Zwei gelistete Familien sind fuer Fliesstext trotzdem unbrauchbar und stehen
// darum in `HYPHEN_BROKEN_FAMILIES`: bei ihnen faellt der TRENNSTRICH am
// Zeilenumbruch aus, das Wort wird also stillschweigend in zwei Teile
// zerschnitten. Literale Bindestriche im Text sind nicht betroffen, weshalb der
// Fehler erst im gesetzten Absatz auffaellt. Eine Vorlage darf dort nicht landen.
//
// Reine Daten + pure Funktionen, keine Alpine-/`this`-Bindung — wie
// pdf-export-presets.js, und damit ohne Browser testbar.

// ── Vorlage 1: kleines, modernes Taschenbuch ────────────────────────────────
// 12.5 × 20 cm. Zeitgenössischer Handelsband: enge, papiersparende Ränder,
// Spectral im Satz gegen Work Sans in den Titeln, ruhige Kapitelköpfe ohne
// Zierrat, keine laufenden Kolumnentitel — die Seitenzahl allein trägt die
// Orientierung. Satzbreite 93 mm ≈ 62 Zeichen.
const TASCHENBUCH_MODERN = {
  layout: {
    pageSize: 'custom', customWidthMm: 125, customHeightMm: 200,
    // left = Bund (innen), right = aussen — mirrorMargins tauscht sie auf Verso.
    marginsMm: { top: 16, right: 14, bottom: 19, left: 18 },
    mirrorMargins: true,
    // Kein Kolumnentitel: der Default setzt {title} in die Kopfzeile, die
    // Vorlage muss ihn also aktiv leeren statt ihn bloss nicht zu erwähnen.
    headerLeft: '', headerCenter: '', headerRight: '',
    footerLeft: '', footerCenter: '{page}', footerRight: '',
    headerRule: false, footerRule: false,
    showHeaderOnChapterStart: false, showFooterOnChapterStart: false,
    hyphenate: true, widowOrphanControl: true,
    pageCountMode: 'body', pageNumberStart: 1, pageNumberFirstVisible: 1,
    frontMatterNumbering: 'none',
  },
  font: {
    // Erstzeilen-Einzug STATT Absatzabstand — zwei Absatzmarken nebeneinander
    // wären eine doppelte Ansage (paragraphGap zählt in Zeilen, nicht in mm).
    body:        { family: 'Spectral', weight: 400, sizePt: 10,   lineHeight: 1.42, paragraphGap: 0, firstLineIndentMm: 4.5, color: '#1a1a1a', numerals: 'auto' },
    heading:     { family: 'Work Sans', weight: 600, sizes: { h1: 19, h2: 15, h3: 12.5, h4: 11.5, h5: 11, h6: 10.5 }, color: '#111111' },
    title:       { family: 'Work Sans', weight: 700, sizePt: 26, color: '#111111' },
    subtitle:    { family: 'Work Sans', weight: 400, sizePt: 14, color: '#444444' },
    byline:      { family: 'Work Sans', weight: 500, sizePt: 11, color: '#444444' },
    // Kursive Rollen bleiben auf der Serifen-Familie — die Kursive ist dort die
    // Auszeichnung des Fliesstexts und gehört zu seiner Schrift.
    dedication:  { family: 'Spectral', weight: 400, sizePt: 11,  color: '#1a1a1a', italic: true },
    frontMatter: { family: 'Spectral', weight: 400, sizePt: 11,  color: '#1a1a1a', italic: true },
    authorBio:   { family: 'Spectral', weight: 400, sizePt: 9.5, lineHeight: 1.4,  paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    bibliography:{ family: 'Spectral', weight: 400, sizePt: 9,   lineHeight: 1.3,  paragraphGap: 0.3, color: '#1a1a1a', italic: false },
    footnote:    { family: 'Spectral', weight: 400, sizePt: 7.5, lineHeight: 1.2,  color: '#333333', italic: false },
    imprint:     { family: 'Spectral', weight: 400, sizePt: 8.5, color: '#333333', italic: false },
    year:        { family: 'Work Sans', weight: 400, sizePt: 11, color: '#444444', italic: false },
    toc:         { family: 'Spectral', weight: 400, sizePt: 10, lineHeight: 1.5, paragraphGap: 0.2, color: '#1a1a1a' },
    tocTitle:    { family: 'Work Sans', weight: 600, sizePt: 16, color: '#111111' },
    header:      { family: 'Work Sans', weight: 400, sizePt: 8,   color: '#8a8a8a' },
    footer:      { family: 'Work Sans', weight: 400, sizePt: 8.5, color: '#8a8a8a' },
  },
  chapter: {
    // 'always' statt 'right-page': ein Taschenbuch zählt Bogen, nicht Gesten —
    // jedes Kapitel auf Recto kostet im Schnitt eine halbe Leerseite pro Kapitel.
    breakBefore: 'always',
    breakBeforeSubchapter: true,
    firstChapterOnRecto: true,
    blankPageAfter: false,
    numbering: 'arabic', numberingMode: 'flat',
    titleStyle: 'minimal',
    dropCap: false,
    spaceBeforeMm: 34,
    // Ein Roman ist ein Fliesstext: die Seiten eines Kapitels laufen ohne
    // eigene Überschrift und ohne Umbruch durch.
    pageStructure: 'flatten',
    pageBreakBetweenPages: false,
    titleRule: false, pageTitleRule: false,
  },
  cover: { enabled: true, fit: 'cover' },
  toc: {
    enabled: true, depth: 1, includePages: false,
    showPageNumbers: true, titleAlign: 'left',
    indentMm: 5, leader: 'dots', pageNumReserveMm: 12, startOnRecto: true,
  },
  extras: { imprintPosition: 'front', imprintOnVerso: true, dedicationOnRecto: true, barcode: true },
  footnotes: { separator: true, separatorWidthMm: 25, gapMm: 2, hangMm: 3.5, maxHeightPct: 35 },
  print: { bleedMm: 0, cropMarks: false, blackTextKOnly: false, dpiWarnThreshold: 300, padToEvenPages: true },
  // Rückenstärke-Richtwert für den Umschlagbogen (weisses POD-Papier).
  // pageCount bleibt 0 — die trägt der Innenteil-Export selbst nach.
  coverSpec: { paperBulkMmPer1000: 57.2 },
  pdfa: { standard: 'pdfa', conformance: 'B' },
};

// ── Vorlage 2: klassischer grosser deutschsprachiger Roman ──────────────────
// 15.5 × 23 cm. Ruhiger Werksatz nach klassischem Vorbild: eine einzige
// Renaissance-Antiqua über alle Rollen, grosszügiger Rand mit schwerem Fuss,
// Mediävalziffern im Fliesstext, Kapitel auf der rechten Seite mit tiefem
// Anfang und Initiale, Kolumnentitel in Versalien (Verso Werk, Recto Kapitel),
// römische Zählung der Titelei. Satzbreite 105 mm ≈ 66 Zeichen.
const ROMAN_KLASSISCH = {
  layout: {
    pageSize: 'custom', customWidthMm: 155, customHeightMm: 230,
    // Der Fuss ist deutlich schwerer als der Kopf: der Satzspiegel sitzt optisch
    // in der Mitte, nicht geometrisch — auf der geometrischen Mitte wirkt er
    // nach unten gerutscht.
    marginsMm: { top: 24, right: 30, bottom: 38, left: 20 },
    mirrorMargins: true,
    headerLeft: '', headerCenter: '{chapter}', headerRight: '',
    headerVersoLeft: '', headerVersoCenter: '{title}', headerVersoRight: '',
    footerLeft: '', footerCenter: '{page}', footerRight: '',
    hfStyle: {
      header: {
        recto: { center: { upper: true } },
        verso: { center: { upper: true } },
      },
    },
    headerRule: false, footerRule: false,
    showHeaderOnChapterStart: false, showFooterOnChapterStart: false,
    showHeaderOnChapterEnd: true, showFooterOnChapterEnd: true,
    hyphenate: true, widowOrphanControl: true,
    // Titelei römisch (i, ii, iii), Werk arabisch ab 1 — der klassische
    // Doppelzählstrang. Nur tragfähig zusammen mit pageCountMode='body'.
    pageCountMode: 'body', pageNumberStart: 1, pageNumberFirstVisible: 1,
    frontMatterNumbering: 'roman', frontMatterNumberFirstVisible: 1,
  },
  font: {
    body:        { family: 'EB Garamond', weight: 400, sizePt: 11.5, lineHeight: 1.5, paragraphGap: 0, firstLineIndentMm: 5.5, color: '#1c1a17', numerals: 'oldstyle' },
    // Überschriften im REGULÄREN Schnitt, nur grösser und zentriert — der
    // klassische Werksatz kennt keinen fetten Kapitelkopf. Die Rolle trägt
    // zugleich die Initiale (lib/pdf-render/dropcap.js setzt sie in 'heading'):
    // ein Fettschnitt stünde als Klotz im Text.
    heading:     { family: 'EB Garamond', weight: 400, sizes: { h1: 20, h2: 16, h3: 13.5, h4: 12.5, h5: 12, h6: 11.5 }, color: '#1c1a17' },
    title:       { family: 'EB Garamond', weight: 500, sizePt: 28, color: '#1c1a17' },
    subtitle:    { family: 'EB Garamond', weight: 400, sizePt: 15, color: '#3a3630' },
    byline:      { family: 'EB Garamond', weight: 400, sizePt: 12, color: '#3a3630' },
    dedication:  { family: 'EB Garamond', weight: 400, sizePt: 12,   color: '#1c1a17', italic: true },
    frontMatter: { family: 'EB Garamond', weight: 400, sizePt: 12,   color: '#1c1a17', italic: true },
    authorBio:   { family: 'EB Garamond', weight: 400, sizePt: 10.5, lineHeight: 1.45, paragraphGap: 0.3, color: '#1c1a17', italic: false },
    bibliography:{ family: 'EB Garamond', weight: 400, sizePt: 10,   lineHeight: 1.35, paragraphGap: 0.3, color: '#1c1a17', italic: false },
    footnote:    { family: 'EB Garamond', weight: 400, sizePt: 8.5,  lineHeight: 1.25, color: '#1c1a17', italic: false },
    imprint:     { family: 'EB Garamond', weight: 400, sizePt: 9,    color: '#3a3630', italic: false },
    year:        { family: 'EB Garamond', weight: 400, sizePt: 12,   color: '#3a3630', italic: false },
    toc:         { family: 'EB Garamond', weight: 400, sizePt: 11, lineHeight: 1.7, paragraphGap: 0.2, color: '#1c1a17' },
    tocTitle:    { family: 'EB Garamond', weight: 400, sizePt: 18, color: '#1c1a17' },
    header:      { family: 'EB Garamond', weight: 400, sizePt: 9,  color: '#4a463f' },
    footer:      { family: 'EB Garamond', weight: 400, sizePt: 10, color: '#3a3630' },
  },
  chapter: {
    // Jedes Kapitel auf der rechten Seite — die Geste, für die dieses Format da ist.
    breakBefore: 'right-page',
    breakBeforeSubchapter: true,
    firstChapterOnRecto: true,
    blankPageAfter: false,
    // Römisch und flach: I, II, III über die Kapitel; Unterebenen fallen im
    // Renderer ohnehin auf arabisch zurück.
    numbering: 'roman', numberingMode: 'flat',
    titleStyle: 'centered-large',
    dropCap: true,
    spaceBeforeMm: 55,
    pageStructure: 'flatten',
    pageBreakBetweenPages: false,
    titleRule: false, pageTitleRule: false,
  },
  cover: { enabled: true, fit: 'cover' },
  toc: {
    enabled: true, depth: 1, includePages: false,
    showPageNumbers: true, titleAlign: 'center',
    // Ohne Punktlinie: im klassischen Werksatz steht die Zahl frei rechts.
    indentMm: 7, leader: 'none', pageNumReserveMm: 14, startOnRecto: true,
  },
  extras: { imprintPosition: 'front', imprintOnVerso: true, dedicationOnRecto: true, barcode: true },
  footnotes: { separator: true, separatorWidthMm: 35, gapMm: 2.5, hangMm: 5, maxHeightPct: 45 },
  print: { bleedMm: 0, cropMarks: false, blackTextKOnly: false, dpiWarnThreshold: 300, padToEvenPages: true },
  coverSpec: { paperBulkMmPer1000: 60 },
  pdfa: { standard: 'pdfa', conformance: 'B' },
};

// `id` ist der stabile Schlüssel (Auswahl im UI), `nameKey` der vorgeschlagene
// Profilname, `descKey` der erklärende Satz darunter. Reihenfolge = Anzeige.
export const PDF_TEMPLATES = [
  {
    id: 'taschenbuch-modern',
    nameKey: 'pdfExport.template.taschenbuchModern.name',
    descKey: 'pdfExport.template.taschenbuchModern.desc',
    config: TASCHENBUCH_MODERN,
  },
  {
    id: 'roman-klassisch',
    nameKey: 'pdfExport.template.romanKlassisch.name',
    descKey: 'pdfExport.template.romanKlassisch.desc',
    config: ROMAN_KLASSISCH,
  },
];

// Familien, bei denen der Trennstrich am Zeilenumbruch nicht gezeichnet wird
// (gemessen ueber lib/pdf-render gegen die ganze Whitelist; alle uebrigen
// Familien setzen ihn korrekt). Gegated in tests/unit/pdf-export-templates.test.mjs.
export const HYPHEN_BROKEN_FAMILIES = ['Source Serif 4', 'Source Sans 3'];

export function templateById(id) {
  return PDF_TEMPLATES.find(t => t.id === id) || null;
}

export function templateOptions(t) {
  return PDF_TEMPLATES.map(tpl => ({ value: tpl.id, label: t(tpl.nameKey) }));
}

export function templateDescription(id, t) {
  const tpl = templateById(id);
  return tpl ? t(tpl.descKey) : '';
}

export function templateName(id, t) {
  const tpl = templateById(id);
  return tpl ? t(tpl.nameKey) : '';
}

/** Teilkonfiguration der Vorlage als eigene Kopie (Aufrufer darf sie mutieren). */
export function templateConfig(id) {
  const tpl = templateById(id);
  return tpl ? structuredClone(tpl.config) : null;
}
