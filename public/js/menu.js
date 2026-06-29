// Aktions-/Dropdown-Menü (Meatball) — Verhaltens-Primitiv für die VERANKERTE
// Variante des `.context-menu`-Patterns (siehe DESIGN.md „Dropdown-/Aktions-
// Menü (Meatball)"). Besitzt den Open-State und kapselt das überall gleiche
// Verhalten: Toggle, Outside-Click-Close, Escape-Close und Auto-Close beim
// Klick auf einen Menüeintrag — analog combobox / collapsible.
//
// WICHTIG: Das Primitiv ersetzt NUR das Verhalten, NICHT das Markup-Vokabular.
// Trigger bleibt der Icon-Button `more-horizontal`, Einträge bleiben
// `.context-menu-item--icon` mit führendem Icon, Trenner `.context-menu-sep` —
// genau wie in DESIGN.md vorgeschrieben und durch context-menu-icons.test.mjs
// gegated. Nur die teleportierte (JS-positionierte) Variante bleibt
// hand-verdrahtet (case-spezifische Positionierung).
//
// Pflicht-Markup (2 x-bind-Spreads; Wrapper braucht nur `x-data="menu()"` —
// init() setzt die `.menu-anchor`-Klasse mit position: relative):
//
//   <span x-data="menu()">
//     <button class="icon-btn icon-btn--ghost" x-bind="trigger"
//             aria-haspopup="menu" :data-tip="t('…')" :aria-label="t('…')">
//       <svg class="icon" aria-hidden="true"><use href="/icons.svg#more-horizontal"/></svg>
//     </button>
//     <div class="context-menu context-menu--dropdown" x-bind="panel" x-cloak>
//       <button class="context-menu-item context-menu-item--icon" role="menuitem"
//               @click="action()">
//         <svg class="icon" aria-hidden="true"><use href="/icons.svg#pencil"/></svg>
//         <span x-text="t('…')"></span>
//       </button>
//     </div>
//   </span>
//
// - `trigger` spreadet auf den Trigger-Button (@click-Toggle + :aria-expanded).
// - `panel` spreadet aufs Popover (x-show + role="menu"). `x-cloak` selbst
//   setzen (x-bind transportiert x-cloak nicht zuverlässig).
// - Einträge brauchen KEIN `; menuOpen=false` mehr: ein Klick auf irgendein
//   `.context-menu-item` / `[role=menuitem]` schliesst das Menü automatisch
//   (Event-Delegation, nach dem Item-Handler).
// - Den Active-Zustand des Triggers kann der Konsument via `:class="{ 'is-active': open }"`
//   binden — `open` liegt im selben x-data-Scope.

export function menuData() {
  return {
    open: false,
    _rootEl: null,
    _onOutside: null,
    _onKeydown: null,
    _onItemClick: null,

    toggle() { this.open ? this.close() : this.openMenu(); },
    openMenu() {
      this.open = true;
      // Ersten Eintrag fokussieren (Tastatur-Bedienung). Der native Button-
      // Outline ist das Fokus-Signal (kein eigener Ring, siehe Fokus-Regel).
      this.$nextTick(() => {
        this._rootEl?.querySelector('.context-menu [role=menuitem], .context-menu-item')?.focus();
      });
    },
    close() { this.open = false; },

    get trigger() {
      return {
        type: 'button',
        ['@click']: () => this.toggle(),
        [':aria-expanded']: () => (this.open ? 'true' : 'false'),
      };
    },
    get panel() {
      return {
        role: 'menu',
        ['x-show']: () => this.open,
      };
    },

    init() {
      this._rootEl = this.$el;
      this._rootEl.classList.add('menu-anchor');

      // Outside-Click schliesst (mousedown, wie combobox — vor dem Klick-Event,
      // damit ein Klick neben dem Menü es zumacht statt durchzuschalten).
      this._onOutside = (e) => {
        if (this.open && !this._rootEl.contains(e.target)) this.close();
      };
      document.addEventListener('mousedown', this._onOutside);

      // Escape schliesst (window-weit, wie das DESIGN.md-Pattern
      // @keydown.escape.window).
      this._onKeydown = (e) => {
        if (e.key === 'Escape' && this.open) { this.close(); }
      };
      window.addEventListener('keydown', this._onKeydown);

      // Auto-Close beim Klick auf einen Eintrag: das Item-@click läuft zuerst
      // (Bubble-Phase, näher am Target), danach diese Delegation → Aktion
      // ausgeführt, dann zu. Trigger-Klick ist kein Menüeintrag → bleibt offen-
      // toggelnd. stopPropagation() in einem Item-Handler unterdrückt das
      // bewusst (dann schliesst der Konsument selbst).
      this._onItemClick = (e) => {
        if (!this.open) return;
        if (e.target.closest('.context-menu-item, [role=menuitem]')) this.close();
      };
      this._rootEl.addEventListener('click', this._onItemClick);
    },

    destroy() {
      if (this._onOutside) document.removeEventListener('mousedown', this._onOutside);
      if (this._onKeydown) window.removeEventListener('keydown', this._onKeydown);
      if (this._onItemClick && this._rootEl) this._rootEl.removeEventListener('click', this._onItemClick);
      this._onOutside = this._onKeydown = this._onItemClick = null;
    },
  };
}

export function registerMenu() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('menu', () => menuData());
}
