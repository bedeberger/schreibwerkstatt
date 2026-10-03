'use strict';
// Gemeinsame Handler-Bausteine der Plot-Routen (routes/plot.js): Besitz-/ACL-
// Vorspann, Eingabe-Parser und die Anker-Anreicherung der Beat-Antworten. Kein
// Router — reine Funktionen, die die Fehler-Response bei Bedarf selbst senden.

const plotDb = require('../db/plot');
const { toIntId } = require('../lib/validate');
const { resolveChapterBookId } = require('../lib/content-ownership');
const { guardBook, sessionEmail } = require('../lib/acl');
const appSettings = require('../lib/app-settings');

// Entity per :id laden + Owner (user_email) + Buch-ACL prüfen. Gibt die Entity
// zurück oder null (die passende Fehler-Response wurde dann bereits gesendet).
// SSoT für die sonst in jedem :id-Handler (Akt/Beat/Thread/Run) wiederholte
// Login-/ID-/Owner-/Guard-Kette.
// Der Login-Check steht VOR dem Guard, weil der Besitz über die E-Mail geprüft
// wird — ohne ihn erschiene „nicht angemeldet" als 404. Gleicher Code wie der Guard.
function _loadOwned(req, res, getFn, notFoundCode) {
  const userEmail = sessionEmail(req);
  if (!userEmail) { res.status(401).json({ error_code: 'NOT_LOGGED_IN' }); return null; }
  const id = toIntId(req.params.id);
  if (!id) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  const row = getFn(id);
  if (!row || row.user_email !== userEmail) { res.status(404).json({ error_code: notFoundCode }); return null; }
  if (!guardBook(req, res, row.book_id, 'editor')) return null;
  return row;
}

// Book-skopierte Collection-Handler (kein :id): Login + book_id + ACL-Guard in
// einem Schritt. Gibt { userEmail, bookId } zurück oder null (die passende
// Fehler-Response wurde dann bereits gesendet). Pendant zu _loadOwned für die
// :id-Handler — SSoT für die sonst in jedem GET-Collection-Handler wiederholte
// book_id-/Guard-Kette (den Login prüft der Guard). Der Guard läuft VOR handler-spezifischen
// Zusatz-Validierungen (z.B. draft_id) — kein Leak an nicht-autorisierte Aufrufer.
function _requireBook(req, res) {
  const bookId = toIntId(req.query.book_id);
  if (!bookId) { res.status(400).json({ error_code: 'INVALID_ID' }); return null; }
  if (!guardBook(req, res, bookId, 'editor')) return null;
  return { userEmail: sessionEmail(req), bookId };
}

// chapter_id muss zum Buch gehören, sonst NULL (kein Fremd-Verweis).
function _validChapterId(bookId, chapterId) {
  if (!chapterId) return null;
  return resolveChapterBookId(chapterId) === bookId ? parseInt(chapterId, 10) : null;
}

// Spannungswert (1–5) für den Spannungsbogen. undefined = ungültig (→ 400
// INVALID_INTENSITAET), null = leeren. Ganzzahl oder Ziffern-String, sonst nichts.
function _parseIntensitaet(raw) {
  if (raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw
    : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN);
  return (Number.isInteger(n) && n >= 1 && n <= 5) ? n : undefined;
}

// 0/1-Flag (verworfen, archiviert): nur true/false/0/1 — alles andere ist ein
// Client-Fehler (→ 400 INVALID_FLAG), kein stilles truthy-Casting ("false" → 1).
function _parseFlag(raw) {
  if (raw === true || raw === 1) return 1;
  if (raw === false || raw === 0) return 0;
  return undefined;
}

// Anker-Felder (occ_count, occ_top) wie im Board-Payload — derselbe Lese-Filter
// (Score-Floor + nur anspringbare Fundstellen), damit das Drift-Badge nach
// POST/PATCH dieselbe Zahl zeigt wie nach dem nächsten GET /plot.
function _anchorOpts() {
  return { minScore: Number(appSettings.get('plot.anchor.min_score')) || 0, navigableOnly: true };
}
function _withAnchor(beat, occ) {
  if (!beat) return beat;
  const e = occ || plotDb.beatOccurrenceEntry(beat.id, _anchorOpts());
  return { ...beat, occ_count: e ? e.count : 0, occ_top: e ? e.top : [] };
}

// Figuren-Bindung eines Strangs auflösen + aufs (Buch, User)-Subset validieren.
// figure_id kommt als TEXT-fig_id (Frontend-Identität) → INTEGER figures.id;
// draft_figure_id ist bereits INTEGER draft_figures.id. Fremd/leer → null.
function _resolveThreadFigure(bookId, userEmail, rawFigId) {
  return rawFigId ? (plotDb.resolveFigureIds(bookId, userEmail, [rawFigId])[0] || null) : null;
}
function _resolveThreadDraftFigure(bookId, userEmail, rawDraftId) {
  return rawDraftId ? (plotDb.resolveDraftFigureIds(bookId, userEmail, [rawDraftId])[0] || null) : null;
}

module.exports = {
  _loadOwned, _requireBook, _validChapterId, _parseIntensitaet, _parseFlag,
  _anchorOpts, _withAnchor, _resolveThreadFigure, _resolveThreadDraftFigure,
};
