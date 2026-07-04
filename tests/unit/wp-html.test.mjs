// Unit tests for lib/wp-html.js: Gutenberg block strip on import + wrap on export.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { wpToAppHtml, appToWpHtml, appToWpHtmlWithMedia } = await import('../../lib/wp-html.js');

test('wpToAppHtml: strips wp:* comments', () => {
  const wp = `
<!-- wp:paragraph -->
<p>Hallo Welt.</p>
<!-- /wp:paragraph -->

<!-- wp:heading {"level":2} -->
<h2 class="wp-block-heading">Kapitel 1</h2>
<!-- /wp:heading -->
  `;
  const app = wpToAppHtml(wp);
  assert.doesNotMatch(app, /wp:/);
  assert.match(app, /<p>Hallo Welt\.<\/p>/);
  assert.match(app, /<h2>Kapitel 1<\/h2>/);
});

test('wpToAppHtml: keeps images/figures, strips non-image embeds', () => {
  const wp = `<p>vorher</p><figure class="wp-block-image"><img src="https://blog.test/a.jpg" alt="A" srcset="x 2x" width="800"/></figure><iframe src="y"></iframe><p>nachher</p>`;
  const app = wpToAppHtml(wp);
  assert.match(app, /<img/);
  assert.match(app, /src="https:\/\/blog\.test\/a\.jpg"/);
  assert.match(app, /alt="A"/);
  // fremde img-Attribute (srcset/width) werden gestrippt
  assert.doesNotMatch(app, /srcset/);
  assert.doesNotMatch(app, /width=/);
  assert.doesNotMatch(app, /<iframe/);
  assert.match(app, /vorher/);
  assert.match(app, /nachher/);
});

test('wpToAppHtml: keeps wp-image-<n> class (attachment id) but strips other wp- classes', () => {
  const wp = `<figure class="wp-block-image size-large"><img class="wp-image-42 has-shadow" src="https://blog.test/a.jpg"/></figure>`;
  const app = wpToAppHtml(wp);
  assert.match(app, /wp-image-42/);
  assert.doesNotMatch(app, /wp-block-image/);
  assert.doesNotMatch(app, /has-shadow/);
});

test('wpToAppHtml: drops empty figure left over from stripped video', () => {
  const wp = `<figure class="wp-block-video"><video src="v.mp4"></video></figure><p>text</p>`;
  const app = wpToAppHtml(wp);
  assert.doesNotMatch(app, /<figure/);
  assert.doesNotMatch(app, /<video/);
  assert.match(app, /text/);
});

test('wpToAppHtml: empty/null returns empty string', () => {
  assert.equal(wpToAppHtml(''), '');
  assert.equal(wpToAppHtml(null), '');
});

test('wpToAppHtml: removes wp-* utility classes', () => {
  const wp = `<!-- wp:paragraph --><p class="wp-block has-text-color">x</p><!-- /wp:paragraph -->`;
  const app = wpToAppHtml(wp);
  assert.doesNotMatch(app, /wp-block/);
  assert.doesNotMatch(app, /has-text-color/);
});

test('appToWpHtml: paragraph block', () => {
  const out = appToWpHtml('<p>Hallo Welt.</p>');
  assert.match(out, /<!-- wp:paragraph -->/);
  assert.match(out, /<p>Hallo Welt\.<\/p>/);
  assert.match(out, /<!-- \/wp:paragraph -->/);
});

test('appToWpHtml: h2 heading default level', () => {
  const out = appToWpHtml('<h2>Kapitel 1</h2>');
  assert.match(out, /<!-- wp:heading -->/);
  assert.match(out, /<h2 class="wp-block-heading">Kapitel 1<\/h2>/);
});

test('appToWpHtml: h3 heading level annotated', () => {
  const out = appToWpHtml('<h3>Unterkapitel</h3>');
  assert.match(out, /<!-- wp:heading \{"level":3\} -->/);
  assert.match(out, /<h3 class="wp-block-heading">Unterkapitel<\/h3>/);
});

test('appToWpHtml: unordered list with list-items', () => {
  const out = appToWpHtml('<ul><li>a</li><li>b</li></ul>');
  assert.match(out, /<!-- wp:list -->/);
  assert.match(out, /<!-- wp:list-item -->\n<li>a<\/li>\n<!-- \/wp:list-item -->/);
  assert.match(out, /<!-- wp:list-item -->\n<li>b<\/li>\n<!-- \/wp:list-item -->/);
});

test('appToWpHtml: ordered list flagged', () => {
  const out = appToWpHtml('<ol><li>x</li></ol>');
  assert.match(out, /<!-- wp:list \{"ordered":true\} -->/);
  assert.match(out, /<ol>/);
});

test('appToWpHtml: blockquote', () => {
  const out = appToWpHtml('<blockquote><p>Zitat</p></blockquote>');
  assert.match(out, /<!-- wp:quote -->/);
  assert.match(out, /<blockquote class="wp-block-quote">/);
});

test('appToWpHtml: code block', () => {
  const out = appToWpHtml('<pre>console.log(1)</pre>');
  assert.match(out, /<!-- wp:code -->/);
  assert.match(out, /<pre class="wp-block-code">console\.log\(1\)<\/pre>/);
});

test('appToWpHtml: hr → separator', () => {
  const out = appToWpHtml('<hr>');
  assert.match(out, /<!-- wp:separator -->/);
  assert.match(out, /<hr class="wp-block-separator has-alpha-channel-opacity"\/>/);
});

test('appToWpHtml: wraps <figure>/<img> as wp:image block', () => {
  const out = appToWpHtml('<p>vor</p><figure><img src="https://blog.test/a.jpg" alt="A"/></figure><p>nach</p>');
  assert.match(out, /<!-- wp:image -->/);
  assert.match(out, /<figure class="wp-block-image size-full"><img src="https:\/\/blog\.test\/a\.jpg" alt="A"\/><\/figure>/);
  assert.match(out, /<!-- \/wp:image -->/);
  assert.match(out, /vor/);
  assert.match(out, /nach/);
});

test('appToWpHtml: wp:image carries attachment id from wp-image-<n> class', () => {
  const out = appToWpHtml('<figure><img class="wp-image-42" src="https://blog.test/a.jpg"/></figure>');
  assert.match(out, /<!-- wp:image \{"id":42,"sizeSlug":"full"\} -->/);
  assert.match(out, /class="wp-image-42"/);
});

test('appToWpHtml: wp:image keeps figcaption', () => {
  const out = appToWpHtml('<figure><img src="https://blog.test/a.jpg"/><figcaption>Bildtitel</figcaption></figure>');
  assert.match(out, /<figcaption class="wp-element-caption">Bildtitel<\/figcaption>/);
});

test('appToWpHtml: still drops video/iframe embeds', () => {
  const out = appToWpHtml('<p>vor</p><video src="v.mp4"></video><iframe src="y"></iframe><p>nach</p>');
  assert.doesNotMatch(out, /<video/);
  assert.doesNotMatch(out, /<iframe/);
  assert.match(out, /vor/);
  assert.match(out, /nach/);
});

test('appToWpHtml: escapes quotes/angle-brackets in img src/alt', () => {
  const out = appToWpHtml('<figure><img src="https://blog.test/a.jpg?x=1&amp;y=2" alt="&quot;q&quot; <b>"/></figure>');
  assert.doesNotMatch(out, /alt="[^"]*"[^/]*"/); // kein ungeschlossenes Attribut durch rohes "
  assert.match(out, /&amp;y=2/);
  assert.match(out, /&quot;q&quot;/);
});

test('appToWpHtmlWithMedia: replaces src via resolver and sets attachment id', async () => {
  const resolveImage = async (src) => {
    assert.equal(src, 'data:image/png;base64,AAAA');
    return { src: 'https://blog.test/uploaded.png', id: 99 };
  };
  const out = await appToWpHtmlWithMedia('<figure><img src="data:image/png;base64,AAAA"/></figure>', { resolveImage });
  assert.match(out, /<!-- wp:image \{"id":99,"sizeSlug":"full"\} -->/);
  assert.match(out, /src="https:\/\/blog\.test\/uploaded\.png"/);
  assert.match(out, /class="wp-image-99"/);
});

test('appToWpHtmlWithMedia: drops image when resolver returns null', async () => {
  const resolveImage = async () => null;
  const out = await appToWpHtmlWithMedia('<p>vor</p><figure><img src="data:image/svg+xml,x"/></figure><p>nach</p>', { resolveImage });
  assert.doesNotMatch(out, /<!-- wp:image/);
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /vor/);
  assert.match(out, /nach/);
});

test('appToWpHtmlWithMedia: keeps blog-hosted src unchanged (resolver echoes)', async () => {
  const resolveImage = async (src) => ({ src, id: null });
  const out = await appToWpHtmlWithMedia('<figure><img src="https://blog.test/a.jpg"/></figure>', { resolveImage });
  assert.match(out, /<!-- wp:image -->/);
  assert.match(out, /src="https:\/\/blog\.test\/a\.jpg"/);
});

test('appToWpHtml: preserves inline formatting inside paragraph', () => {
  const out = appToWpHtml('<p>foo <strong>bold</strong> <em>i</em> <a href="https://x">link</a></p>');
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>i<\/em>/);
  assert.match(out, /<a href="https:\/\/x">link<\/a>/);
});

test('round-trip: app → wp → app yields plain blocks', () => {
  const original = '<h2>Titel</h2><p>Eins.</p><ul><li>a</li><li>b</li></ul><p>Zwei.</p>';
  const wp = appToWpHtml(original);
  const back = wpToAppHtml(wp);
  assert.doesNotMatch(back, /wp:/);
  assert.match(back, /<h2>Titel<\/h2>/);
  assert.match(back, /<p>Eins\.<\/p>/);
  assert.match(back, /<li>a<\/li>/);
  assert.match(back, /<p>Zwei\.<\/p>/);
});

test('appToWpHtml: empty input → empty string', () => {
  assert.equal(appToWpHtml(''), '');
  assert.equal(appToWpHtml(null), '');
});

test('appToWpHtml: unknown block tag falls back to paragraph if it has text', () => {
  const out = appToWpHtml('<div>orphan text</div>');
  assert.match(out, /<!-- wp:paragraph -->/);
  assert.match(out, /orphan text/);
});
