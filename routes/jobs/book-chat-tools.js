'use strict';
// Re-Export der Facade aus dem book-chat-tools/-Subfolder. Konsumenten
// importieren weiterhin `./book-chat-tools` — Node resolved auf diese Datei,
// die wiederum aus `./book-chat-tools/index.js` re-exportiert.

module.exports = require('./book-chat-tools/index');
