// Phase 4a (BookStack-Exit, docs/bookstack-exit.md): AdminUsersCard-Methods.
// Wird im adminUsersCard-Alpine-Scope gespreaded. Root-Zugriffe ueber
// `window.__app`, weil Alpine-Magics in JS-Methoden nicht zuverlaessig sind.

export const adminUsersMethods = {
  async adminUsersLoad() {
    if (this.adminUsersLoading) return;
    this.adminUsersLoading = true;
    this.adminUsersError = '';
    try {
      const r = await fetch('/admin/users', { credentials: 'same-origin' });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error_code || `HTTP ${r.status}`);
      }
      const data = await r.json();
      this.adminUsersList = data.users || [];
    } catch (e) {
      this.adminUsersError = e.message;
    } finally {
      this.adminUsersLoading = false;
    }
  },

  async adminUsersInvite() {
    const email = (this.adminUsersInviteEmail || '').trim();
    if (!email) return;
    this.adminUsersInviting = true;
    this.adminUsersError = '';
    this.adminUsersInviteResult = null;
    try {
      const r = await fetch('/admin/users/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, role: this.adminUsersInviteRole || 'user' }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      this.adminUsersInviteResult = {
        email: j.invite.email,
        token: j.invite.invite_token,
        url: `${location.origin}/login?returnTo=${encodeURIComponent('/?invite=' + j.invite.invite_token)}`,
      };
      this.adminUsersInviteEmail = '';
    } catch (e) {
      this.adminUsersError = e.message;
    } finally {
      this.adminUsersInviting = false;
    }
  },

  async adminUsersUpdate(user, patch) {
    this.adminUsersError = '';
    try {
      const r = await fetch(`/admin/users/${encodeURIComponent(user.email)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      const idx = this.adminUsersList.findIndex(u => u.email === user.email);
      if (idx >= 0) this.adminUsersList.splice(idx, 1, j.user);
    } catch (e) {
      this.adminUsersError = e.message;
    }
  },

  async adminUsersDelete(user) {
    const me = window.__app?.currentUser?.email;
    if (user.email === me) { this.adminUsersError = 'CANNOT_DELETE_SELF'; return; }
    if (!confirm(window.__app?.t?.('admin.users.confirmDelete', { email: user.email }) || `Soft-Delete ${user.email}?`)) return;
    this.adminUsersError = '';
    try {
      const r = await fetch(`/admin/users/${encodeURIComponent(user.email)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error_code || `HTTP ${r.status}`);
      }
      await this.adminUsersLoad();
    } catch (e) {
      this.adminUsersError = e.message;
    }
  },

  async adminUsersToggleAudit(user) {
    if (this.adminUsersAuditEmail === user.email) {
      this.adminUsersAuditEmail = null;
      this.adminUsersAuditEvents = [];
      return;
    }
    this.adminUsersAuditEmail = user.email;
    this.adminUsersAuditEvents = [];
    try {
      const r = await fetch(`/admin/users/${encodeURIComponent(user.email)}/audit?limit=50`, {
        credentials: 'same-origin',
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      this.adminUsersAuditEvents = j.events || [];
    } catch (e) {
      this.adminUsersError = e.message;
    }
  },

  async adminUsersCopyInviteUrl() {
    if (!this.adminUsersInviteResult?.url) return;
    try {
      await navigator.clipboard.writeText(this.adminUsersInviteResult.url);
      this.adminUsersCopied = true;
      setTimeout(() => { this.adminUsersCopied = false; }, 1500);
    } catch {}
  },

  // ─── Phase 4a2: Registration-Requests ──────────────────────────────────

  async adminUsersRequestsLoad() {
    if (this.adminUsersRequestsLoading) return;
    this.adminUsersRequestsLoading = true;
    this.adminUsersError = '';
    try {
      const status = this.adminUsersRequestsStatus || 'pending';
      const r = await fetch(`/admin/registration-requests?status=${encodeURIComponent(status)}`, {
        credentials: 'same-origin',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error_code || `HTTP ${r.status}`);
      }
      const data = await r.json();
      this.adminUsersRequestsList = data.items || [];
    } catch (e) {
      this.adminUsersError = e.message;
    } finally {
      this.adminUsersRequestsLoading = false;
    }
  },

  async adminUsersApproveRequest(req, role = 'user') {
    if (!req || this.adminUsersRequestsBusy) return;
    this.adminUsersRequestsBusy = req.id;
    this.adminUsersError = '';
    this.adminUsersRequestsResult = null;
    try {
      const r = await fetch(`/admin/registration-requests/${req.id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ role }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      this.adminUsersRequestsResult = { id: req.id, inviteUrl: j.inviteUrl, mail: j.mail };
      await this.adminUsersRequestsLoad();
      await this.adminUsersLoad();
    } catch (e) {
      this.adminUsersError = e.message;
    } finally {
      this.adminUsersRequestsBusy = null;
    }
  },

  async adminUsersDenyRequest(req) {
    if (!req || this.adminUsersRequestsBusy) return;
    const reason = window.prompt(
      window.__app?.t?.('admin.users.requests.denyReasonPrompt') || 'Begründung (optional):'
    );
    // null = Cancel → abbrechen; '' = bestaetigt ohne Reason → erlauben.
    if (reason === null) return;
    this.adminUsersRequestsBusy = req.id;
    this.adminUsersError = '';
    try {
      const r = await fetch(`/admin/registration-requests/${req.id}/deny`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ reason }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      await this.adminUsersRequestsLoad();
    } catch (e) {
      this.adminUsersError = e.message;
    } finally {
      this.adminUsersRequestsBusy = null;
    }
  },

  async adminUsersCopyRequestInviteUrl(id, url) {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.adminUsersRequestsCopiedId = id;
      setTimeout(() => { this.adminUsersRequestsCopiedId = null; }, 1500);
    } catch {}
  },
};
