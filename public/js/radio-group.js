// Radio-Button-Gruppe (selbst-rendernd).
//
// Ersetzt eine handgeschriebene Liste aus
// `<label><input type="radio"><span>…</label>` durch eine einheitliche, aus
// `options` generierte Gruppe — analog combobox und num-input. `init()` rendert
// die Optionen komplett selbst und setzt die `.form-radio-group`-Klasse aufs
// Wrapper-Element. Wrapper-Div leer lassen, nur Attribute setzen.
//
// Verwendung (3 Attribute):
//
//   <div x-data="radioGroup()"
//        x-modelable="value" x-model="bookSettingsRegion"
//        x-effect="options = bookSettingsRegionOptions()"></div>
//
// - `options`: Array `[{ value, label }]`. `value` darf `''` sein (z. B. „nicht
//   gesetzt"). Inline-Expression bzw. Card-Methode im `x-effect` aufbauen.
// - `x-modelable="value" x-model="ref"` koppelt den internen `value`-State an
//   das äussere Feld.
// - Bei Auswahl wird zusätzlich `radio-change` dispatcht (Detail = neuer Wert)
//   für Side-Effects (analog `combobox-change`). Felder, die nicht über
//   `x-model` schreiben (z. B. UI-Sprache via `changeLocale`), seeden `value`
//   per `x-effect` und konsumieren nur `@radio-change`.

export function radioGroupData(cfg = {}) {
  return {
    value: cfg.value ?? null,
    options: [],
    _name: null,
    // Optische Variante: null = plain (Standard), 'card' = umrandete Radio-
    // Karten mit Akzent-Tint (z. B. Folder-Import) → Klasse .form-radio-group--card.
    _variant: cfg.variant ?? null,

    _isSelected(val) {
      return String(this.value ?? '') === String(val);
    },
    select(val) {
      this.value = val;
      this.$dispatch('radio-change', val);
    },
    init() {
      this.$el.classList.add('form-radio-group');
      if (this._variant) this.$el.classList.add('form-radio-group--' + this._variant);
      this.$el.setAttribute('role', 'radiogroup');
      // Gemeinsamer name für native Pfeil-Tastatur-Nav innerhalb der Gruppe.
      this._name = this.$id('radio-group');
      // Optionen mit `disabled: true` werden ausgegraut + nicht wählbar.
      const template = [
        '<template x-for="opt in options" :key="String(opt.value)">',
        '  <label class="form-radio-option" :class="{ \'is-disabled\': opt.disabled }">',
        '    <input type="radio" :name="_name" :value="opt.value"',
        '           :checked="_isSelected(opt.value)" :disabled="opt.disabled"',
        '           @change="select(opt.value)">',
        '    <span x-text="opt.label"></span>',
        '  </label>',
        '</template>',
      ].join('\n');
      this.$el.innerHTML = template;
      // Analog combobox: frisch gesetztes Markup explizit initialisieren, falls
      // die Gruppe in einem spät hydratisierten Subtree liegt.
      window.Alpine.initTree(this.$el);
    },
  };
}

export function registerRadioGroup() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('radioGroup', (cfg = {}) => radioGroupData(cfg));
}
