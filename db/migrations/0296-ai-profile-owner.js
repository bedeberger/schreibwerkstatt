'use strict';
// Eigener KI-Zugang pro Konto: ein KI-Profil kann einem Konto GEHOEREN
// (`owner_email`) statt vom Admin zugewiesen zu sein. Ein Konto hat hoechstens
// einen eigenen Zugang (Unique-Index). CASCADE: der Zugang traegt den
// verschluesselten API-Key des Kontos und ist ohne sein Konto wertlos.
// Admin-Profile behalten `owner_email = NULL`.

module.exports = {
  version: 296,
  up(db) {
    db.exec(`
      ALTER TABLE ai_profiles ADD COLUMN owner_email TEXT REFERENCES app_users(email) ON DELETE CASCADE;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_profiles_owner_email ON ai_profiles(owner_email);
    `);
  },
};
