const { parseHTML } = require('linkedom');
const { cleanPageHtml } = require('./html-clean');

const WP_COMMENT_RE = /<!--\s*\/?\s*wp:[^>]*-->/g;

// Nicht round-trip-faehige Einbettungen: werden bei Import wie Export verworfen.
// Bilder (`img`/`figure`) sind bewusst NICHT hier — die bleiben erhalten.
const _DROP_EMBEDS = 'video, audio, iframe, embed, object, picture, source';
// Auf `<img>` erhaltene Attribute (Rest wird gestrippt: srcset/sizes/width/height/
// loading/decoding/style… bleiben WP ueberlassen).
const _IMG_KEEP_ATTRS = new Set(['src', 'alt', 'class']);

function _parseRoot(html) {
  const wrapped = `<!DOCTYPE html><html><body><div id="r">${html}</div></body></html>`;
  const { document } = parseHTML(wrapped);
  return document.getElementById('r');
}

function _escAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// WP-Attachment-ID eines <img>: explizit via data-wp-id, sonst aus der
// `wp-image-<n>`-Klasse (bleibt beim Import erhalten, siehe _filterClasses).
function _imgId(img) {
  const explicit = img.getAttribute('data-wp-id');
  if (explicit && /^\d+$/.test(explicit)) return Number(explicit);
  const cls = img.getAttribute('class') || '';
  const m = /\bwp-image-(\d+)\b/.exec(cls);
  return m ? Number(m[1]) : null;
}

function wpToAppHtml(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const html = raw.replace(WP_COMMENT_RE, '');
  const root = _parseRoot(html);
  if (!root) return '';

  root.querySelectorAll(_DROP_EMBEDS).forEach(n => n.remove());
  // <img> auf ein schlankes Attribut-Set reduzieren (src/alt/class).
  root.querySelectorAll('img').forEach(img => {
    for (const attr of Array.from(img.attributes)) {
      if (!_IMG_KEEP_ATTRS.has(attr.name.toLowerCase())) img.removeAttribute(attr.name);
    }
  });
  // Figuren ohne Bild (z.B. ehemalige Video-/Embed-Wrapper) fallen weg.
  root.querySelectorAll('figure').forEach(fig => {
    if (!fig.querySelector('img')) fig.remove();
  });
  root.querySelectorAll('[style]').forEach(n => n.removeAttribute('style'));
  root.querySelectorAll('[class]').forEach(n => {
    const keep = (n.getAttribute('class') || '')
      .split(/\s+/)
      // `wp-image-<n>` bleibt: traegt die Attachment-ID fuer einen sauberen
      // Push-Round-Trip. Uebrige wp-/has-/is-style-Utility-Klassen fliegen raus.
      .filter(c => c && (/^wp-image-\d+$/.test(c) || (!/^wp-/.test(c) && !/^has-/.test(c) && !/^is-style-/.test(c))))
      .join(' ');
    if (keep) n.setAttribute('class', keep);
    else n.removeAttribute('class');
  });

  return cleanPageHtml(root.innerHTML);
}

function _serializeInline(node) {
  return node.innerHTML;
}

// Gutenberg-`wp:image`-Block aus einem <img> (evtl. in <figure> mit <figcaption>).
function _imageBlock(img, caption) {
  const src = img && img.getAttribute('src');
  if (!src) return '';
  const id = _imgId(img);
  const alt = img.getAttribute('alt') || '';
  const attrs = id ? ` {"id":${id},"sizeSlug":"full"}` : '';
  const imgClass = id ? ` class="wp-image-${id}"` : '';
  const cap = caption && caption.trim()
    ? `<figcaption class="wp-element-caption">${caption}</figcaption>`
    : '';
  return `<!-- wp:image${attrs} -->\n<figure class="wp-block-image size-full"><img src="${_escAttr(src)}" alt="${_escAttr(alt)}"${imgClass}/>${cap}</figure>\n<!-- /wp:image -->`;
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
    case 'figure': {
      const img = el.querySelector('img');
      const figcap = el.querySelector('figcaption');
      return _imageBlock(img, figcap ? figcap.innerHTML : '');
    }
    case 'img':
      return _imageBlock(el, '');
    case 'video':
    case 'audio':
    case 'iframe':
    case 'embed':
    case 'object':
    case 'picture':
      return '';
    default: {
      const text = (el.textContent || '').trim();
      if (!text) return '';
      return `<!-- wp:paragraph -->\n<p>${_serializeInline(el)}</p>\n<!-- /wp:paragraph -->`;
    }
  }
}

function _emitBlocks(root) {
  const blocks = [];
  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType !== 1) continue;
    const wrapped = _wrapBlock(child);
    if (wrapped) blocks.push(wrapped);
  }
  return blocks.join('\n\n');
}

function appToWpHtml(html) {
  if (!html || typeof html !== 'string') return '';
  const root = _parseRoot(html);
  if (!root) return '';
  return _emitBlocks(root);
}

// Wie appToWpHtml, aber mit vorgelagertem async Media-Pass: jedes <img> wird
// durch `resolveImage(src)` geschleust. Rueckgabe `{ src, id }` ersetzt src (und
// setzt data-wp-id fuer den Block-Emitter); `null` entfernt das Bild. So laedt der
// Push-Job data-URIs / fremd-gehostete Bilder in die WP-Mediathek hoch, waehrend
// bereits blog-gehostete Bilder unangetastet bleiben (siehe lib/wp-media.js).
async function appToWpHtmlWithMedia(html, { resolveImage } = {}) {
  if (!html || typeof html !== 'string') return '';
  const root = _parseRoot(html);
  if (!root) return '';
  if (typeof resolveImage === 'function') {
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const src = img.getAttribute('src') || '';
      let resolved = null;
      try { resolved = await resolveImage(src); }
      catch { resolved = null; }
      if (!resolved || !resolved.src) { img.remove(); continue; }
      img.setAttribute('src', resolved.src);
      if (resolved.id != null) img.setAttribute('data-wp-id', String(resolved.id));
    }
    // Figuren, deren Bild verworfen wurde, fallen weg.
    root.querySelectorAll('figure').forEach(fig => {
      if (!fig.querySelector('img')) fig.remove();
    });
  }
  return _emitBlocks(root);
}

module.exports = { wpToAppHtml, appToWpHtml, appToWpHtmlWithMedia, WP_COMMENT_RE };
