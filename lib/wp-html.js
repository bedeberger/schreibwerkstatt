const { parseHTML } = require('linkedom');
const { cleanPageHtml } = require('./html-clean');

const WP_COMMENT_RE = /<!--\s*\/?\s*wp:[^>]*-->/g;

function _parseRoot(html) {
  const wrapped = `<!DOCTYPE html><html><body><div id="r">${html}</div></body></html>`;
  const { document } = parseHTML(wrapped);
  return document.getElementById('r');
}

function wpToAppHtml(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const html = raw.replace(WP_COMMENT_RE, '');
  const root = _parseRoot(html);
  if (!root) return '';

  root.querySelectorAll('figure, img, picture, video, audio, iframe, embed, object').forEach(n => n.remove());
  root.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
  root.querySelectorAll('[class]').forEach(n => {
    const keep = (n.getAttribute('class') || '')
      .split(/\s+/)
      .filter(c => c && !/^wp-/.test(c) && !/^has-/.test(c) && !/^is-style-/.test(c))
      .join(' ');
    if (keep) n.setAttribute('class', keep);
    else n.removeAttribute('class');
  });

  return cleanPageHtml(root.innerHTML);
}

function _serializeInline(node) {
  return node.innerHTML;
}

function _wrapBlock(el) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  switch (tag) {
    case 'p':
      return `<!-- wp:paragraph -->\n<p>${_serializeInline(el)}</p>\n<!-- /wp:paragraph -->`;
    case 'h1':
      return `<!-- wp:heading {"level":1} -->\n<h1 class="wp-block-heading">${_serializeInline(el)}</h1>\n<!-- /wp:heading -->`;
    case 'h2':
      return `<!-- wp:heading -->\n<h2 class="wp-block-heading">${_serializeInline(el)}</h2>\n<!-- /wp:heading -->`;
    case 'h3':
      return `<!-- wp:heading {"level":3} -->\n<h3 class="wp-block-heading">${_serializeInline(el)}</h3>\n<!-- /wp:heading -->`;
    case 'h4':
      return `<!-- wp:heading {"level":4} -->\n<h4 class="wp-block-heading">${_serializeInline(el)}</h4>\n<!-- /wp:heading -->`;
    case 'ul':
    case 'ol': {
      const ordered = tag === 'ol';
      const attrs = ordered ? ' {"ordered":true}' : '';
      const itemHtml = Array.from(el.children)
        .filter(c => c.tagName && c.tagName.toLowerCase() === 'li')
        .map(li => `<!-- wp:list-item -->\n<li>${_serializeInline(li)}</li>\n<!-- /wp:list-item -->`)
        .join('\n');
      const wrap = ordered ? `<ol>\n${itemHtml}\n</ol>` : `<ul>\n${itemHtml}\n</ul>`;
      return `<!-- wp:list${attrs} -->\n${wrap}\n<!-- /wp:list -->`;
    }
    case 'blockquote':
      return `<!-- wp:quote -->\n<blockquote class="wp-block-quote">${el.innerHTML}</blockquote>\n<!-- /wp:quote -->`;
    case 'pre':
      return `<!-- wp:code -->\n<pre class="wp-block-code">${_serializeInline(el)}</pre>\n<!-- /wp:code -->`;
    case 'hr':
      return `<!-- wp:separator -->\n<hr class="wp-block-separator has-alpha-channel-opacity"/>\n<!-- /wp:separator -->`;
    case 'figure':
    case 'img':
    case 'picture':
    case 'video':
    case 'audio':
    case 'iframe':
    case 'embed':
    case 'object':
      return '';
    default: {
      const text = (el.textContent || '').trim();
      if (!text) return '';
      return `<!-- wp:paragraph -->\n<p>${_serializeInline(el)}</p>\n<!-- /wp:paragraph -->`;
    }
  }
}

function appToWpHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const root = _parseRoot(html);
  if (!root) return '';

  const blocks = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1) continue;
    const wrapped = _wrapBlock(child);
    if (wrapped) blocks.push(wrapped);
  }
  return blocks.join('\n\n');
}

module.exports = { wpToAppHtml, appToWpHtml, WP_COMMENT_RE };
