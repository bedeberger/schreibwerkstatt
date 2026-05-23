#!/usr/bin/env node
'use strict';

// One-shot HubSpot-Blog-Import in ein bestehendes Buch.
// - Holt PUBLISHED-Posts via /cms/v3/blogs/posts, gruppiert nach Publish-Jahr
//   in Kapitel "YYYY", legt pro Post eine Page mit Name "YYYY-MM-DD: Titel" an.
// - Konvertiert post.postBody zu reinem Text (alle HTML-Tags weg, je Block
//   ein <p>…</p>).
// - Idempotent: existierende Page-Names werden uebersprungen.
// - Autor-Auswahl interaktiv, wenn --author-id fehlt.
// - User-Attribution via --user-email Pflicht (page_revisions.source='import').
//
// Usage:
//   HUBSPOT_TOKEN=pat-eu1-... node scripts/import-hubspot.js \
//     --book-id=102 --user-email=david.berger@dotag.ch \
//     [--author-id=12345] [--list-authors] [--dry-run] [--limit=N]

require('dotenv').config();

const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { parseHTML } = require('linkedom');
const contentStore = require('../lib/content-store');
const pageRevisions = require('../db/page-revisions');
const appUsers = require('../db/app-users');
const logger = require('../logger');

const HUBSPOT_BASE = 'https://api.hubapi.com';
const HUBSPOT_PAGE_SIZE = 100;

function parseArgs(argv) {
  const out = { dryRun: false, limit: Infinity, listAuthors: false, update: false };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--list-authors') out.listAuthors = true;
    else if (a === '--update') out.update = true;
    else if (a.startsWith('--book-id=')) out.bookId = parseInt(a.slice('--book-id='.length), 10);
    else if (a.startsWith('--author-id=')) out.authorId = a.slice('--author-id='.length);
    else if (a.startsWith('--user-email=')) out.userEmail = a.slice('--user-email='.length);
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice('--limit='.length), 10);
    else { console.error(`Unbekanntes Argument: ${a}`); process.exit(2); }
  }
  if (!out.listAuthors) {
    if (!Number.isFinite(out.bookId)) { console.error('--book-id=<int> Pflicht'); process.exit(2); }
    if (!out.userEmail) { console.error('--user-email=<addr> Pflicht'); process.exit(2); }
  }
  return out;
}

async function hubspotFetch(path, token, query = {}) {
  const url = new URL(HUBSPOT_BASE + path);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HubSpot ${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function listAuthors(token) {
  const out = [];
  let after;
  while (true) {
    const data = await hubspotFetch('/cms/v3/blogs/authors', token, { limit: 100, after });
    const results = Array.isArray(data?.results) ? data.results : [];
    out.push(...results);
    after = data?.paging?.next?.after;
    if (!after) break;
  }
  return out;
}

async function pickAuthorInteractive(token) {
  console.log('[hubspot-import] lade Autorenliste …');
  const authors = await listAuthors(token);
  if (!authors.length) { console.error('Keine Autoren in HubSpot gefunden.'); process.exit(2); }
  console.log(`\n${authors.length} Autoren gefunden:\n`);
  authors.forEach((a, i) => {
    const name = (a.fullName || a.displayName || a.name || '(ohne Name)').trim();
    const email = a.email ? ` <${a.email}>` : '';
    console.log(`  [${String(i + 1).padStart(3, ' ')}]  id=${a.id}  ${name}${email}`);
  });
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question('\nNummer waehlen (oder "q" zum Abbrechen): ')).trim();
  rl.close();
  if (answer.toLowerCase() === 'q') { console.log('Abgebrochen.'); process.exit(0); }
  const idx = parseInt(answer, 10);
  if (!Number.isFinite(idx) || idx < 1 || idx > authors.length) {
    console.error(`Ungueltige Auswahl: "${answer}"`); process.exit(2);
  }
  const chosen = authors[idx - 1];
  console.log(`[hubspot-import] gewaehlt: id=${chosen.id} (${chosen.fullName || chosen.name || '?'})\n`);
  return String(chosen.id);
}

async function* iterateAuthorPosts(token, authorId, hardLimit) {
  let after;
  let yielded = 0;
  while (yielded < hardLimit) {
    const data = await hubspotFetch('/cms/v3/blogs/posts', token, {
      blogAuthorId: authorId,
      state: 'PUBLISHED',
      limit: HUBSPOT_PAGE_SIZE,
      after,
    });
    const results = Array.isArray(data?.results) ? data.results : [];
    for (const p of results) {
      if (yielded >= hardLimit) return;
      yield p;
      yielded += 1;
    }
    after = data?.paging?.next?.after;
    if (!after) return;
  }
}

// HubSpot postBody → minimal-formatiertes HTML.
// Whitelist: Inline (strong, em, a[href], u) + Block (p, h2, h3, ul, ol, li,
// blockquote). h1 → h2, h4-h6 → h3 (Buch-Doku-Konvention). Alles andere wird
// gedroppt, dabei Textinhalt erhalten (Tag wird unwrappt).
const STRIP_SEL = [
  '.hs-cta-wrapper', '.hs-cta-img', '.hs-form',
  '.hs_cos_wrapper_meta_field', '.hs-embed-wrapper',
  'script', 'style', 'iframe', 'noscript',
  'img', 'figure', 'video', 'audio', 'svg', 'object', 'embed', 'canvas',
];

const INLINE_MAP = {
  STRONG: 'strong', B: 'strong',
  EM: 'em', I: 'em',
  U: 'u',
  A: 'a',
  BR: 'br',
};
const BLOCK_MAP = {
  P: 'p',
  H1: 'h2', H2: 'h2',
  H3: 'h3', H4: 'h3', H5: 'h3', H6: 'h3',
  UL: 'ul', OL: 'ol', LI: 'li',
  BLOCKQUOTE: 'blockquote',
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Rekursiver Serializer. node: DOM-Node. inline: true → Element ist in Inline-
// Kontext (z.B. innerhalb <p>); Block-Tags werden dann unwrappt.
function serializeNode(node, inline) {
  if (!node) return '';
  if (node.nodeType === 3) return escapeHtml(node.textContent || '');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName;
  const out = INLINE_MAP[tag];
  if (out) {
    const inner = serializeChildren(node, true);
    if (!inner.trim() && out !== 'br') return '';
    if (out === 'br') return '<br>';
    if (out === 'a') {
      const href = node.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) return inner; // unsichere/relative Links unwrappt
      return `<a href="${escapeAttr(href)}">${inner}</a>`;
    }
    return `<${out}>${inner}</${out}>`;
  }
  const blockOut = BLOCK_MAP[tag];
  if (blockOut) {
    if (inline) return serializeChildren(node, true); // Block in Inline-Kontext → unwrap
    const innerInline = (blockOut === 'ul' || blockOut === 'ol') ? false : true;
    const inner = serializeChildren(node, innerInline);
    if (!inner.trim()) return '';
    return `<${blockOut}>${inner}</${blockOut}>`;
  }
  // Unbekanntes Tag → unwrappen, Kinder behalten.
  return serializeChildren(node, inline);
}

function serializeChildren(parent, inline) {
  let out = '';
  for (const child of parent.childNodes) out += serializeNode(child, inline);
  if (inline) return out.replace(/\s+/g, ' ');
  return out;
}

function stripJinja(s) {
  return s.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/\{%[\s\S]*?%\}/g, '').replace(/\{#[\s\S]*?#\}/g, '');
}

function postBodyToText(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml.trim()) return '';
  rawHtml = stripJinja(rawHtml);
  const { document } = parseHTML(`<!doctype html><html><body>${rawHtml}</body></html>`);
  for (const sel of STRIP_SEL) {
    for (const el of Array.from(document.querySelectorAll(sel))) el.remove();
  }
  let html = serializeChildren(document.body, false).trim();
  // Wenn nach Strip nichts Block-artiges uebrig: ganzes Body als ein <p>.
  if (!/^<(p|h2|h3|ul|ol|blockquote)\b/i.test(html)) {
    const text = (document.body.textContent || '').replace(/\s+/g, ' ').trim();
    return text ? `<p>${escapeHtml(text)}</p>` : '';
  }
  return html;
}

function publishDateOf(post) {
  const raw = post.publishDate || post.created || post.updated;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function isoYmd(d) { return d.toISOString().slice(0, 10); }

async function loadExistingPagesByName(bookId) {
  const pages = await contentStore.listPages(bookId);
  const map = new Map();
  for (const p of pages) map.set(p.name || '', p.id);
  return map;
}

async function loadOrCreateYearChapter(bookId, year, cache, ctx, dryRun) {
  if (cache.has(year)) return cache.get(year);
  const chapters = await contentStore.listChapters(bookId);
  const existing = chapters.find(c => (c.name || '').trim() === year);
  if (existing) { cache.set(year, existing.id); return existing.id; }
  if (dryRun) { cache.set(year, `dry-${year}`); return `dry-${year}`; }
  const created = await contentStore.createChapter({ book_id: bookId, name: year }, ctx);
  cache.set(year, created.id);
  return created.id;
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { console.error('HUBSPOT_TOKEN env-var Pflicht (in .env oder Shell).'); process.exit(2); }

  if (args.listAuthors) {
    const authors = await listAuthors(token);
    console.log(`${authors.length} Autoren:\n`);
    for (const a of authors) {
      const name = (a.fullName || a.displayName || a.name || '(ohne Name)').trim();
      console.log(`  id=${a.id}  ${name}${a.email ? ` <${a.email}>` : ''}`);
    }
    process.exit(0);
  }

  const user = appUsers.getUser(args.userEmail);
  if (!user) { console.error(`User "${args.userEmail}" nicht in app_users gefunden.`); process.exit(2); }
  if (user.status && user.status !== 'active') {
    console.error(`User "${args.userEmail}" hat Status "${user.status}" (nicht active).`); process.exit(2);
  }
  const ctx = { session: { user: { email: user.email } } };

  const book = await contentStore.loadBook(args.bookId, ctx).catch(() => null);
  if (!book) { console.error(`Buch ${args.bookId} nicht gefunden.`); process.exit(2); }

  const authorId = args.authorId || await pickAuthorInteractive(token);

  console.log(`[hubspot-import] book=${args.bookId} (${book.name}) author=${authorId} user=${user.email} dryRun=${args.dryRun} update=${args.update}`);

  const existingByName = await loadExistingPagesByName(args.bookId);
  const yearCache = new Map();
  let imported = 0, updated = 0, skipped = 0, dropped = 0, total = 0;

  for await (const post of iterateAuthorPosts(token, authorId, args.limit)) {
    total += 1;
    const title = (post.htmlTitle || post.name || '').trim();
    const date = publishDateOf(post);
    if (!title || !date) { dropped += 1; logger.warn(`[hubspot-import] post ohne Titel/Datum (id=${post.id})`); continue; }
    const ymd = isoYmd(date);
    const pageName = `${ymd}: ${title}`;
    const existingId = existingByName.get(pageName);

    const text = postBodyToText(post.postBody || '');
    if (!text.trim()) { dropped += 1; logger.warn(`[hubspot-import] post ${post.id} leer nach text-extract`); continue; }

    if (existingId && !args.update) {
      skipped += 1; console.log(`  skip  ${pageName}`); continue;
    }

    if (existingId && args.update) {
      if (args.dryRun) {
        console.log(`  ~     ${pageName} (page=${existingId}, ${text.length} chars)`);
      } else {
        await contentStore.savePage(
          existingId,
          { html: text, source: 'import', summary: `HubSpot-Import (update): post ${post.id}` },
          ctx,
        );
        console.log(`  ~     ${pageName} (page=${existingId})`);
      }
      updated += 1;
      continue;
    }

    // Neu anlegen
    const year = String(date.getUTCFullYear());
    const chapterId = await loadOrCreateYearChapter(args.bookId, year, yearCache, ctx, args.dryRun);

    if (args.dryRun) {
      console.log(`  +     ${pageName} → chapter ${year} (${text.length} chars)`);
    } else {
      const created = await contentStore.createPage(
        { book_id: args.bookId, chapter_id: chapterId, name: pageName, html: text },
        ctx,
      );
      try {
        pageRevisions.insert({
          pageId: created.id,
          bookId: args.bookId,
          bodyHtml: created.html || text,
          bodyMarkdown: null,
          source: 'import',
          userEmail: user.email,
          summary: `HubSpot-Import: post ${post.id}`,
        });
      } catch (e) {
        logger.warn(`[hubspot-import] page_revisions insert failed page=${created.id}: ${e.message}`);
      }
      existingByName.set(pageName, created.id);
      console.log(`  +     ${pageName} → chapter ${year}`);
    }
    imported += 1;
  }

  console.log(`\n[hubspot-import] done. total=${total} imported=${imported} updated=${updated} skipped=${skipped} dropped=${dropped}`);
}

main().catch(err => {
  console.error('[hubspot-import] FATAL', err);
  process.exit(1);
});
