// AdminSettingsCard-Methods.

export const adminSettingsMethods = {
  async adminSettingsLoad() {
    if (this.adminSettingsLoading) return;
    this.adminSettingsLoading = true;
    this.adminSettingsError = '';
    try {
      const r = await fetch('/admin/settings', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const map = {};
      for (const s of data.settings) {
        map[s.key] = s;
      }
      this.adminSettingsMap = map;
      // Form-State aus map kopieren — Form-Inputs schreiben in form, Save
      // diff't vs. map und sendet nur geaenderte Keys ans Backend.
      this.adminSettingsForm = this._adminSettingsBuildForm(map);
      const cur = this.adminSettingsForm['ai.provider'];
      if (cur === 'claude' || cur === 'ollama' || cur === 'openai-compat') {
        this.adminSettingsProviderSubtab = cur;
      }
    } catch (e) {
      this.adminSettingsError = e.message;
    } finally {
      this.adminSettingsLoading = false;
    }
  },

  _adminSettingsBuildForm(map) {
    const form = {};
    for (const key of Object.keys(map)) {
      const s = map[key];
      // Encrypted: leerer String, dann user kann ueberschreiben; sonst
      // Sentinel __unchanged__ beim Save.
      form[key] = s.encrypted ? '' : (s.value ?? '');
    }
    return form;
  },

  _adminSettingsCoerceValue(key, raw) {
    const s = this.adminSettingsMap[key];
    if (!s) return raw;
    if (s.encrypted) {
      // Leerer Input → __unchanged__-Sentinel; sonst Klartext-Wert
      return raw === '' ? '__unchanged__' : raw;
    }
    const def = s.value;
    if (typeof def === 'boolean') return raw === 'true' || raw === true;
    if (typeof def === 'number') {
      const n = Number(raw);
      return Number.isFinite(n) ? n : def;
    }
    return raw;
  },

  async adminSettingsSave() {
    if (this.adminSettingsSaving) return;
    this.adminSettingsSaving = true;
    this.adminSettingsError = '';
    this.adminSettingsSaved = false;
    const dirty = [];
    for (const key of Object.keys(this.adminSettingsForm)) {
      const s = this.adminSettingsMap[key];
      if (!s) continue;
      const raw = this.adminSettingsForm[key];
      const coerced = this._adminSettingsCoerceValue(key, raw);
      if (s.encrypted) {
        if (coerced !== '__unchanged__') dirty.push({ key, value: coerced });
      } else {
        if (JSON.stringify(coerced) !== JSON.stringify(s.value)) dirty.push({ key, value: coerced });
      }
    }
    try {
      for (const d of dirty) {
        const r = await fetch(`/admin/settings/${encodeURIComponent(d.key)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ value: d.value }),
        });
        if (!r.ok) {
          const j = await r.json().catch(() => ({}));
          throw new Error(`${d.key}: ${j.error_code || r.status}`);
        }
      }
      this.adminSettingsSavedCount = dirty.length;
      this.adminSettingsSaved = true;
      setTimeout(() => { this.adminSettingsSaved = false; }, 2500);
      await this.adminSettingsLoad();
    } catch (e) {
      this.adminSettingsError = e.message;
    } finally {
      this.adminSettingsSaving = false;
    }
  },

  async adminSettingsTest(kind) {
    const path = kind === 'provider'     ? '/admin/settings/test-provider'
               : kind === 'oauth'        ? '/admin/settings/test-oauth'
               : kind === 'smtp'         ? '/admin/settings/smtp/test-send'
               : kind === 'languagetool' ? '/admin/settings/test-languagetool'
               : kind === 'geocode'      ? '/admin/settings/test-geocode'
               : null;
    if (!path) return;
    this.adminSettingsTestResult = { kind, running: true };
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: kind === 'smtp' ? JSON.stringify({}) : undefined,
      });
      const j = await r.json();
      this.adminSettingsTestResult = { kind, ...j, running: false };
    } catch (e) {
      this.adminSettingsTestResult = { kind, ok: false, error: e.message, running: false };
    }
  },

  adminSettingsSwitchTab(tab) {
    this.adminSettingsTab = tab;
    if (tab === 'api' && !this.adminApiTokensLoaded) {
      this.adminApiTokensLoad();
    }
  },

  // ── API-Tokens (Tab `api`) ──────────────────────────────────────────────
  // Plain-Token wird vom Server NUR einmal nach POST zurueckgegeben und im
  // Frontend in `adminApiTokensJustCreated` zwischengespeichert, bis der
  // User ihn ueber „Verbergen" wegklickt. DB speichert nur den SHA-256-Hash.

  async adminApiTokensLoad() {
    if (this.adminApiTokensLoading) return;
    this.adminApiTokensLoading = true;
    this.adminApiTokensError = '';
    try {
      const r = await fetch('/admin/api-tokens', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      this.adminApiTokensList = Array.isArray(data.tokens) ? data.tokens : [];
      this.adminApiTokensLoaded = true;
    } catch (e) {
      this.adminApiTokensError = e.message;
    } finally {
      this.adminApiTokensLoading = false;
    }
  },

  async adminApiTokensCreate() {
    const name = (this.adminApiTokensNewName || '').trim();
    if (!name) {
      this.adminApiTokensError = window.__app.t('admin.settings.api.errorNameRequired');
      return;
    }
    this.adminApiTokensCreating = true;
    this.adminApiTokensError = '';
    try {
      const body = { display_name: name };
      if (this.adminApiTokensNewExpiresAt) body.expires_at = this.adminApiTokensNewExpiresAt;
      const r = await fetch('/admin/api-tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error_code || `HTTP ${r.status}`);
      this.adminApiTokensJustCreated = j;
      this.adminApiTokensNewName = '';
      this.adminApiTokensNewExpiresAt = '';
      await this.adminApiTokensLoad();
    } catch (e) {
      this.adminApiTokensError = e.message;
    } finally {
      this.adminApiTokensCreating = false;
    }
  },

  async adminApiTokensRevoke(id) {
    if (!confirm(window.__app.t('admin.settings.api.confirmRevoke'))) return;
    try {
      const r = await fetch(`/admin/api-tokens/${id}/revoke`, {
        method: 'POST', credentials: 'same-origin',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error_code || `HTTP ${r.status}`);
      }
      await this.adminApiTokensLoad();
    } catch (e) {
      this.adminApiTokensError = e.message;
    }
  },

  async adminApiTokensDelete(id) {
    if (!confirm(window.__app.t('admin.settings.api.confirmDelete'))) return;
    try {
      const r = await fetch(`/admin/api-tokens/${id}`, {
        method: 'DELETE', credentials: 'same-origin',
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error(j.error_code || `HTTP ${r.status}`);
      }
      await this.adminApiTokensLoad();
    } catch (e) {
      this.adminApiTokensError = e.message;
    }
  },

  async adminApiTokensCopyPlain() {
    const t = this.adminApiTokensJustCreated?.plain_token;
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      this.adminApiTokensCopiedAt = Date.now();
      setTimeout(() => { this.adminApiTokensCopiedAt = 0; }, 2000);
    } catch (_) {}
  },

  adminApiTokensDismissPlain() {
    this.adminApiTokensJustCreated = null;
  },

  adminSettingsIsDirty(key) {
    const s = this.adminSettingsMap[key];
    if (!s) return false;
    const raw = this.adminSettingsForm[key];
    const coerced = this._adminSettingsCoerceValue(key, raw);
    if (s.encrypted) return coerced !== '__unchanged__';
    return JSON.stringify(coerced) !== JSON.stringify(s.value);
  },
};
