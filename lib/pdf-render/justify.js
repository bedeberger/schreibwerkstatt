'use strict';
// Eigener Zeilen-Layouter: EIN Textpfad für Fliesstext, Überschriften, Listen,
// Gedichte/Code, den Initialen-Absatz und den Fussnotenapparat.
//
// Warum: pdfkit kann eine Sichtzeile, die aus mehreren `continued`-Fragmenten
// besteht (Fliesstext → Link/`<strong>`/`<em>` → Fliesstext), NICHT als Ganzes
// justieren. Es behandelt jedes Fragment-Ende als Absatz-Schlusszeile
// (erzwingt linksbündig) und berechnet den Wortabstand PRO Fragment gegen die
// volle Zeilenbreite (pdfkit.js `_fragment`, justify-Zweig). Ergebnis: der Text
// vor einer Formatierung sitzt eng, der umbrechende Text danach schluckt den
// gesamten Rest → riesige Lücken um jede Formatierung.
//
// Dieser Layouter bricht die Zeilen selbst (linebreak.js: misst jeden Run in
// SEINER Schrift, inkl. Silbentrennung und Notbruch) und verteilt den
// Wortabstand pro Sichtzeile gleichmässig über alle Runs. Weil er jede Zeile
// kennt, sitzen hier auch die Entscheidungen, die pdfkit nicht treffen kann:
// Fussnoten-Reserve pro Zeile und Witwen-/Waisenkontrolle (eine Zeile früher
// umbrechen statt den ganzen Absatz zu schieben).
//
// Vertikaler Fluss + Seitenumbruch laufen über doc.y + doc.addPage, damit die
// Geometrie-Hooks (Spiegelung, Einzugs-Stapel, Fussnoten-Rand) komponieren.
//
// Nur Einspaltensatz; der Zweispalter (pdfkit `columns`) läuft über runs.js.

const { _currentPageIdx } = require('./layout');
const { measureText } = require('./measure');
const {
  _tokenize, _breakLines, _styleSig, _sizeFor, _fontKeyOf, noteIdsOfLine, SUP_SCALE, SUP_RISE,
} = require('./linebreak');

// Wortabstand im Blocksatz höchstens so viel breiter als normal — darüber
// entstehen „Gassen"; die Zeile bleibt dann lieber etwas kürzer.
const MAX_WORD_SPACE_FACTOR = 3;

/** Vertikaler Versatz des Zeichen-Ursprungs fuer einen hochgestellten Run.
 *
 *  pdfkit setzt `y` auf die OBERKANTE der Zeile, nicht auf die Grundlinie. Eine
 *  kleinere Schrift an derselben Oberkante haette damit automatisch eine hoehere
 *  Grundlinie — aber um einen von der Schrift abhaengigen Betrag. Darum wird hier
 *  zurueckgerechnet: gewuenscht ist Grundlinie(sup) = Grundlinie(Fliesstext) −
 *  SUP_RISE·Groesse, und der Versatz ergibt sich aus der Oberlaenge der Schrift.
 *
 *  Muss aufgerufen werden, NACHDEM die Schrift am doc gesetzt ist (`doc._font`).
 *  Fehlt die Metrik, faellt es auf 0.75 zurueck — der Ueblichkeitswert fuer
 *  Serifen-Werksatzschriften. */
function _supOffset(doc, style, sizePt) {
  if (!style || !style.sup) return 0;
  const asc = Number.isFinite(doc?._font?.ascender) ? doc._font.ascender / 1000 : 0.75;
  return asc * sizePt * (1 - SUP_SCALE) - SUP_RISE * sizePt;
}

function _renderLine(doc, line, x, y, o) {
  const { sizePt, ws, textColor, linkColor } = o;
  let segText = '';
  let segStyle = null;
  let segAdvance = 0;
  let segSpaces = 0;
  let segLeadWidth = 0;  // Vorschub führender Spaces (bevor das erste Wort kam)
  let segLeadSpaces = 0;
  let segHasWord = false;
  const flush = () => {
    if (segText === '') return;
    // Hochgestellte Segmente (Notenziffern) laufen kleiner und auf angehobener
    // Grundlinie. Der Zeilenvorschub bleibt davon unberührt — eine Note darf den
    // Zeilenabstand nicht aufreissen.
    const segSize = _sizeFor(segStyle, sizePt);
    doc.font(_fontKeyOf(segStyle, o)).fontSize(segSize);
    const segDy = _supOffset(doc, segStyle, sizePt);
    doc.fillColor(segStyle && segStyle.link ? linkColor : textColor);
    // pdfkit `_fragment` macht bei gesetztem wordSpacing intern ein
    // `text.trim().split(/\s+/)` und baut die Wortabstände selbst — ein
    // FÜHRENDER Boundary-Space (z. B. das Trennzeichen nach `</em>`, das als
    // leading space ins Folge-Segment fällt) geht dabei verloren und die Wörter
    // kleben aneinander ("Heimatund"). Fix: den sichtbaren Text ohne führenden
    // Whitespace zeichnen und die Startposition um dessen Vorschub (inkl.
    // justify-ws) nach rechts schieben.
    const drawText = segText.replace(/^\s+/, '');
    const drawX = x + segLeadWidth + ws * segLeadSpaces;
    // Ohne LineWrapper füllt pdfkit `textWidth`/`wordCount` nicht — die
    // Unterstrich-/Link-Rechteckbreite (`renderedWidth` in _fragment) würde sonst
    // NaN. Beide um den führenden Whitespace bereinigt.
    const topts = {
      lineBreak: false, wordSpacing: ws,
      underline: !!(segStyle && segStyle.underline),
      textWidth: segAdvance - segLeadWidth, wordCount: (segSpaces - segLeadSpaces) + 1,
    };
    if (segStyle && segStyle.link) topts.link = segStyle.link;
    doc.text(drawText, drawX, y + segDy, topts);
    x += segAdvance + ws * segSpaces;
    segText = ''; segStyle = null; segAdvance = 0; segSpaces = 0;
    segLeadWidth = 0; segLeadSpaces = 0; segHasWord = false;
  };
  // Verbund-Tokens (Klebe-Regeln in _tokenize) sind nur fuer den Zeilenumbruch
  // eine Einheit — gezeichnet wird jeder Teil mit seinem eigenen Style.
  const items = [];
  for (const it of line.items) {
    if (!it.parts) { items.push(it); continue; }
    for (const p of it.parts) items.push({ word: p.text, style: p.style, w: p.w });
  }
  for (const it of items) {
    const sig = _styleSig(it.style);
    if (segStyle !== null && _styleSig(segStyle) !== sig) flush();
    if (segStyle === null) segStyle = it.style;
    if (it.space) {
      if (!segHasWord) { segLeadWidth += it.w; segLeadSpaces++; }
      segText += ' '; segSpaces++;
    } else {
      segHasWord = true;
      segText += it.word;
    }
    segAdvance += it.w;
  }
  flush();
}

/** Runs umbrechen, ohne zu zeichnen. Liefert das Layout, das `drawLayout`
 *  setzt — getrennt, damit ein Aufrufer (Initialen-Absatz, Keep-with-next) die
 *  Zeilenzahl kennt, BEVOR er über den Seitenumbruch entscheidet. */
function layoutRuns(doc, runs, opts) {
  const {
    sizePt, lineHeight, firstLineIndent = 0, hangingIndentPt = 0, hyphenate = null,
    fontKeyBase = 'body', plainFont = false, indentFor = null,
  } = opts;
  const items = _tokenize(runs);
  const width = Number.isFinite(opts.width)
    ? opts.width
    : doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const o = { sizePt, hyphenate, fontKeyBase, plainFont };
  const spaceWidth = measureText(doc, ' ', _fontKeyOf(null, o), sizePt);
  const lines = items.length ? _breakLines(doc, items, {
    ...o, totalWidth: width, firstIndent: firstLineIndent, hangIndent: hangingIndentPt, spaceWidth, indentFor,
  }) : [];
  doc.font(_fontKeyOf(null, o)).fontSize(sizePt);
  const fitHeight = doc.currentLineHeight(true);
  const advance = fitHeight + ((lineHeight || 1) - 1) * sizePt;
  return { lines, width, spaceWidth, fitHeight, advance, o };
}

/** Ein fertiges Layout in den Fluss setzen.
 *
 *  Witwen/Waisen (`widowOrphan`): keine einzelne Absatzzeile allein am Seitenfuss
 *  (Waise → der Absatz beginnt auf der Folgeseite) und keine einzelne Zeile oben
 *  auf der Folgeseite (Witwe → eine Zeile FRÜHER umbrechen, sodass zwei Zeilen
 *  hinüberwandern). Bei drei Zeilen, von denen zwei passen, ginge beides nur mit
 *  einer Waise — dann wandert der ganze Absatz.
 *
 *  `lockLines` (Initialen-Absatz): die ersten N Zeilen stehen zusammen neben dem
 *  Initial; der Aufrufer hat ihren Platz geprüft, hier wird darin nie umbrochen.
 *
 *  `marker` (Listen): Aufzählungszeichen/Nummer, rechtsbündig in den Einzug vor
 *  der ersten Zeile gesetzt — auf derselben Seite wie die Zeile, nach jedem
 *  Umbruch entschieden. */
function drawLayout(doc, layout, opts) {
  const { lines, width, spaceWidth, fitHeight, advance, o } = layout;
  if (!lines.length) return;
  const {
    sizePt, textColor = '#000000', linkColor = '#1a4d8f', firstLineIndent = 0, hangingIndentPt = 0,
    align = 'justify', widowOrphan = false, lockLines = 0, marker = null, indentFor = null,
  } = opts;
  // Fussnoten: `footnotes` ist der Zustand aus footnotes.js. Fehlt er, laeuft
  // alles wie zuvor — der Zweig kostet dann nichts.
  const fn = opts.footnotes || null;
  const n = lines.length;
  const roomFor = (k) => doc.y + (k - 1) * advance + fitHeight <= doc.page.maxY();

  for (let li = 0; li < n; li++) {
    const line = lines[li];

    // ── Umbruchentscheidung, GENAU EINE pro Zeile ────────────────────────────
    // Traegt die Zeile Notenmarker, muss der Platz ihrer Noten am Seitenfuss
    // schon in DIESER Pruefung stecken. Sonst passt die Zeile, die Reserve
    // waechst danach — und die letzte Zeile der Seite steht im Apparat.
    //
    // TERMINIERUNG kommt aus der Struktur: pro Zeile hoechstens EIN
    // Seitenumbruch (kein Re-Check nach dem addPage), und der Deckel haelt die
    // Reserve unter einem Bruchteil des Satzspiegels. Auf einer frischen Seite
    // (`pageEmpty`) wird nie umbrochen — sie nimmt jede Zeile.
    const noteIds = fn ? noteIdsOfLine(line) : null;
    const pageIdx = fn && noteIds && noteIds.length ? _currentPageIdx(doc) : -1;
    const extraH = pageIdx >= 0 ? fn.extraHeightFor(pageIdx, noteIds) : 0;
    const pageEmpty = doc.y <= doc.page.margins.top + 0.5;
    let brk = false;
    if (!pageEmpty && (li === 0 || li >= lockLines)) {
      const overflows = doc.y + fitHeight + extraH > doc.page.maxY();
      const overCap = extraH > 0 && fn.wouldExceedCap(pageIdx, extraH);
      brk = overflows || overCap;
      if (!brk && widowOrphan && n >= 2 && li >= lockLines) {
        if (li === 0) {
          // Wie viele Zeilen passen ab hier noch (ohne künftige Noten)?
          let fit = 1;
          while (fit < n && roomFor(fit + 1)) fit++;
          if (fit < n) {
            // Waise (nur eine Zeile hier) oder Witwe, die sich nur mit einer
            // Waise vermeiden liesse → ganzer Absatz auf die Folgeseite.
            if (fit < 2 || (n - fit < 2 && fit - 1 < 2)) brk = true;
          }
        } else if (li === n - 2 && li >= 2 && !roomFor(2)) {
          // Witwe: die Schlusszeile passt nicht mehr → schon jetzt umbrechen,
          // damit zwei Zeilen hinüberwandern. `li >= 2` hält oben mindestens
          // zwei Zeilen stehen (sonst entstünde eine Waise).
          brk = true;
        }
      }
    }
    if (brk) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    // Einzug dieser Zeile: Initialen-Absatz pro Zeile, sonst Erstzeilen-/
    // hängender Einzug.
    const indent = typeof indentFor === 'function' ? indentFor(li) : (li === 0 ? firstLineIndent : hangingIndentPt);
    const left = doc.page.margins.left + indent;
    const avail = width - indent;
    const isLast = li === n - 1;
    let ws = 0;
    let x = left;
    if (align === 'justify' && !line.forced && !isLast && line.spaces > 0) {
      ws = (avail - line.width) / line.spaces;
      if (ws < 0) ws = 0;
      else if (ws > spaceWidth * MAX_WORD_SPACE_FACTOR) ws = spaceWidth * MAX_WORD_SPACE_FACTOR;
    } else if (align === 'center') {
      x = left + Math.max(0, (avail - line.width) / 2);
    } else if (align === 'right') {
      x = left + Math.max(0, avail - line.width);
    }
    if (li === 0 && marker && marker.text) {
      const mKey = marker.fontKey || o.fontKeyBase || 'body';
      const mSize = marker.sizePt || sizePt;
      const mw = measureText(doc, marker.text, mKey, mSize);
      doc.font(mKey).fontSize(mSize).fillColor(marker.color || textColor);
      doc.text(marker.text, left - (marker.gap || 0) - mw, doc.y, { lineBreak: false });
    }
    _renderLine(doc, line, x, doc.y, { sizePt, ws, textColor, linkColor, fontKeyBase: o.fontKeyBase, plainFont: o.plainFont });
    doc.y += advance;

    // Erst NACH dem Setzen zuschlagen: die Reserve gilt ab der Folgezeile.
    // `maxReserve` haelt den Apparat unter dem Deckel — damit bleibt
    // garantiert Satzspiegel fuer Text uebrig und der Umbruch terminiert.
    if (fn && noteIds && noteIds.length) {
      fn.commit(_currentPageIdx(doc), noteIds, { maxReserve: fn.capPt });
    }
  }
  doc.x = doc.page.margins.left;
  doc.fillColor(textColor);
  // Basis-Schrift zurück: endete der Absatz auf einem hochgestellten Run, stünde
  // sonst dessen Grösse am Dokument, und ein folgendes moveDown(paragraphGap)
  // rechnete mit der Zeilenhöhe der Notenziffer.
  doc.font(_fontKeyOf(null, o)).fontSize(sizePt);
}

// Rendert `runs` ab der aktuellen doc-Position (Einspaltensatz).
function _renderRunsJustified(doc, runs, opts) {
  const layout = layoutRuns(doc, runs, opts);
  drawLayout(doc, layout, opts);
  return layout;
}

module.exports = {
  _renderRunsJustified, layoutRuns, drawLayout, _tokenize, _breakLines, _styleSig, _renderLine,
  _sizeFor, _supOffset, noteIdsOfLine, SUP_SCALE, SUP_RISE,
};
