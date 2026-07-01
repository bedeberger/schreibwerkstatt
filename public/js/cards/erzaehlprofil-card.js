// Alpine.data('erzaehlprofilCard') — Sub-Komponente der Erzählprofil-Karte.
// Zeigt das in der Komplettanalyse-Phase «Erzählprofil» erzeugte Kapitel-Profil
// (POV/Erzählzeit + Abweichung, Spannungskurve, Themen/Motive). Rein lesend.

import { erzaehlprofilMethods } from '../book/erzaehlprofil.js';
import { setupCardLifecycle } from './card-lifecycle.js';

export function registerErzaehlprofilCard() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('erzaehlprofilCard', () => ({
    erzaehlprofilResult: null,
    _lifecycle: null,

    init() {
      const doReset = (ctx) => { ctx.erzaehlprofilResult = null; };
      this._lifecycle = setupCardLifecycle(this, {
        name: 'erzaehlprofil',
        showFlag: 'showErzaehlprofilCard',
        onShow: async () => { await this._loadErzaehlprofil(); },
        load: () => this._loadErzaehlprofil(),
        onBookChanged: async (e, ctx, root) => {
          doReset(ctx);
          if (!root.showErzaehlprofilCard) return;
          if (!Alpine.store('nav').selectedBookId) return;
          await ctx._loadErzaehlprofil();
        },
        onViewReset: (e, ctx) => doReset(ctx),
      });
    },

    destroy() { this._lifecycle?.destroy(); },

    ...erzaehlprofilMethods,
  }));
}
