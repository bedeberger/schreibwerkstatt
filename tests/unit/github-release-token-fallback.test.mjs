// Abgelaufenes/widerrufenes macclient.github_token darf die Release-Anzeige nicht
// lahmlegen: die Client-Repos sind public, bei 401 wird einmal ohne Token wiederholt.
// http-util + app-settings werden per require.cache gestubbt (kein Netz, keine DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const calls = [];
let token = 'ghp_dead';
let responses = [];

function stub(rel, exports) {
  const p = require.resolve(rel);
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}
stub('../../lib/http-util.js', {
  fetchWithTimeout: async (_url, opts) => {
    calls.push(opts.headers.Authorization || null);
    const r = responses.shift();
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  },
});
stub('../../lib/app-settings.js', { get: () => token });

const { createReleaseFetcher } = require('../../lib/github-release.js');
const RELEASE = { tag_name: 'v1.2.0', assets: [{ name: 'app.apk', size: 1, browser_download_url: 'https://x/app.apk' }] };

function fresh() {
  calls.length = 0;
  return createReleaseFetcher({ repo: 'o/r', assetExt: '.apk', assetKey: 'apk', logName: 'test-release' });
}

test('401 mit Token → Wiederholung ohne Token liefert das Release', async () => {
  const f = fresh();
  token = 'ghp_dead';
  responses = [{ status: 401 }, { status: 200, body: RELEASE }];
  const rel = await f.getLatestRelease();
  assert.deepEqual(calls, ['Bearer ghp_dead', null]);
  assert.equal(rel.available, true);
  assert.equal(rel.version, '1.2.0');
});

test('401 ohne Token → keine Wiederholung', async () => {
  const f = fresh();
  token = '';
  responses = [{ status: 401 }];
  const rel = await f.getLatestRelease();
  assert.deepEqual(calls, [null]);
  assert.deepEqual(rel, { available: false });
});

test('gueltiges Token → ein Aufruf mit Token', async () => {
  const f = fresh();
  token = 'ghp_ok';
  responses = [{ status: 200, body: RELEASE }];
  await f.getLatestRelease();
  assert.deepEqual(calls, ['Bearer ghp_ok']);
});
