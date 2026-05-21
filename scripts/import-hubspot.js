#!/usr/bin/env node
'use strict';

// One-shot HubSpot-Blog-Import in ein bestehendes Buch.
// Holt PUBLISHED-Posts via /cms/v3/blogs/posts, gruppiert nach Publish-Jahr
// in Kapitel "YYYY", legt pro Post eine Page mit Name "YYYY-MM-DD: Titel" an.
// Idempotent: Posts mit existierendem Page-Name werden uebersprungen.
//
// Usage:
//   HUBSPOT_TOKEN=pat-eu1-... node scripts/import-hubspot.js \
//     --book-id=102 --author-id=12345 [--dry-run] [--limit=N]

require('dotenv').config();

const { parseHTML } = require('linkedom');
const contentStore = require('../lib/content-store');
const logger = require('../logger');

const HUBSPOT_BASE = 'https://api.hubapi.com';
const HUBSPOT_PAGE_SIZE = 100;

function parseArgs(argv) {
  const out = { dryRun: false, limit: Infinity };
  for (const a of argv.slice(2)) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--book-id=')) out.bookId = parseInt(a.slice('--book-id='.length), 10);
    else if (a.startsWith('--author-id=')) out.authorId = a.slice('--author-id='.length);
    else if (a.startsWith('--limit=')) out.limit = parseInt(a.slice('--limit='.length), 10);
    else { console.error(`Unbekanntes Argument: ${a}`); process.exit(2); }
  }
  if (!Number.isFinite(out.bookId)) { console.error('--book-id=<int> Pflicht'); process.exit(2); }
  if (!out.authorId) { console.error('--author-id=<id> Pflicht'); process.exit(2); }
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

// HubSpot-spezifische Cruft strippen, bevor content-store-Cleaner laeuft.
// Entfernt CTA-Wrapper, Forms, eingebettete Meta-Felder, Tracking-Pixel,
// script/style/iframe-Tags. Inline-Formatting (<strong>, <em>, <a>) bleibt.
const STRIP_SELECTORS = [
  '.hs-cta-wrapper',
  '.hs-cta-img',
  '.hs-form',
  '.hs_cos_wrapper_meta_field',
  '.hs-embed-wrapper',
  'script',
  'style',
  'iframe',
  'noscript',
];

function stripHubspotCruft(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml.trim()) return '';
  const { document } = parseHTML(`<!doctype html><html><body>${rawHtml}</body></html>`);
  for (const sel of STRIP_SELECTORS) {
    for (const el of Array.from(document.querySelectorAll(sel))) el.remove();
  }
  // Tracking-Pixel: 1x1-images mit pixel/track in src
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = img.getAttribute('src') || '';
    if (/\/(track|pixel)/i.test(src) || /\bwidth=["']?1\b/.test(img.outerHTML)) img.remove();
  }
  return document.body.innerHTML;
}

function publishDateOf(post) {
  const raw = post.publishDate || post.created || post.updated;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function isoYmd(d) {
  return d.toISOString().slice(0, 10);
}

async function loadExistingPageNames(bookId) {
  const pages = await contentStore.listPages(bookId);
  return new Set(pages.map(p => p.name || ''));
}

async function loadOrCreateYearChapter(bookId, year, cache, dryRun) {
  if (cache.has(year)) return cache.get(year);
  const chapters = await contentStore.listChapters(bookId);
  const existing = chapters.find(c => (c.name || '').trim() === year);
  if (existing) { cache.set(year, existing.id); return existing.id; }
  if (dryRun) { cache.set(year, `dry-${year}`); return `dry-${year}`; }
  const created = await contentStore.createChapter({ book_id: bookId, name: year });
  cache.set(year, created.id);
  return created.id;
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env.HUBSPOT_TOKEN;
  if (!token) { console.error('HUBSPOT_TOKEN env-var Pflicht (in .env oder Shell).'); process.exit(2); }

  const book = await contentStore.loadBook(args.bookId).catch(() => null);
  if (!book) { console.error(`Buch ${args.bookId} nicht gefunden.`); process.exit(2); }

  console.log(`[hubspot-import] book=${args.bookId} (${book.name}) author=${args.authorId} dryRun=${args.dryRun}`);

  const existingNames = await loadExistingPageNames(args.bookId);
  const yearCache = new Map();
  let imported = 0, skipped = 0, dropped = 0, total = 0;

  for await (const post of iterateAuthorPosts(token, args.authorId, args.limit)) {
    total += 1;
    const title = (post.htmlTitle || post.name || '').trim();
    const date = publishDateOf(post);
    if (!title || !date) { dropped += 1; logger.warn(`[hubspot-import] post ohne Titel/Datum (id=${post.id})`); continue; }
    const ymd = isoYmd(date);
    const pageName = `${ymd}: ${title}`;
    if (existingNames.has(pageName)) { skipped += 1; console.log(`  skip  ${pageName}`); continue; }

    const year = String(date.getUTCFullYear());
    const chapterId = await loadOrCreateYearChapter(args.bookId, year, yearCache, args.dryRun);

    const cleaned = stripHubspotCruft(post.postBody || '');
    if (!cleaned.trim()) { dropped += 1; logger.warn(`[hubspot-import] post ${post.id} leer nach cleanup`); continue; }

    if (args.dryRun) {
      console.log(`  +     ${pageName} → chapter ${year} (${cleaned.length} chars)`);
    } else {
      await contentStore.createPage({ book_id: args.bookId, chapter_id: chapterId, name: pageName, html: cleaned });
      console.log(`  +     ${pageName} → chapter ${year}`);
    }
    existingNames.add(pageName);
    imported += 1;
  }

  console.log(`\n[hubspot-import] done. total=${total} imported=${imported} skipped=${skipped} dropped=${dropped}`);
}

main().catch(err => {
  console.error('[hubspot-import] FATAL', err);
  process.exit(1);
});
