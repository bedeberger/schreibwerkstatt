'use strict';
// Validiert die `zitate`-Liste eines final_answer-Calls gegen den aktuellen
// Seitentext. Wird vom Loop in chat.js aufgerufen, NICHT als Tool registriert.

const { db } = require('../../../db/schema');
const contentStore = require('../../../lib/content-store');
const { htmlToPlainText } = require('../../../lib/html-text');

async function validateFinalAnswerCitations(zitate, ctx) {
  if (!Array.isArray(zitate) || !zitate.length) return [];
  if (!ctx?.userToken) {
    return zitate.map(z => ({ ...z, valid: false, reason: 'no_user_token' }));
  }
  const cache = new Map(); // page_id → plain text
  const out = [];
  for (const z of zitate) {
    const pageId = z?.page_id;
    const offset = z?.offset;
    const length = z?.length;
    const quote  = typeof z?.quote === 'string' ? z.quote : null;
    if (!Number.isInteger(pageId) || !Number.isInteger(offset) || !Number.isInteger(length)) {
      out.push({ page_id: pageId ?? null, valid: false, reason: 'bad_shape' });
      continue;
    }
    if (ctx.jobSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const pageRow = db.prepare(
      'SELECT page_id, book_id FROM pages WHERE page_id = ?'
    ).get(pageId);
    if (!pageRow || pageRow.book_id !== ctx.bookId) {
      out.push({ page_id: pageId, valid: false, reason: 'page_not_in_book' });
      continue;
    }
    let text = cache.get(pageId);
    if (text == null) {
      try {
        const pd = await contentStore.loadPage(pageId, ctx.userToken);
        text = htmlToPlainText(pd.html || '');
        cache.set(pageId, text);
      } catch (e) {
        out.push({ page_id: pageId, valid: false, reason: `load_failed: ${e.message}` });
        continue;
      }
    }
    if (offset < 0 || offset + length > text.length) {
      out.push({ page_id: pageId, offset, length, valid: false, reason: 'out_of_range', page_chars: text.length });
      continue;
    }
    const actual = text.slice(offset, offset + length);
    const valid  = quote == null ? true : actual === quote;
    out.push({
      page_id: pageId,
      offset,
      length,
      valid,
      ...(valid ? {} : { reason: 'quote_mismatch', expected: quote, actual }),
    });
  }
  return out;
}

module.exports = { validateFinalAnswerCitations };
