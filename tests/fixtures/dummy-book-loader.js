'use strict';
// Parses tests/fixtures/dummy-book.md into a structured form:
//   { meta: { title, genre, language, contextText },
//     chapters: [{ title, pages: [{ title, markdown }] }] }
// Geteilt zwischen scripts/seed-dummy-book.js (BookStack-Upload) und den
// Integration-Tests (Mock-BookStack-Seeding). Beide nutzen dieselbe Quelle,
// damit lokales Dev-Buch und Test-Daten deckungsgleich bleiben.

const fs = require('fs');
const path = require('path');

const FIXTURE_PATH = path.join(__dirname, 'dummy-book.md');

const META = Object.freeze({
  title: 'Der Nebel über Luzern',
  genre: 'Krimi / Thriller',
  language: 'de-CH',
  contextText: 'Ermittlungsroman, Schauplatz Zentralschweiz (Luzern / Vierwaldstättersee). Erzählperspektive Ich-Erzählerin (Kommissarin Lea Brunner). Fokus auf Polizeialltag, Figurenbeziehungen, Alltagsdetails. Helvetismen erwünscht.',
});

function parseDummyBook(md = fs.readFileSync(FIXTURE_PATH, 'utf8')) {
  const cut = md.indexOf('# Fehler-Checkliste');
  const body = cut > 0 ? md.slice(0, cut) : md;

  const chapters = [];
  let currentChapter = null;
  let currentPage = null;
  let buffer = [];

  const flushPage = () => {
    if (currentPage && currentChapter) {
      currentPage.markdown = buffer.join('\n').trim();
      currentChapter.pages.push(currentPage);
    }
    currentPage = null;
    buffer = [];
  };

  for (const line of body.split('\n')) {
    const chapMatch = line.match(/^# Kapitel \d+ — (.+)$/);
    const pageMatch = line.match(/^## Seite [\d.]+:\s*(.+)$/);
    if (chapMatch) {
      flushPage();
      currentChapter = { title: `Kapitel ${chapters.length + 1} — ${chapMatch[1].trim()}`, pages: [] };
      chapters.push(currentChapter);
      continue;
    }
    if (pageMatch) {
      flushPage();
      currentPage = { title: pageMatch[1].trim() };
      continue;
    }
    if (currentPage) {
      if (line.trim() === '---') continue;
      buffer.push(line);
    }
  }
  flushPage();
  return { meta: META, chapters };
}

module.exports = { parseDummyBook, FIXTURE_PATH, META };
