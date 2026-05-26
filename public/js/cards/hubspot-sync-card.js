// Alpine.data('hubspotSyncCard') — HubSpot-Sync-Provider. Thin Wrapper über
// `createSyncCard` (sync/sync-core.js). Status-Modell minimal: 'new' (kein
// Link) und 'pushed' (Link existiert). Re-Push ist blockiert, HubSpot übernimmt
// den weiteren Workflow (Finalisieren, Einplanen, Publizieren).
// Headless display-contents-Anker, via `$hubspot`-Magic global erreichbar.

import { createSyncCard } from './sync/sync-core.js';

const hubspotSpec = {
  key: 'hubspot',
  endpointBase: '/hubspot',
  jobTypes: {
    push: 'hubspot-push',
    refresh: ['hubspot-import'],
  },
  computeStatus(page, link) {
    return link ? 'pushed' : 'new';
  },
  statusLabels: {
    new: 'hubspot.status.new',
    pushed: 'hubspot.status.pushed',
  },
  canPushStatuses: ['new'],
  pushErrorCode: 'HUBSPOT_PUSH_FAILED',
};

export function registerHubspotSyncCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('hubspotSyncCard', createSyncCard(hubspotSpec));
}
