// Unit tests for lib/wp-html.js: Gutenberg block strip on import + wrap on export.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { wpToAppHtml, appToWpHtml } = await import('../../lib/wp-html.js');

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

test('wpToAppHtml: strips images/figures/embeds', () => {
  const wp = `<p>vorher</p><figure><img src="x"/></figure><iframe src="y"></iframe><p>nachher</p>`;
  const app = wpToAppHtml(wp);
  assert.doesNotMatch(app, /<img/);
  assert.doesNotMatch(app, /<figure/);
  assert.doesNotMatch(app, /<iframe/);
  assert.match(app, /vorher/);
  assert.match(app, /nachher/);
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

test('appToWpHtml: drops <img>/<figure>', () => {
  const out = appToWpHtml('<p>vor</p><figure><img src="x"/></figure><p>nach</p>');
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /<figure/);
  assert.match(out, /vor/);
  assert.match(out, /nach/);
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
