import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hubspotToAppHtml, appToHubspotHtml } from '../../lib/hubspot-html.js';

test('hubspotToAppHtml strips images, scripts, iframes', () => {
  const input = `
    <p>Vor Bild</p>
    <img src="https://x.com/foo.png" alt="x">
    <script>alert(1)</script>
    <iframe src="https://e.com"></iframe>
    <p>Nach Bild</p>
  `;
  const out = hubspotToAppHtml(input);
  assert.match(out, /<p>Vor Bild<\/p>/);
  assert.match(out, /<p>Nach Bild<\/p>/);
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /<script/);
  assert.doesNotMatch(out, /<iframe/);
});

test('hubspotToAppHtml maps h1/h4-h6 to h2/h3, keeps h2/h3', () => {
  const out = hubspotToAppHtml('<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>');
  assert.match(out, /<h2>A<\/h2>/);
  assert.match(out, /<h2>B<\/h2>/);
  assert.match(out, /<h3>C<\/h3>/);
  assert.match(out, /<h3>D<\/h3>/);
  assert.match(out, /<h3>E<\/h3>/);
  assert.match(out, /<h3>F<\/h3>/);
});

test('hubspotToAppHtml strips Jinja markers', () => {
  const out = hubspotToAppHtml('<p>Hi {{ name }} und {# note #}!</p>');
  assert.match(out, /<p>Hi/);
  assert.doesNotMatch(out, /\{\{/);
  assert.doesNotMatch(out, /\{#/);
});

test('hubspotToAppHtml unwraps unknown tags but keeps text', () => {
  const out = hubspotToAppHtml('<section><p>Inner</p></section>');
  assert.match(out, /<p>Inner<\/p>/);
});

test('hubspotToAppHtml drops relative/javascript links but keeps inner text', () => {
  const out = hubspotToAppHtml('<p><a href="/rel">rel</a> <a href="javascript:alert(1)">js</a> <a href="https://x.com">ok</a></p>');
  assert.match(out, /rel/);
  assert.match(out, /js/);
  assert.match(out, /<a href="https:\/\/x\.com">ok<\/a>/);
  assert.doesNotMatch(out, /href="\/rel"/);
  assert.doesNotMatch(out, /href="javascript:/);
});

test('hubspotToAppHtml wraps plain text in single <p>', () => {
  const out = hubspotToAppHtml('Plain  text   no   tags');
  assert.equal(out, '<p>Plain text no tags</p>');
});

test('hubspotToAppHtml escapes HTML entities in text content', () => {
  const out = hubspotToAppHtml('<p>5 < 6 & 7 > 4</p>');
  assert.match(out, /5 &lt; 6 &amp; 7 &gt; 4/);
});

test('appToHubspotHtml is defensive — also strips images', () => {
  const out = appToHubspotHtml('<p>x</p><img src="https://x/y.png"><p>y</p>');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /<p>x<\/p>/);
  assert.match(out, /<p>y<\/p>/);
});

test('hubspotToAppHtml empty/null input returns empty string', () => {
  assert.equal(hubspotToAppHtml(''), '');
  assert.equal(hubspotToAppHtml(null), '');
  assert.equal(hubspotToAppHtml(undefined), '');
});

test('hubspotToAppHtml preserves ul/ol/li structure', () => {
  const out = hubspotToAppHtml('<ul><li>A</li><li>B</li></ul>');
  assert.match(out, /<ul><li>A<\/li><li>B<\/li><\/ul>/);
});

test('hubspotToAppHtml strips CMS-Wrapper classes', () => {
  const out = hubspotToAppHtml('<div class="hs-cta-wrapper">CTA</div><p>real</p>');
  assert.doesNotMatch(out, /CTA/);
  assert.match(out, /<p>real<\/p>/);
});

test('hubspotToAppHtml preserves <hr>', () => {
  const out = hubspotToAppHtml('<p>A</p><hr><p>B</p>');
  assert.match(out, /<p>A<\/p><hr><p>B<\/p>/);
});

test('hubspotToAppHtml preserves <pre> incl. whitespace + escapes inner', () => {
  const out = hubspotToAppHtml('<pre>line 1\n  line 2 < & ></pre>');
  assert.match(out, /<pre>line 1\n  line 2 &lt; &amp; &gt;<\/pre>/);
});

test('appToHubspotHtml round-trips hr + pre from editor', () => {
  const out = appToHubspotHtml('<p>x</p><hr><pre>code\n  indent</pre><p>y</p>');
  assert.match(out, /<p>x<\/p>/);
  assert.match(out, /<hr>/);
  assert.match(out, /<pre>code\n  indent<\/pre>/);
  assert.match(out, /<p>y<\/p>/);
});
