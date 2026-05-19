'use strict';

// AbiWord-Parser (.abw). Format ist XML mit <abiword>/<section>/<p>/<c>. Wir
// lesen Style-Namen aus <styles>/<s> + Inline-Props (font-weight:bold,
// font-style:italic) und mappen auf schlankes HTML (h1..h3, p, strong, em).

const { parseHTML } = require('linkedom');

function _hasBold(propsStr, styleProps) {
  const s = (propsStr || '') + ';' + (styleProps || '');
  return /font-weight\s*:\s*(bold|[6-9]00)/i.test(s);
}

function _hasItalic(propsStr, styleProps) {
  const s = (propsStr || '') + ';' + (styleProps || '');
  return /font-style\s*:\s*(italic|oblique)/i.test(s);
}

function _styleFromName(styleMap, name) {
  if (!name) return null;
  return styleMap.get(name) || null;
}

function _headingLevelFromStyle(name) {
  if (!name) return 0;
  const m = /heading\s*(\d+)/i.exec(name);
  if (m) return Math.min(3, Math.max(1, parseInt(m[1], 10)));
  if (/^title$/i.test(name)) return 1;
  return 0;
}

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _walkInline(node, styleMap) {
  if (!node) return '';
  if (node.nodeType === 3) return _esc(node.textContent || '');
  if (node.nodeType !== 1) return '';
  const tag = (node.nodeName || '').toLowerCase();
  if (tag === 'br') return '<br>';
  if (tag === 'c') {
    const props = node.getAttribute('props') || '';
    const styleName = node.getAttribute('style') || '';
    const styleProps = _styleFromName(styleMap, styleName)?.props || '';
    let inner = _childrenInline(node, styleMap);
    if (_hasBold(props, styleProps))   inner = `<strong>${inner}</strong>`;
    if (_hasItalic(props, styleProps)) inner = `<em>${inner}</em>`;
    return inner;
  }
  if (tag === 'a') {
    const href = node.getAttribute('xlink:href') || node.getAttribute('href') || '';
    const inner = _childrenInline(node, styleMap);
    return href ? `<a href="${_esc(href)}">${inner}</a>` : inner;
  }
  return _childrenInline(node, styleMap);
}

function _childrenInline(node, styleMap) {
  let out = '';
  for (const c of node.childNodes) out += _walkInline(c, styleMap);
  return out;
}

function _collectStyles(doc) {
  const map = new Map();
  const ss = doc.getElementsByTagName('s');
  for (const s of Array.from(ss)) {
    const name = s.getAttribute('name');
    if (!name) continue;
    map.set(name, {
      props: s.getAttribute('props') || '',
      type: s.getAttribute('type') || '',
    });
  }
  return map;
}

async function parseAbw(buffer) {
  const warnings = [];
  const xml = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
  const { document } = parseHTML(xml);
  const styleMap = _collectStyles(document);

  const sections = document.getElementsByTagName('section');
  if (!sections.length) return { html: '<p></p>', warnings };

  let html = '';
  for (const section of Array.from(sections)) {
    for (const node of section.childNodes) {
      if (node.nodeType !== 1) continue;
      const tag = (node.nodeName || '').toLowerCase();
      if (tag === 'p') {
        const styleName = node.getAttribute('style') || '';
        const level = _headingLevelFromStyle(styleName);
        const inner = _childrenInline(node, styleMap).trim();
        if (level > 0) {
          html += `<h${level}>${inner}</h${level}>`;
        } else if (inner) {
          html += `<p>${inner}</p>`;
        } else {
          html += '<p></p>';
        }
      } else if (tag === 'image' || tag === 'd') {
        warnings.push({ code: 'IMAGES_DROPPED', count: 1 });
      }
    }
  }

  if (!html) html = '<p></p>';

  const dropped = warnings.filter(w => w.code === 'IMAGES_DROPPED').reduce((s, w) => s + (w.count || 0), 0);
  const merged = warnings.filter(w => w.code !== 'IMAGES_DROPPED');
  if (dropped) merged.push({ code: 'IMAGES_DROPPED', count: dropped });

  return { html, warnings: merged };
}

module.exports = { parseAbw };
