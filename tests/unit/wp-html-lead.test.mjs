// Lead aus der Titel-Werkstatt im WordPress-Post (lib/wp-html.js#HEADLINE_MARKER_CLASS):
// der Push setzt ihn als markierten ersten Block, der Pull schneidet ihn heraus
// und meldet den Text zurueck — er darf nie im Manuskript landen und nie
// doppelt im Post stehen.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

const { wpToAppHtml, appToWpHtml, HEADLINE_MARKER_CLASS } = await import('../../lib/wp-html.js');

test('appToWpHtml: Lead als markierter erster Block, Text escapet', () => {
  const out = appToWpHtml('<p>Body.</p>', { lead: 'Lead <mit> & Zeichen' });
  assert.match(out, new RegExp(`^<!-- wp:group \\{"className":"${HEADLINE_MARKER_CLASS}"\\} -->`));
  assert.match(out, /<p class="ms-head__lead"><em>Lead &lt;mit&gt; &amp; Zeichen<\/em><\/p>/);
  assert.ok(out.indexOf('ms-head__lead') < out.indexOf('Body.'));
});

test('appToWpHtml: ohne Lead kein Block', () => {
  assert.doesNotMatch(appToWpHtml('<p>Body.</p>', { lead: '  ' }), /sw-headline/);
});

test('Round-Trip: Lead kommt als stats.lead zurueck, nie als Seitentext', async () => {
  const stats = {};
  const back = await wpToAppHtml(appToWpHtml('<p>Body.</p>', { lead: 'Der Lead.' }), stats);
  assert.equal(stats.lead, 'Der Lead.');
  assert.equal(back, await wpToAppHtml(appToWpHtml('<p>Body.</p>')));
  assert.doesNotMatch(back, /Lead/);
});

test('Round-Trip ueber drei Zyklen: Lead genau einmal im Post', async () => {
  let html = '<p>Body.</p>';
  let post = '';
  for (let i = 0; i < 3; i++) {
    post = appToWpHtml(html, { lead: 'Der Lead.' });
    html = await wpToAppHtml(post, {});
  }
  assert.equal((post.match(/Der Lead\./g) || []).length, 1);
});

test('Post ohne Lead-Block: stats.lead bleibt undefined (keine Aussage)', async () => {
  const stats = {};
  await wpToAppHtml('<p>nur Text</p>', stats);
  assert.equal(stats.lead, undefined);
});
