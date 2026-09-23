// Alpine.data('blogSyncCard') — WordPress-Sync-Provider. Thin Wrapper über
// `createSyncCard` (sync/sync-core.js); Konflikt-Diff bleibt provider-spezifisch.
// Lebt als headless display-contents-Anker in index.html, via `$blog`-Magic
// global erreichbar. Root-Zugriffe gehen über window.__app.

import { createSyncCard, latestStamp as _latest } from './sync/sync-core.js';

const blogSpec = {
  key: 'blog',
  endpointBase: '/blog',
  jobTypes: {
    push: 'blog-push',
    refresh: ['blog-import', 'blog-pull'],
    reconcile: 'blog-reconcile',
  },
  // Badge-Status für eine Page (oder null = kein Badge).
  // 'new'         — kein Link → lokal angelegt, noch nie zu WP gepusht.
  // 'conflict'    — beide Seiten geändert, conflict_state='detected'.
  // 'push-needed' — Seite oder Titel-Werkstatt lokal geändert seit dem
  //                 Sync-Punkt (jüngerer von last_pulled_at/last_pushed_at —
  //                 dieselbe Regel wie lib/blog-merge.js#classifyPull).
  // 'synced'      — Stand identisch zum WP-Snapshot.
  computeStatus(page, link) {
    if (!link) return 'new';
    if (link.conflict_state === 'detected') return 'conflict';
    const lastSync = _latest(link.last_pushed_at, link.last_pulled_at);
    const localUpdated = _latest(page.updated_at, link.headline_updated_at);
    if (localUpdated && lastSync && localUpdated > lastSync) return 'push-needed';
    return 'synced';
  },
  statusLabels: {
    synced: 'blog.status.synced',
    'push-needed': 'blog.status.pushNeeded',
    conflict: 'blog.status.conflict',
    new: 'blog.status.newLocal',
  },
  canPushStatuses: ['new', 'push-needed'],
  pushErrorCode: 'BLOG_PUSH_FAILED',
  // WordPress-Frontend-URL fuer eine verlinkte Page (`?p=ID` funktioniert
  // unabhaengig vom Permalink-Setup; bei Drafts liefert WP eine Preview-/
  // Login-Seite, je nach Session des Browsers).
  viewUrl(page, providerMeta, link) {
    if (!link || !link.wp_post_id || !providerMeta?.baseUrl) return '';
    const base = providerMeta.baseUrl.replace(/\/$/, '');
    return `${base}/?p=${link.wp_post_id}`;
  },
  spreadExt: {
    hasConflict: true,
    conflictOpen: null,
    conflictData: null,

    async openConflict(pageId) {
      const bookId = Alpine.store('nav').selectedBookId;
      if (!bookId) return;
      this.conflictOpen = pageId;
      this.conflictData = null;
      try {
        const { contentRepo } = await import('../repo/content.js');
        const [remoteRes, localPage] = await Promise.all([
          fetch(`/blog/${bookId}/pages/${pageId}/remote`).then(r => r.ok ? r.json() : Promise.reject(r)),
          // fresh: der Diff ist die Entscheidungsgrundlage "lokal oder WordPress".
          // Aus dem SWR-Cache koennte die lokale Seite AELTER aussehen als sie ist —
          // der User verwaerfe dann eigene Edits, die er im Diff nie gesehen hat.
          contentRepo.loadPage(pageId, { fresh: true }),
        ]);
        this.conflictData = {
          pageId,
          local: { name: localPage.name || localPage.page_name || '', html: localPage.html || localPage.body_html || '' },
          remote: { title: remoteRes.title || '', html: remoteRes.html || '', modifiedAt: remoteRes.modifiedAt || '' },
        };
      } catch (e) {
        console.error('[blogSync] Konflikt-Diff laden fehlgeschlagen:', e);
        this.conflictOpen = null;
      }
    },

    closeConflict() {
      this.conflictOpen = null;
      this.conflictData = null;
    },

    async resolveConflict(side) {
      if (!this.conflictOpen) return;
      const bookId = Alpine.store('nav').selectedBookId;
      const pageId = this.conflictOpen;
      try {
        const res = await fetch(`/blog/${bookId}/pages/${pageId}/resolve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resolve: side }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error_code || 'BLOG_RESOLVE_FAILED');
        this.closeConflict();
        await this.loadLinks();
        // Der Server hat die Seite gerade ueberschrieben (kein Bust im Browser).
        // Hat der WP-Titel den Seitennamen geaendert, zieht _applyPushRenames
        // auch den offenen Editor-Titel nach (und laedt den Tree).
        if (side === 'wp') {
          if (data.name) this._applyPushRenames({ result: { renamed: [{ pageId, name: data.name }] } });
          else window.__app?.loadPages?.({ source: 'job' });
        }
      } catch (e) {
        console.error('[blogSync] Resolve fehlgeschlagen:', e);
      }
    },
  },
  onBookChange() {
    this.conflictOpen = null;
    this.conflictData = null;
  },
};

export function registerBlogSyncCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('blogSyncCard', createSyncCard(blogSpec));
}
