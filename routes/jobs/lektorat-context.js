'use strict';
// Nachbarseiten-Kontext: letzter Absatz der Vorseite + erster Absatz der
// Folgeseite. Reiner Lesekontext für Übergänge (Tempus/Perspektive/Anschluss)
// und die Stil-/Szenenbewertung — geprüft wird ausschliesslich die Seite selbst
// (Prompt-Pflicht + dropNeighbourFindings als Code-Backstop).
const NEIGHBOUR_EXCERPT_CHARS = 600;

function _paragraphs(text) {
  return (text || '').trim().split(/\n{2,}|(?<=[.!?…])\s{2,}/).map(p => p.trim()).filter(Boolean);
}

// Letzten Absatz eines Texts extrahieren (max. maxChars Zeichen), vorne an
// einem Satzanfang abgeschnitten.
function lastParagraph(text, maxChars = NEIGHBOUR_EXCERPT_CHARS) {
  const clean = (text || '').trim();
  if (!clean) return null;
  const paragraphs = _paragraphs(clean);
  const last = paragraphs.length ? paragraphs[paragraphs.length - 1] : clean;
  if (last.length <= maxChars) return last;
  const tail = last.slice(-maxChars);
  const firstSentenceStart = tail.search(/[A-ZÄÖÜ]/);
  return firstSentenceStart > 0 ? tail.slice(firstSentenceStart) : tail;
}

// Ersten Absatz eines Texts extrahieren (max. maxChars Zeichen), hinten am
// letzten Satzende innerhalb des Limits abgeschnitten. Findet sich im ersten
// Drittel kein Satzende, bleibt der harte Schnitt.
function firstParagraph(text, maxChars = NEIGHBOUR_EXCERPT_CHARS) {
  const clean = (text || '').trim();
  if (!clean) return null;
  const first = _paragraphs(clean)[0] || clean;
  if (first.length <= maxChars) return first;
  const head = first.slice(0, maxChars);
  let cut = -1;
  for (const m of head.matchAll(/[.!?…][»«"'“”‘’]?(?=\s|$)/g)) cut = m.index + m[0].length;
  return cut > maxChars / 3 ? head.slice(0, cut) : head;
}

// Gibt die Seite zurück, die im Abstand `offset` (-1 = vorher, +1 = nachher) zu
// `currentPageId` liegt – bevorzugt im selben Kapitel, sonst im ganzen Buch.
// Kapitelgrenzen werden nicht überschritten: die erste/letzte Seite eines
// Kapitels hat keinen Nachbarn auf dieser Seite.
function findNeighbourPage(pages, currentPageId, currentChapterId, offset) {
  if (!Array.isArray(pages) || !pages.length) return null;
  const sameChapter = currentChapterId
    ? pages.filter(p => String(p.chapter_id || '') === String(currentChapterId))
    : pages;
  const byPos = (list) => list.slice().sort((a, b) => (a.position || 0) - (b.position || 0));
  const pool = byPos(sameChapter.length > 0 ? sameChapter : pages);
  const at = (list, i) => (i >= 0 && i < list.length ? list[i] : null);
  const idx = pool.findIndex(p => String(p.id) === String(currentPageId));
  if (idx !== -1) return at(pool, idx + offset);
  // Fallback: falls die aktuelle Seite nicht in der Kapitel-Liste ist, Nachbar im ganzen Buch nehmen
  if (currentChapterId && sameChapter.length === 0) {
    const allSorted = byPos(pages);
    const i2 = allSorted.findIndex(p => String(p.id) === String(currentPageId));
    return i2 === -1 ? null : at(allSorted, i2 + offset);
  }
  return null;
}
const findPreviousPage = (pages, id, chapterId) => findNeighbourPage(pages, id, chapterId, -1);
const findNextPage     = (pages, id, chapterId) => findNeighbourPage(pages, id, chapterId, +1);

// Findings verwerfen, deren «original» nicht auf der geprüften Seite steht,
// wohl aber in einem Nachbarseiten-Auszug: das Modell hat den Lesekontext
// trotz Verbot mitgeprüft. Vergleich whitespace-kollabiert wie der Frontend-
// Matcher (public/js/utils/html-find.js#findInHtml). Findings, die in keinem
// der Texte stehen, bleiben unangetastet — die fängt wie bisher die
// Positionierung im Frontend ab.
function dropNeighbourFindings(fehler, pageText, excerpts) {
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const ctx = (excerpts || []).map(norm).filter(Boolean);
  if (!Array.isArray(fehler) || !ctx.length) return fehler;
  const page = norm(pageText);
  return fehler.filter(f => {
    const o = norm(f?.original);
    if (!o || page.includes(o)) return true;
    return !ctx.some(c => c.includes(o));
  });
}

module.exports = {
  NEIGHBOUR_EXCERPT_CHARS, lastParagraph, firstParagraph,
  findNeighbourPage, findPreviousPage, findNextPage, dropNeighbourFindings,
};
