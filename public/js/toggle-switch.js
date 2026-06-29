// Toggle-Switch (selbst-rendernd) — Ersatz für `<label class="checkbox-row">
// <input type="checkbox" :checked=… @change=…><span>…</label>`.
//
// Vereinheitlicht das überall verstreute Boolean-Einstellungs-Markup (Admin-
// Settings, Export-Optionen, Kill-Switches) zu einem `role="switch"`-Element —
// analog combobox / num-input / radio-group. `init()` rendert Track + Thumb +
// optionales Label komplett selbst und setzt die `.toggle-switch`-Klasse aufs
// Wrapper-Element. Wrapper-Div leer lassen, nur Attribute setzen.
//
// Verwendung (3 Attribute, Pattern wie radioGroup):
//
//   <div x-data="toggleSwitch({ label: () => $app.t('admin.settings.stt.enabled.label') })"
//        x-modelable="value" x-model="adminSettingsForm['stt.enabled']"></div>
//
// - `value` ist intern immer ein echtes Boolean. Beim Seed werden truthy-
//   Strings (`'true'`, `'1'`) und `1` als `true` interpretiert; beim Toggle
//   wird IMMER ein Boolean zurückgeschrieben (vereinheitlicht den DB-Wert).
// - `x-modelable="value" x-model="ref"` koppelt den internen State ans äussere
//   Feld. Bei Auswahl wird zusätzlich `toggle-change` dispatcht (Detail = neuer
//   Boolean) für Side-Effects (analog `combobox-change` / `radio-change`).
//
// Config-Optionen:
//   label      Funktion oder String → sichtbares Label rechts vom Switch.
//              Weglassen für einen reinen Switch (dann `ariaLabel` setzen).
//   ariaLabel  Funktion oder String → a11y-Name, nur nötig OHNE sichtbares Label.
//   disabled   true → ausgegraut + nicht schaltbar.
//   value      Initialwert (überschrieben von x-model-Seed).

export function toggleSwitchData(cfg = {}) {
  return {
    value: cfg.value ?? false,
    _label: cfg.label ?? null,
    _ariaLabel: cfg.ariaLabel ?? null,
    _disabled: !!cfg.disabled,

    _resolve(v) { return typeof v === 'function' ? v() : v; },

    get label() { return this._resolve(this._label); },
    // a11y-Name nur, wenn KEIN sichtbares Label da ist (sonst Doppel-Labeling:
    // der sichtbare Text im Button ist bereits der Accessible Name).
    get ariaLabel() {
      if (this.label) return null;
      return this._resolve(this._ariaLabel) || null;
    },
    // Truthy-tolerant lesen, damit Felder mit String-'true' (Legacy-Settings)
    // korrekt als „an" anzeigen.
    get on() {
      const v = this.value;
      return v === true || v === 'true' || v === 1 || v === '1';
    },

    toggle() {
      if (this._disabled) return;
      this.value = !this.on; // schreibt echtes Boolean zurück
      this.$dispatch('toggle-change', this.value);
    },

    init() {
      this.$el.classList.add('toggle-switch');
      const template = [
        '<button type="button" class="toggle-switch__btn" role="switch"',
        '        :aria-checked="on ? \'true\' : \'false\'" :disabled="_disabled"',
        '        :aria-label="ariaLabel" @click="toggle()">',
        '  <span class="toggle-switch__track" :class="{ \'is-on\': on }" aria-hidden="true">',
        '    <span class="toggle-switch__thumb"></span>',
        '  </span>',
        '  <span class="toggle-switch__label" x-show="!!label" x-text="label"></span>',
        '</button>',
      ].join('\n');
      this.$el.innerHTML = template;
      // Analog combobox/radioGroup: frisch gesetztes Markup explizit
      // initialisieren, falls der Switch in einem spät hydratisierten Subtree
      // liegt (z. B. tab-gewechselte Settings-Sektion).
      window.Alpine.initTree(this.$el);
    },
  };
}

export function registerToggleSwitch() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('toggleSwitch', (cfg = {}) => toggleSwitchData(cfg));
}
