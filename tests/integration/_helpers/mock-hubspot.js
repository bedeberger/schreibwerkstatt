'use strict';
// Mock-HubSpot fuer Integration-Tests. Intercept-Fetch fuer HUBSPOT_BASE,
// gesteuerte Posts/Authors/Blogs. Stellt sich als globalThis.fetch in den Weg
// und filtert nur HubSpot-URLs; alle anderen Requests gehen durch (Node test
// haengt sonst, weil Express-Routen via supertest ueber localhost requested
// werden — aber wir testen die Job-Worker direkt, ohne Express).

const { HUBSPOT_BASE } = require('../../../lib/hubspot-client');

function makeMock() {
  const state = {
    me: { portalId: 4242, accountType: 'STANDARD' },
    authors: [
      { id: '111', fullName: 'Autor Eins', email: 'a1@example.com' },
      { id: '222', fullName: 'Autor Zwei', email: null },
    ],
    blogs: [
      { id: '555', name: 'Mein Blog' },
    ],
    posts: [],          // GET /cms/v3/blogs/posts liefert das hier
    created: [],        // POST /cms/v3/blogs/posts schiebt rein
    updated: [],        // PATCH /cms/v3/blogs/posts/{id}/draft schiebt rein
    failOnCreate: false,
  };

  const original = globalThis.fetch;
  globalThis.fetch = async function (url, opts = {}) {
    const u = typeof url === 'string' ? url : url.toString();
    if (!u.startsWith(HUBSPOT_BASE)) return original(url, opts);
    const path = u.slice(HUBSPOT_BASE.length).split('?')[0];
    const method = (opts.method || 'GET').toUpperCase();

    if (path === '/account-info/v3/details' && method === 'GET') {
      return jsonResponse(state.me);
    }
    if (path === '/cms/v3/blogs/authors' && method === 'GET') {
      return jsonResponse({ results: state.authors, paging: {} });
    }
    if (path === '/content/api/v2/blogs' && method === 'GET') {
      return jsonResponse({ objects: state.blogs, total_count: state.blogs.length, limit: 100, offset: 0 });
    }
    if (path === '/cms/v3/blogs/posts' && method === 'GET') {
      return jsonResponse({ results: state.posts, paging: {} });
    }
    if (path === '/cms/v3/blogs/posts' && method === 'POST') {
      if (state.failOnCreate) {
        return new Response('boom', { status: 500 });
      }
      const body = JSON.parse(opts.body || '{}');
      const id = String(900000 + state.created.length + 1);
      const created = { id, ...body, created: new Date().toISOString() };
      state.created.push(created);
      return jsonResponse(created);
    }
    // PATCH /cms/v3/blogs/posts/{id}/draft → Buffer aktualisieren.
    const draftMatch = path.match(/^\/cms\/v3\/blogs\/posts\/([^/]+)\/draft$/);
    if (draftMatch && method === 'PATCH') {
      const id = decodeURIComponent(draftMatch[1]);
      const body = JSON.parse(opts.body || '{}');
      const updated = { id, ...body, updated: new Date().toISOString() };
      state.updated.push(updated);
      return jsonResponse(updated);
    }
    // GET /cms/v3/blogs/posts/{id}
    const getMatch = path.match(/^\/cms\/v3\/blogs\/posts\/([^/]+)$/);
    if (getMatch && method === 'GET') {
      const id = decodeURIComponent(getMatch[1]);
      const found = state.created.find(p => p.id === id) || state.posts.find(p => p.id === id);
      if (found) return jsonResponse(found);
      return new Response('not found', { status: 404 });
    }
    return new Response('nope', { status: 404 });
  };

  return {
    state,
    restore() { globalThis.fetch = original; },
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

module.exports = { makeMock };
