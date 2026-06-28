// Alpine.data('hubspotSyncCard') — HubSpot-Sync-Provider. Thin Wrapper über
// `createSyncCard` (sync/sync-core.js). Status-Modell:
//   'new'          — kein Link, Push erstellt Draft-Post.
//   'pushed-dirty' — Link existiert, App-Page lokal geändert seit letztem
//                    Sync-Punkt → Re-Push erlaubt (mit Warn-Dialog).
//   'pushed'       — Link existiert, lokal seit Sync unverändert.
//
// Re-Push aktualisiert via PATCH den HubSpot-Draft-Buffer; die Live-Version
// drüben bleibt unverändert, bis der User den Buffer in HubSpot publiziert.
// HubSpot-spezifische Formatierungen (Module, CTAs, Bilder, Forms) im Live-
// Post werden im Buffer durch den App-HTML-Body ersetzt — darum erst Dialog.
//
// Headless display-contents-Anker, via `$hubspot`-Magic global erreichbar.

import { createSyncCard } from './sync/sync-core.js';

function _syncBaseline(link) {
  return link?.last_pushed_at || link?.hubspot_created_at || '';
}

const hubspotSpec = {
  key: 'hubspot',
  endpointBase: '/hubspot',
  jobTypes: {
    push: 'hubspot-push',
    refresh: ['hubspot-import'],
    reconcile: 'hubspot-reconcile',
  },
  computeStatus(page, link) {
    if (!link) return 'new';
    const baseline = _syncBaseline(link);
    const updated = page?.updated_at || '';
    if (updated && baseline && updated > baseline) return 'pushed-dirty';
    return 'pushed';
  },
  statusLabels: {
    new: 'hubspot.status.new',
    pushed: 'hubspot.status.pushed',
    'pushed-dirty': 'hubspot.status.pushedDirty',
  },
  canPushStatuses: ['new', 'pushed-dirty'],
  pushErrorCode: 'HUBSPOT_PUSH_FAILED',
  // PUBLISHED: absolute Live-Post-URL. DRAFT: Editor-URL — ohne Login waere
  // der Draft drueben sonst nicht aufrufbar (HubSpot zeigt sonst nur Preview-
  // Stub). `portalId` liefert `/hubspot/:bookId/links` mit, mit Self-Heal fuer
  // Pre-150-Connections.
  viewUrl(page, providerMeta, link) {
    if (!link) return '';
    if (link.hubspot_state === 'DRAFT' && providerMeta?.portalId && link.hubspot_post_id) {
      return `https://app.hubspot.com/blog/${providerMeta.portalId}/editor/${link.hubspot_post_id}/content`;
    }
    return link.hubspot_url || '';
  },
  // Re-Push (Status 'pushed-dirty') öffnet erst einen Warn-Dialog. User muss
  // aktiv bestätigen, dass HubSpot-spezifische Formatierungen im Buffer durch
  // den App-Body überschrieben werden. Erst-Push ('new') läuft ohne Confirm.
  async confirmPush(pageId) {
    const root = window.__app;
    if (!root) return true;
    const page = (Alpine.store('nav').pages || []).find(p => p.id === pageId);
    if (!page || this.statusFor(page) !== 'pushed-dirty') return true;
    const pageName = page.name || '';
    return !!(await root.appConfirm({
      message: root.t('hubspot.repush.warning', { pageName }),
      confirmLabel: root.t('hubspot.repush.confirm'),
      cancelLabel: root.t('common.cancel'),
    }));
  },
};

export function registerHubspotSyncCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('hubspotSyncCard', createSyncCard(hubspotSpec));
}
