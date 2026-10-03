'use strict';
// Feedback (Daumen hoch/runter) pro Assistant-Antwort in allen Chats
// (Seiten-, Buch-, Recherche-Chat; docs/chats.md). Eine Zeile pro Antwort,
// darum Spalten an chat_messages statt eigener Tabelle: das Feedback gehoert
// genau einer Nachricht, faellt mit ihr (Session-Loeschung → CASCADE) und hat
// keinen eigenen Konto-Bezug (Besitzer ist chat_sessions.user_email).
//
// `feedback` ist +1 / -1 oder NULL (= keins bzw. zurueckgenommen);
// `feedback_at` ist der Zeitpunkt der letzten Aenderung (ISO+Z).

module.exports = {
  version: 298,
  up(db) {
    db.exec(`ALTER TABLE chat_messages ADD COLUMN feedback INTEGER CHECK (feedback IN (-1, 1))`);
    db.exec(`ALTER TABLE chat_messages ADD COLUMN feedback_at TEXT`);
  },
};
