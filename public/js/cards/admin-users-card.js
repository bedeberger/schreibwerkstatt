// Phase 4a (BookStack-Exit, docs/bookstack-exit.md): Alpine-Sub-Komponente
// fuer die Admin-User-Liste. Sichtbarkeit ueber $app.currentUser.role; State
// + Lifecycle hier, Show-Flag (`showAdminUsersCard`) im Root.

import { adminUsersMethods } from '../admin-users.js';

export function registerAdminUsersCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('adminUsersCard', () => ({
    adminUsersList: [],
    adminUsersLoading: false,
    adminUsersError: '',
    adminUsersInviteEmail: '',
    adminUsersInviteRole: 'user',
    adminUsersInviting: false,
    adminUsersInviteResult: null,
    adminUsersCopied: false,
    adminUsersAuditEmail: null,
    adminUsersAuditEvents: [],
    // Phase 4a2: Registration-Requests-Tab.
    adminUsersTab: 'users',                  // 'users' | 'requests'
    adminUsersRequestsList: [],
    adminUsersRequestsStatus: 'pending',     // pending|approved|denied|expired|all
    adminUsersRequestsLoading: false,
    adminUsersRequestsBusy: null,            // id during approve/deny
    adminUsersRequestsResult: null,          // { id, inviteUrl, mail }
    adminUsersRequestsCopiedId: null,

    _onViewReset: null,

    init() {
      this.$watch(() => window.__app.showAdminUsersCard, async (visible) => {
        if (!visible) return;
        await this.adminUsersLoad();
        if (this.adminUsersTab === 'requests') await this.adminUsersRequestsLoad();
      });
      this.$watch(() => this.adminUsersTab, async (tab) => {
        if (tab === 'requests') await this.adminUsersRequestsLoad();
      });
      this.$watch(() => this.adminUsersRequestsStatus, async () => {
        if (this.adminUsersTab === 'requests') await this.adminUsersRequestsLoad();
      });
      this._onViewReset = () => {
        this.adminUsersError = '';
        this.adminUsersInviteResult = null;
        this.adminUsersAuditEmail = null;
        this.adminUsersAuditEvents = [];
        this.adminUsersRequestsResult = null;
      };
      window.addEventListener('view:reset', this._onViewReset);
    },

    destroy() {
      if (this._onViewReset) window.removeEventListener('view:reset', this._onViewReset);
    },

    ...adminUsersMethods,
  }));
}
