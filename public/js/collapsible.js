// Alpine.data('collapsible') — wiederverwendbare klappbare Sektion.
//
// SSoT für das DESIGN.md-Pattern `.collapsible-toggle` + `.history-chevron`.
// Besitzt den Open-State, die Toggle-Logik, die ARIA-Kopplung und die
// Chevron-Rotation — Konsumenten verdrahten nichts mehr von Hand.
//
// Pflicht-Markup (3 x-bind-Spreads):
//   <div x-data="collapsible()">                          <!-- collapsible(true) für initial offen -->
//     <button type="button" class="collapsible-toggle" x-bind="trigger">
//       <span class="history-chevron" x-bind="chevron" aria-hidden="true"></span>
//       <span x-text="label"></span>
//     </button>
//     <div x-bind="panel" x-cloak> … </div>
//   </div>
//
// Geteilter / persistierter State (Parent steuert open): zusätzlich
//   x-modelable="open" x-model="parentVar"
// koppeln — analog combobox/numInput.
//
// Der `.history-chevron`-Span braucht KEINEN Inhalt (CSS-Mask-Icon, rotiert via
// `.open`); `aria-hidden` setzen, Label kommt als separates Geschwister.

export function registerCollapsible() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('collapsible', (initialOpen = false) => ({
    open: !!initialOpen,

    toggle() { this.open = !this.open; },

    // Spread auf das Trigger-<button>.
    get trigger() {
      return {
        type: 'button',
        ['@click']: () => { this.toggle(); },
        [':aria-expanded']: () => this.open,
      };
    },

    // Spread auf den <span class="history-chevron">.
    get chevron() {
      return { [':class']: () => ({ open: this.open }) };
    },

    // Spread auf das aufklappbare Panel.
    get panel() {
      return { ['x-show']: () => this.open };
    },
  }));
}
