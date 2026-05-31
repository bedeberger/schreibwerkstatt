'use strict';
// Markdown-Export. Bevorzugt `pages.body_markdown` (BookStack-Markdown-Source);
// Fallback ueber html-walker → simple Markdown-Renderer fuer Pages ohne MD-
// Spalte. Kein turndown-Dep — die App-eigenen Walker-Blocks decken den
// BookStack-WYSIWYG-Markup-Range (h1-h3/p/ul/ol/blockquote/pre/img/hr + inline
// strong/em/u/a) vollstaendig ab.

const { parseHtmlToBlocks } = require('../pdf-render/html-walker');
const { resolveTitle, chapterDepth, buildChaptersById } = require('./shared');

function _escMd(text) {
  return String(text || '').replace(/([_*`~])/g, '\\$1');
}

function _runsToMd(runs) {
  let out = '';
  for (const r of runs || []) {
    let t = r.text || '';
    if (t === '\n') { out += '  \n'; continue; }
    t = _escMd(t);
    if (r.bold)     t = `**${t}**`;
    if (r.italic)   t = `*${t}*`;
    if (r.link)     t = `[${t}](${r.link})`;
    out += t;
  }
  return out;
}

function _blockToMd(block, depth = 0) {
  switch (block.kind) {
    case 'heading': {
      const h = '#'.repeat(Math.min(6, block.level + depth));
      return `${h} ${_escMd(block.text || '')}\n\n`;
    }
    case 'paragraph':
      return `${_runsToMd(block.runs)}\n\n`;
    case 'list': {
      const marker = (i) => block.ordered ? `${i + 1}.` : '-';
      let out = '';
      block.items.forEach((itemBlocks, i) => {
        const inner = itemBlocks.map(b => _blockToMd(b, depth + 1)).join('').trimEnd();
        const indented = inner.replace(/\n/g, '\n  ');
        out += `${marker(i)} ${indented}\n`;
      });
      return out + '\n';
    }
    case 'blockquote': {
      const inner = (block.blocks || []).map(b => _blockToMd(b, depth)).join('').trimEnd();
      return inner.split('\n').map(l => `> ${l}`).join('\n') + '\n\n';
    }
    case 'poem': {
      const lines = (block.lines || []).map(_runsToMd);
      return lines.join('  \n') + '\n\n';
    }
    case 'image': {
      const alt = _escMd(block.alt || '');
      return `![${alt}](${block.src})\n\n`;
    }
    case 'hr':
      return '---\n\n';
    default:
      return '';
  }
}

function _htmlToMd(html) {
  if (!html) return '';
  try {
    const blocks = parseHtmlToBlocks(html);
    return blocks.map(b => _blockToMd(b)).join('').trimEnd();
  } catch {
    return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }
}

function _pageMd(page) {
  if (page?.markdown && page.markdown.trim()) return page.markdown.trim();
  return _htmlToMd(page?.html || '');
}

function buildMd({ scope, book, chapter, page, groups }) {
  const out = [];
  const title = resolveTitle({ scope, book, chapter, page });
  if (title) out.push(`# ${_escMd(title)}`, '');

  const byId = buildChaptersById(groups);
  for (const g of groups) {
    const ch = g.chapter;
    if (ch && (scope === 'book' || scope === 'chapter')) {
      const d = chapterDepth(ch, byId);
      out.push(`${'#'.repeat(Math.min(6, d + 1))} ${_escMd(ch.name)}`, '');
    }
    const includePageHeadings = scope === 'book' && ch && g.pages.length > 1;
    for (const x of g.pages) {
      if (includePageHeadings) {
        const d = chapterDepth(ch, byId);
        out.push(`${'#'.repeat(Math.min(6, d + 2))} ${_escMd(x.p.name)}`, '');
      }
      const body = _pageMd(x.pd);
      if (body) out.push(body, '');
    }
  }
  return Buffer.from(out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n', 'utf8');
}

module.exports = { buildMd };
