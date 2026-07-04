const { isBlockedHost, assertPublicUrl } = require('./ssrf-guard');

const ALLOWED_STATUS = ['draft', 'publish', 'private'];

const MAX_RETRIES = 2;
const RETRY_BASE_MS = 200;

function validateBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    const err = new Error('BLOG_INVALID_URL');
    err.code = 'BLOG_INVALID_URL';
    throw err;
  }
  let u;
  try { u = new URL(raw.trim()); }
  catch {
    const err = new Error('BLOG_INVALID_URL');
    err.code = 'BLOG_INVALID_URL';
    throw err;
  }
  if (u.protocol !== 'https:') {
    const err = new Error('BLOG_HTTPS_REQUIRED');
    err.code = 'BLOG_HTTPS_REQUIRED';
    throw err;
  }
  // SSRF: literale interne Hosts (loopback, private, link-local, metadata) sofort
  // ablehnen. DNS-Namen werden zusaetzlich beim Request (assertPublicUrl) geprueft.
  if (isBlockedHost(u.hostname)) {
    const err = new Error('BLOG_BLOCKED_HOST');
    err.code = 'BLOG_BLOCKED_HOST';
    throw err;
  }
  const path = u.pathname.replace(/\/+$/, '');
  return u.origin + path;
}

function authHeader(username, password) {
  return 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
}

function backoffMs(attempt) {
  return Math.min(2000, RETRY_BASE_MS * 2 ** attempt);
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function request(client, path, opts = {}) {
  const { method = 'GET', body, query, raw } = opts;
  const url = new URL(client.baseUrl + '/wp-json/wp/v2' + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers = {
    'Authorization': authHeader(client.username, client.password),
    'Accept': 'application/json',
    'User-Agent': 'schreibwerkstatt-blog-sync',
  };
  // raw: Binaer-Upload (Media). Body ist ein Buffer, MIME + Dateiname stehen im
  // Content-Disposition-Header (WP-Media-Endpoint erwartet das statt JSON).
  let fetchBody;
  if (raw) {
    headers['Content-Type'] = raw.contentType;
    headers['Content-Disposition'] = `attachment; filename="${String(raw.filename || 'upload.bin').replace(/["\r\n]/g, '')}"`;
    fetchBody = raw.body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchBody = JSON.stringify(body);
  }

  // SSRF: Zielhost via DNS aufloesen und gegen interne Ranges pruefen, bevor
  // der erste Fetch losgeht. Wirft SSRF_BLOCKED_HOST/SSRF_DNS_FAILED.
  await client.assertUrl(url.toString());

  let attempt = 0;
  for (;;) {
    let res;
    try {
      res = await client.fetch(url.toString(), {
        method,
        headers,
        body: fetchBody,
        signal: client.signal,
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        attempt++;
        await delay(backoffMs(attempt));
        continue;
      }
      throw err;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_RETRIES) {
        attempt++;
        await delay(backoffMs(attempt));
        continue;
      }
    }
    if (res.status === 401 || res.status === 403) {
      const err = new Error('BLOG_AUTH_FAILED');
      err.code = 'BLOG_AUTH_FAILED';
      err.status = res.status;
      throw err;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`BLOG_HTTP_${res.status}`);
      err.code = `BLOG_HTTP_${res.status}`;
      err.status = res.status;
      err.body = text.slice(0, 500);
      throw err;
    }
    return res;
  }
}

function createWpClient({ baseUrl, username, password, fetch: fetchImpl, signal } = {}) {
  if (!username || typeof username !== 'string') {
    const err = new Error('BLOG_INVALID_USERNAME');
    err.code = 'BLOG_INVALID_USERNAME';
    throw err;
  }
  if (!password || typeof password !== 'string') {
    const err = new Error('BLOG_INVALID_PASSWORD');
    err.code = 'BLOG_INVALID_PASSWORD';
    throw err;
  }
  const validated = validateBaseUrl(baseUrl);
  const client = {
    baseUrl: validated,
    username,
    password,
    fetch: fetchImpl || globalThis.fetch,
    signal: signal || null,
    // SSRF-Guard greift nur auf dem echten Netzpfad (Default-fetch). Wird ein
    // fetch injiziert (Tests/Mocks), gibt es keinen echten Request zu schuetzen
    // — der synchrone Literal-Block in validateBaseUrl bleibt aber aktiv.
    assertUrl: fetchImpl ? (async () => {}) : assertPublicUrl,
  };
  if (typeof client.fetch !== 'function') {
    throw new Error('BLOG_FETCH_UNAVAILABLE');
  }

  return {
    baseUrl: validated,
    async me() {
      const res = await request(client, '/users/me', { query: { context: 'edit' } });
      return res.json();
    },
    async listPosts({ page = 1, perPage = 100, modifiedAfter } = {}) {
      const res = await request(client, '/posts', {
        query: {
          page,
          per_page: perPage,
          status: 'any',
          modified_after: modifiedAfter,
          orderby: 'modified',
          order: 'asc',
          context: 'edit',
          _fields: 'id,title,content,status,modified_gmt,date_gmt,slug',
        },
      });
      const posts = await res.json();
      return {
        posts,
        totalPages: Number(res.headers.get('X-WP-TotalPages') || 1),
        total: Number(res.headers.get('X-WP-Total') || posts.length || 0),
      };
    },
    async getPost(id) {
      const res = await request(client, `/posts/${Number(id)}`, {
        query: { context: 'edit' },
      });
      return res.json();
    },
    async createPost(payload) {
      if (payload && payload.status && !ALLOWED_STATUS.includes(payload.status)) {
        const err = new Error('BLOG_INVALID_STATUS');
        err.code = 'BLOG_INVALID_STATUS';
        throw err;
      }
      const res = await request(client, '/posts', { method: 'POST', body: payload });
      return res.json();
    },
    async updatePost(id, payload) {
      if (payload && payload.status && !ALLOWED_STATUS.includes(payload.status)) {
        const err = new Error('BLOG_INVALID_STATUS');
        err.code = 'BLOG_INVALID_STATUS';
        throw err;
      }
      const res = await request(client, `/posts/${Number(id)}`, {
        method: 'POST',
        body: payload,
      });
      return res.json();
    },
    // Bild-Upload in die WP-Mediathek. `data` ist ein Buffer, `mimeType` + `filename`
    // steuern den Content-Disposition-Header. Rueckgabe enthaelt `id` + `source_url`.
    async uploadMedia({ data, filename, mimeType } = {}) {
      if (!Buffer.isBuffer(data) || !data.length) {
        const err = new Error('BLOG_INVALID_MEDIA');
        err.code = 'BLOG_INVALID_MEDIA';
        throw err;
      }
      const res = await request(client, '/media', {
        method: 'POST',
        raw: { body: data, contentType: mimeType || 'application/octet-stream', filename: filename || 'upload.bin' },
      });
      return res.json();
    },
  };
}

module.exports = {
  createWpClient,
  validateBaseUrl,
  authHeader,
  backoffMs,
  ALLOWED_STATUS,
};
