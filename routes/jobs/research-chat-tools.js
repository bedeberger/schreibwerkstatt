'use strict';
// Werkzeuge für den agentischen Recherche-Chat (Claude-only, mit Web-Suche).
// Rückwärtsgewandt: liest vorhandenes Material + Buch-Entitäten und SAMMELT
// Vorschläge — schreibt NIE Buchtext und persistiert NICHTS automatisch.
//
// `web_search` ist Anthropics serverseitiges Tool und hat hier KEINEN Handler —
// die API führt es selbst aus (siehe lib/ai.js: server_tool_use wird nicht an den
// Caller durchgereicht). `propose_research_item` sammelt nur in ctx.proposals;
// der User bestätigt jeden Vorschlag im Frontend (POST /research).
//
// ctx = { bookId, userEmail, jobSignal, logger, proposals: [] }

const { db } = require('../../db/schema');
const { _truncateResult } = require('./book-chat-tools/shared');
const searchIndex = require('../../lib/search');

const ITEM_LIST_MAX = 60;
const SNIPPET_MAX = 220;
const DOC_TEXT_MAX = 8000;
const PROPOSAL_TITLE_MAX = 300;
const PROPOSAL_BODY_MAX = 20000;
const PROPOSAL_URL_MAX = 2000;
const PROPOSAL_URL_LABEL_MAX = 300;
const PROPOSAL_MAX_URLS = 20;
const PROPOSAL_SOURCE_MAX = 1000;
const MAX_PROPOSALS = 12;

const _snip = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// ── list_research_items ──────────────────────────────────────────────────────
function tool_list_research_items(input, ctx) {
  const where = ['ri.book_id = ?', 'ri.archived = 0'];
  const vals = [ctx.bookId];
  const KINDS = new Set(['note', 'link', 'quote', 'fact', 'image', 'document']);
  if (KINDS.has(input.kind)) { where.push('ri.kind = ?'); vals.push(input.kind); }

  const q = String(input.q || '').trim();
  if (q) {
    try {
      const hits = searchIndex.query(q, { bookId: ctx.bookId, kinds: ['research'], limit: 200 });
      const ids = (hits?.hits || []).map(h => h.entity_id).filter(Boolean);
      if (!ids.length) return { items: [], count: 0 };
      where.push(`ri.id IN (${ids.map(() => '?').join(',')})`);
      vals.push(...ids);
    } catch (e) {
      ctx.logger?.warn?.(`[research-chat] FTS-Filter fehlgeschlagen: ${e.message}`);
    }
  }

  const rows = db.prepare(
    `SELECT ri.id, ri.kind, ri.title, ri.body, ri.source, ri.doc_name,
            (ri.doc_mime IS NOT NULL) AS has_doc
       FROM research_items ri
      WHERE ${where.join(' AND ')}
      ORDER BY ri.pinned DESC, ri.updated_at DESC
      LIMIT ${ITEM_LIST_MAX}`
  ).all(...vals);

  const idPh = rows.length ? rows.map(() => '?').join(',') : '';
  const tagRows = rows.length
    ? db.prepare(`SELECT item_id, tag FROM research_item_tags WHERE item_id IN (${idPh})`).all(...rows.map(r => r.id))
    : [];
  const tagsBy = new Map();
  for (const t of tagRows) { if (!tagsBy.has(t.item_id)) tagsBy.set(t.item_id, []); tagsBy.get(t.item_id).push(t.tag); }

  const urlRows = rows.length
    ? db.prepare(`SELECT item_id, url FROM research_item_urls WHERE item_id IN (${idPh}) ORDER BY item_id, position, id`).all(...rows.map(r => r.id))
    : [];
  const urlsBy = new Map();
  for (const u of urlRows) { if (!urlsBy.has(u.item_id)) urlsBy.set(u.item_id, []); urlsBy.get(u.item_id).push(u.url); }

  const items = rows.map(r => {
    const urls = urlsBy.get(r.id) || [];
    return {
      id: r.id,
      kind: r.kind,
      title: r.title || '',
      snippet: _snip(r.body || urls[0] || r.source, SNIPPET_MAX),
      tags: tagsBy.get(r.id) || [],
      url_count: urls.length,
      has_doc: !!r.has_doc,
      ...(r.doc_name ? { doc_name: r.doc_name } : {}),
    };
  });
  return { items, count: items.length };
}

// ── read_research_item ───────────────────────────────────────────────────────
function tool_read_research_item(input, ctx) {
  const id = parseInt(input.id, 10);
  if (!id) return { error: 'id fehlt oder ungültig.' };
  const row = db.prepare(
    `SELECT id, kind, title, body, source, doc_name, doc_text
       FROM research_items WHERE id = ? AND book_id = ?`
  ).get(id, ctx.bookId);
  if (!row) return { error: 'Eintrag nicht gefunden.' };
  const tags = db.prepare('SELECT tag FROM research_item_tags WHERE item_id = ? ORDER BY tag').all(id).map(t => t.tag);
  const urls = db.prepare('SELECT url, label FROM research_item_urls WHERE item_id = ? ORDER BY position, id')
    .all(id).map(u => ({ url: u.url, label: u.label || '' }));
  return {
    id: row.id,
    kind: row.kind,
    title: row.title || '',
    body: row.body || '',
    urls,
    source: row.source || '',
    tags,
    ...(row.doc_name ? { doc_name: row.doc_name } : {}),
    ...(row.doc_text ? { doc_text: String(row.doc_text).slice(0, DOC_TEXT_MAX) } : {}),
  };
}

// ── list_book_entities ───────────────────────────────────────────────────────
const ENTITY_QUERIES = {
  figur:  'SELECT id, name AS label, typ, rolle, beschreibung FROM figures WHERE book_id = ? AND user_email = ? AND COALESCE(stale,0) = 0 ORDER BY sort_order, name',
  ort:    'SELECT id, name AS label, typ, land, beschreibung FROM locations WHERE book_id = ? AND user_email = ? ORDER BY sort_order, name',
  szene:  'SELECT id, titel AS label, kommentar FROM figure_scenes WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel',
  beat:   'SELECT id, titel AS label, beschreibung FROM plot_beats WHERE book_id = ? AND user_email = ? ORDER BY sort_order, titel',
  strang: 'SELECT id, name AS label FROM plot_threads WHERE book_id = ? AND user_email = ? ORDER BY position, name',
};
const ENTITY_LIMIT = 120;

function _entityList(art, ctx) {
  const sql = ENTITY_QUERIES[art];
  if (!sql) return [];
  return db.prepare(sql).all(ctx.bookId, ctx.userEmail || null).slice(0, ENTITY_LIMIT).map(r => {
    const meta = [_snip(r.typ, 40), _snip(r.rolle || r.land, 40), _snip(r.beschreibung || r.kommentar, 140)]
      .filter(Boolean).join(' · ');
    return { id: r.id, name: r.label, ...(meta ? { kontext: meta } : {}) };
  });
}

function tool_list_book_entities(input, ctx) {
  const art = ['figur', 'ort', 'szene', 'beat', 'strang'].includes(input.art) ? input.art : 'alle';
  if (art !== 'alle') return { art, entities: _entityList(art, ctx) };
  return {
    figuren:        _entityList('figur', ctx),
    schauplaetze:   _entityList('ort', ctx),
    szenen:         _entityList('szene', ctx),
    plot_abschnitte: _entityList('beat', ctx),
    handlungsstraenge: _entityList('strang', ctx),
  };
}

// ── propose_research_item ────────────────────────────────────────────────────
// Persistiert NICHTS — sammelt nur in ctx.proposals; der User bestätigt im Frontend.
function tool_propose_research_item(input, ctx) {
  const KINDS = new Set(['note', 'link', 'quote', 'fact']);
  const kind = KINDS.has(input.kind) ? input.kind : 'note';
  const title = _snip(input.title, PROPOSAL_TITLE_MAX);
  const body = String(input.body || '').trim().slice(0, PROPOSAL_BODY_MAX);
  const source = _snip(input.source, PROPOSAL_SOURCE_MAX);
  const tags = Array.isArray(input.tags)
    ? input.tags.map(t => _snip(t, 60)).filter(Boolean).slice(0, 20)
    : [];

  // urls: Array von { url, label? } (oder reine URL-Strings). http(s)-only
  // (XSS/Schema-Schutz beim späteren :href-Binding), je URL einmal.
  const seenUrls = new Set();
  const urls = [];
  let hadBadUrl = false;
  for (const raw of (Array.isArray(input.urls) ? input.urls : [])) {
    const u = _snip(typeof raw === 'string' ? raw : raw?.url, PROPOSAL_URL_MAX);
    if (!u) continue;
    if (!/^https?:\/\//i.test(u)) { hadBadUrl = true; continue; }
    if (seenUrls.has(u)) continue;
    seenUrls.add(u);
    const label = typeof raw === 'object' ? _snip(raw?.label, PROPOSAL_URL_LABEL_MAX) : '';
    urls.push({ url: u, label });
    if (urls.length >= PROPOSAL_MAX_URLS) break;
  }

  if (!title && !body && !urls.length) {
    return { ok: false, error: 'Vorschlag braucht mindestens Titel, Inhalt oder eine URL.' };
  }
  if (hadBadUrl && !urls.length) return { ok: false, error: 'URLs müssen mit http:// oder https:// beginnen.' };

  if ((ctx.proposals?.length || 0) >= MAX_PROPOSALS) {
    return { ok: false, error: `Maximal ${MAX_PROPOSALS} Vorschläge pro Antwort.` };
  }
  const proposal = { kind, title, body, urls, source, tags };
  ctx.proposals.push(proposal);
  return { ok: true, accepted_as_proposal: true, kind, title: title || urls[0]?.url || _snip(body, 60) };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
const TOOLS = {
  list_research_items: tool_list_research_items,
  read_research_item:  tool_read_research_item,
  list_book_entities:  tool_list_book_entities,
  propose_research_item: tool_propose_research_item,
};

async function executeResearchTool(name, input, ctx) {
  const fn = TOOLS[name];
  if (!fn) throw new Error(`Unbekanntes Werkzeug: ${name}`);
  const result = await fn(input || {}, ctx);
  return _truncateResult(result);
}

module.exports = { executeResearchTool, TOOLS };
