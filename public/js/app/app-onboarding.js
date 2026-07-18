// Root-Methoden fuer das Onboarding: First-Login-Willkommens-Banner. Die
// eigentliche „Erste Schritte"-Karte lebt in cards/onboarding-card.js; hier nur
// der buch-unabhaengige Banner-State am Root (onboardingWelcome) + sein Loader
// und die zwei Banner-Aktionen. Persistiert wird das Wegklicken serverseitig
// (app_users.onboarding_state.welcomeDismissed) via PATCH /me/onboarding.
export const appOnboardingMethods = {
  // Beim Bootstrap aufgerufen (app-init): Banner nur zeigen, solange der User
  // ihn weder weggeklickt noch das Onboarding abgeschlossen hat. Non-blocking.
  async _loadOnboardingWelcome() {
    try {
      const res = await fetch('/me/onboarding', { headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const data = await res.json();
      const st = data?.state || {};
      this.onboardingWelcome = !st.welcomeDismissed && !st.completed;
    } catch { /* non-fatal — kein Banner, kein Fehler */ }
  },

  // Banner-CTA: „Erste Schritte" oeffnen (schliesst Banner, offene Karte laedt
  // ihren Fortschritt selbst).
  async openOnboardingFromWelcome() {
    this.onboardingWelcome = false;
    if (!this.showOnboardingCard) await this.toggleOnboardingCard();
  },

  // Banner wegklicken: sofort ausblenden + serverseitig merken.
  async dismissOnboardingWelcome() {
    this.onboardingWelcome = false;
    try {
      await fetch('/me/onboarding', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ welcomeDismissed: true }),
      });
    } catch { /* non-fatal — Banner bleibt lokal ausgeblendet */ }
  },
};
