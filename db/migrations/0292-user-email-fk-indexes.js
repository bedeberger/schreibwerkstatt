'use strict';
// Indexe auf FK-Spalten `user_email`, die bisher keinen eigenen hatten. In allen
// vier Tabellen steht `user_email` im PRIMARY KEY, aber nicht vorn — der PK-Index
// hilft darum weder dem ON DELETE CASCADE von app_users(email) (Konto-Löschung
// scannt sonst die ganze Tabelle) noch Abfragen „alles von User X".

module.exports = {
  version: 292,
  up(db) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_book_presence_user_email         ON book_presence(user_email);
      CREATE INDEX IF NOT EXISTS idx_page_presence_user_email         ON page_presence(user_email);
      CREATE INDEX IF NOT EXISTS idx_figure_age_scans_user_email      ON figure_age_scans(user_email);
      CREATE INDEX IF NOT EXISTS idx_chapter_extract_cache_user_email ON chapter_extract_cache(user_email);
    `);
  },
};
