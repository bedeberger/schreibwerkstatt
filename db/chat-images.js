'use strict';
// Im Buch-Chat generierte Bilder (Weltaufbau-/Chat-Visualisierung). An die
// Chat-Session gebunden (CASCADE). Geschrieben vom Tool `generate_image`,
// gelesen von der Stream-Route GET /chat/image/:id. Siehe lib/image-gen.js.

const { db } = require('./connection');
const { NOW_ISO_SQL } = require('./now');

const _insert = db.prepare(`
  INSERT INTO chat_images (session_id, prompt, mime, size, image, created_at)
  VALUES (@session_id, @prompt, @mime, @size, @image, ${NOW_ISO_SQL})
`);

function insertChatImage({ sessionId, prompt, mime, size, image }) {
  const r = _insert.run({
    session_id: sessionId,
    prompt: prompt || '',
    mime: mime || 'image/png',
    size: size || '',
    image,
  });
  return r.lastInsertRowid;
}

// Bild + Owner-Email (ueber die Session) fuer den Owner-Check in der Stream-Route.
const _get = db.prepare(`
  SELECT ci.id, ci.session_id, ci.prompt, ci.mime, ci.size, ci.image, cs.user_email
  FROM chat_images ci
  JOIN chat_sessions cs ON cs.id = ci.session_id
  WHERE ci.id = ?
`);

function getChatImage(id) {
  return _get.get(id);
}

module.exports = { insertChatImage, getChatImage };
