'use strict';
// HubSpot ↔ App-HTML-Mapper.
//
// hubspotToAppHtml(rawHtml): HubSpot postBody (Voll-HTML mit CMS-Wrappern,
// CTAs, Embeds, evtl. Jinja-Marker) → minimal-formatiertes App-HTML. Bilder
// und Wrapper werden gestrippt; Whitelist:
//   Inline: strong/b, em/i, u, a[https-href], br
//   Block:  p, h1→h2, h2→h2, h3-h6→h3, ul, ol, li, blockquote
//
// appToHubspotHtml(html): App-Editor-HTML → HubSpot-konformes Markup. Selbe
// Whitelist, defensiv (auch wenn App-HTML kein <img> kennt) — verhindert
// versehentliches Mitschicken von Tags.

const { parseHTML } = require('linkedom');

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
  PRE: 'pre',
  HR: 'hr',
};

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _serializeNode(node, inline) {
  if (!node) return '';
  if (node.nodeType === 3) return escapeHtml(node.textContent || '');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName;
  const out = INLINE_MAP[tag];
  if (out) {
    const inner = _serializeChildren(node, true);
    if (!inner.trim() && out !== 'br') return '';
    if (out === 'br') return '<br>';
    if (out === 'a') {
      const href = node.getAttribute('href') || '';
      if (!/^https?:\/\//i.test(href)) return inner;
      return `<a href="${escapeAttr(href)}">${inner}</a>`;
    }
    return `<${out}>${inner}</${out}>`;
  }
  const blockOut = BLOCK_MAP[tag];
  if (blockOut) {
    if (blockOut === 'hr') return inline ? '' : '<hr>';
    if (inline) return _serializeChildren(node, true);
    if (blockOut === 'pre') {
      const raw = escapeHtml(node.textContent || '');
      if (!raw.trim()) return '';
      return `<pre>${raw}</pre>`;
    }
    const innerInline = !(blockOut === 'ul' || blockOut === 'ol');
    const inner = _serializeChildren(node, innerInline);
    if (!inner.trim()) return '';
    return `<${blockOut}>${inner}</${blockOut}>`;
  }
  return _serializeChildren(node, inline);
}

function _serializeChildren(parent, inline) {
  let out = '';
  for (const child of parent.childNodes) out += _serializeNode(child, inline);
  if (inline) return out.replace(/\s+/g, ' ');
  return out;
}

function _stripJinja(s) {
  return s.replace(/\{\{[\s\S]*?\}\}/g, '').replace(/\{%[\s\S]*?%\}/g, '').replace(/\{#[\s\S]*?#\}/g, '');
}

function hubspotToAppHtml(rawHtml) {
  if (typeof rawHtml !== 'string' || !rawHtml.trim()) return '';
  const stripped = _stripJinja(rawHtml);
  const { document } = parseHTML(`<!doctype html><html><body>${stripped}</body></html>`);
  for (const sel of STRIP_SEL) {
    for (const el of Array.from(document.querySelectorAll(sel))) el.remove();
  }
  const html = _serializeChildren(document.body, false).trim();
  if (!/^<(p|h2|h3|ul|ol|blockquote|pre|hr)\b/i.test(html)) {
    const text = (document.body.textContent || '').replace(/\s+/g, ' ').trim();
    return text ? `<p>${escapeHtml(text)}</p>` : '';
  }
  return html;
}

function appToHubspotHtml(html) {
  // App-HTML ist bereits Whitelist-konform (lib/html-clean.js am Save-Chokepoint).
  // Trotzdem defensiv durch denselben Serializer + STRIP_SEL schicken — schützt
  // gegen Drift oder direkte DB-Manipulation.
  return hubspotToAppHtml(html);
}

module.exports = {
  hubspotToAppHtml,
  appToHubspotHtml,
  // Für Tests/CLI-Re-Use:
  _internals: { STRIP_SEL, INLINE_MAP, BLOCK_MAP, escapeHtml, escapeAttr },
};
