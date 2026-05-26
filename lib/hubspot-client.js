'use strict';
// HubSpot REST-API-Wrapper. PAT-Auth (Bearer-Token), Endpoints:
//   GET  /account-info/v3/details        → Token-Test (Portal-Info)
//   GET  /cms/v3/blogs/authors           → Autorenliste (paged via `after`)
//   GET  /content/api/v2/blogs           → Content-Group-Liste (paged via `offset`)
//   GET  /cms/v3/blogs/posts             → Post-Liste (paged via `after`)
//   POST /cms/v3/blogs/posts             → Post anlegen (Draft)
//   PATCH /cms/v3/blogs/posts/{id}/draft → Draft-Buffer eines existierenden Posts updaten
//                                          (Live-Version bleibt unverändert bis User
//                                          in HubSpot den Buffer publiziert)
//
// Error-Codes:
//   401 → HUBSPOT_AUTH_FAILED
//   403 → HUBSPOT_FORBIDDEN
//   429 → HUBSPOT_RATE_LIMIT (wartet `Retry-After` und retried bis MAX_RETRIES)
//   5xx → HUBSPOT_UPSTREAM
//   sonst → HUBSPOT_HTTP_<status>
//
// Rate-Limit: clientseitiges Token-Bucket (100 req / 10 s). Globaler Bucket pro
// Modul, da PAT = ein User-Account; mehrere parallele Clients teilen sich Quota.

const HUBSPOT_BASE = 'https://api.hubapi.com';
const MAX_RETRIES = 3;
const RATE_LIMIT_PER_WINDOW = 100;
const RATE_LIMIT_WINDOW_MS = 10_000;

let _bucketTokens = RATE_LIMIT_PER_WINDOW;
let _bucketResetAt = Date.now() + RATE_LIMIT_WINDOW_MS;
let _waiters = [];

function _refillBucket() {
  const now = Date.now();
  if (now >= _bucketResetAt) {
    _bucketTokens = RATE_LIMIT_PER_WINDOW;
    _bucketResetAt = now + RATE_LIMIT_WINDOW_MS;
  }
}

async function _acquireToken() {
  for (;;) {
    _refillBucket();
    if (_bucketTokens > 0) {
      _bucketTokens--;
      return;
    }
    const waitMs = Math.max(10, _bucketResetAt - Date.now());
    await new Promise(r => setTimeout(r, waitMs));
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function _request(client, path, opts = {}) {
  const { method = 'GET', body, query } = opts;
  const url = new URL(HUBSPOT_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers = {
    'Authorization': `Bearer ${client.token}`,
    'Accept': 'application/json',
    'User-Agent': 'schreibwerkstatt-hubspot-sync',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let attempt = 0;
  for (;;) {
    await _acquireToken();
    let res;
    try {
      res = await client.fetch(url.toString(), {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: client.signal,
      });
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) throw err;
      if (attempt < MAX_RETRIES) {
        attempt++;
        await delay(Math.min(2000, 200 * 2 ** attempt));
        continue;
      }
      const wrap = new Error('HUBSPOT_FETCH_FAILED');
      wrap.code = 'HUBSPOT_FETCH_FAILED';
      wrap.cause = err;
      throw wrap;
    }
    if (res.status === 429) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get('Retry-After'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(10_000, 500 * 2 ** attempt);
        attempt++;
        await delay(waitMs);
        continue;
      }
      const err = new Error('HUBSPOT_RATE_LIMIT');
      err.code = 'HUBSPOT_RATE_LIMIT';
      err.status = 429;
      throw err;
    }
    if (res.status >= 500) {
      if (attempt < MAX_RETRIES) {
        attempt++;
        await delay(Math.min(2000, 200 * 2 ** attempt));
        continue;
      }
      const err = new Error('HUBSPOT_UPSTREAM');
      err.code = 'HUBSPOT_UPSTREAM';
      err.status = res.status;
      throw err;
    }
    if (res.status === 401) {
      const err = new Error('HUBSPOT_AUTH_FAILED');
      err.code = 'HUBSPOT_AUTH_FAILED';
      err.status = 401;
      throw err;
    }
    if (res.status === 403) {
      const err = new Error('HUBSPOT_FORBIDDEN');
      err.code = 'HUBSPOT_FORBIDDEN';
      err.status = 403;
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HUBSPOT_HTTP_${res.status}`);
      err.code = `HUBSPOT_HTTP_${res.status}`;
      err.status = res.status;
      err.body = text.slice(0, 500);
      throw err;
    }
    return res;
  }
}

async function _pagedList(client, path, query = {}, limit = 100) {
  const all = [];
  let after;
  for (;;) {
    const res = await _request(client, path, { query: { ...query, limit, after } });
    const data = await res.json();
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    after = data?.paging?.next?.after;
    if (!after) break;
  }
  return all;
}

function createHubspotClient({ token, fetch: fetchImpl, signal } = {}) {
  if (!token || typeof token !== 'string') {
    const err = new Error('HUBSPOT_TOKEN_REQUIRED');
    err.code = 'HUBSPOT_TOKEN_REQUIRED';
    throw err;
  }
  const client = {
    token,
    fetch: fetchImpl || globalThis.fetch,
    signal: signal || null,
  };
  if (typeof client.fetch !== 'function') {
    throw new Error('HUBSPOT_FETCH_UNAVAILABLE');
  }

  return {
    async me() {
      const res = await _request(client, '/account-info/v3/details');
      return res.json();
    },
    async listAuthors() {
      return _pagedList(client, '/cms/v3/blogs/authors');
    },
    // Legacy v2-Endpoint — einzige stabile Stelle, an der man alle Blogs
    // (Content-Groups) eines Portals listen kann. Pagination via `offset`/
    // `limit`, nicht `after`. Antwort: `{ objects: [...], total_count, limit, offset }`.
    async listBlogs() {
      const all = [];
      let offset = 0;
      const limit = 100;
      for (;;) {
        const res = await _request(client, '/content/api/v2/blogs', {
          query: { limit, offset },
        });
        const data = await res.json();
        const objects = Array.isArray(data?.objects) ? data.objects : [];
        all.push(...objects);
        if (objects.length < limit) break;
        offset += objects.length;
      }
      return all;
    },
    async *iteratePosts({ authorId, blogId, state = 'PUBLISHED', limit = 100 } = {}) {
      let after;
      for (;;) {
        const res = await _request(client, '/cms/v3/blogs/posts', {
          query: { blogAuthorId: authorId, contentGroupId: blogId, state, limit, after },
        });
        const data = await res.json();
        const results = Array.isArray(data?.results) ? data.results : [];
        for (const p of results) yield p;
        after = data?.paging?.next?.after;
        if (!after) return;
      }
    },
    async createPost(payload) {
      const res = await _request(client, '/cms/v3/blogs/posts', { method: 'POST', body: payload });
      return res.json();
    },
    async getPost(postId) {
      const res = await _request(client, `/cms/v3/blogs/posts/${encodeURIComponent(postId)}`);
      return res.json();
    },
    async updatePostDraft(postId, payload) {
      const res = await _request(client, `/cms/v3/blogs/posts/${encodeURIComponent(postId)}/draft`, {
        method: 'PATCH',
        body: payload,
      });
      return res.json();
    },
  };
}

function _resetRateLimitForTests() {
  _bucketTokens = RATE_LIMIT_PER_WINDOW;
  _bucketResetAt = Date.now() + RATE_LIMIT_WINDOW_MS;
  _waiters = [];
}

module.exports = {
  createHubspotClient,
  HUBSPOT_BASE,
  _resetRateLimitForTests,
};
