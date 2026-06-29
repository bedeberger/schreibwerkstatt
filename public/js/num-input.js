// Locale-aware Zahlen-Input.
//
// Ersetzt `<input type="number">` + `x-model.number`. Native `type=number`
// versteckt Tausendertrennzeichen und akzeptiert je nach Browser-Locale nur
// einen Decimal-Separator. Diese Komponente normalisiert:
//   - Anzeige: toLocaleString(uiLocale → de-CH / en-US) mit Tausenderseparator
//   - Eingabe: akzeptiert Apostroph/Spaces als Tausender (werden gestrippt)
//                und sowohl `.` als auch `,` als Decimal-Separator
//
// Verwendung (DESIGN.md-konform, Pattern wie combobox):
//
//   <input class="form-num"
//          x-data="numInput({ step: 0.1, min: 0, max: 2 })"
//          x-modelable="value" x-model="parentField">
//
// Pflicht-Attribute (3): `x-data="numInput(cfg)"`, `x-modelable="value"`,
// `x-model="..."`. `init()` setzt `inputmode`/`autocomplete`/`spellcheck`
// und haengt Event-Handler an — Konsumenten brauchen keine `@input/@blur/@focus`.
//
// Config-Optionen:
//   step      Zahl. Wird auch zur Inferenz der Dezimalstellen genutzt.
//   min/max   Inklusiver Bereich. Clamping bei Blur (nicht beim Tippen,
//               damit `5` -> `50` nicht vor Eingabe auf `min` gesnapped wird).
//   decimals  Explicit override fuer Dezimalstellen. Sonst aus `step` abgeleitet.
//   integer   true → step=1, Dezimal=0, inputmode=numeric.
//   grouping  Default true. false = ohne Tausenderseparator.

// ── Pure helpers (unit-testbar) ─────────────────────────────────────────────

export function inferDecimals(cfg) {
  if (cfg.integer) return 0;
  if (cfg.decimals != null) return cfg.decimals;
  const s = String(cfg.step ?? 1);
  const dot = s.indexOf('.');
  return dot >= 0 ? s.length - dot - 1 : 0;
}

export function localeTagFromUi(uiLocale) {
  return uiLocale === 'en' ? 'en-US' : 'de-CH';
}

export function formatNum(n, opts) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '';
  const d = opts.decimals ?? 0;
  return Number(n).toLocaleString(opts.localeTag || 'de-CH', {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
    useGrouping: opts.grouping !== false,
  });
}

// Editier-Form ohne Tausenderseparator, mit fester Dezimalstellenzahl.
// Decimal-Separator ist immer `.` (locale-unabhaengig waehrend Edit, weil JS
// `parseFloat` nur `.` versteht — Parser akzeptiert beim Lesen beides).
export function formatNumRaw(n, opts) {
  if (n == null || n === '' || !Number.isFinite(Number(n))) return '';
  const d = opts.decimals ?? 0;
  return d > 0 ? Number(n).toFixed(d) : String(Math.trunc(Number(n)));
}

export function parseNum(str) {
  if (str == null) return null;
  let s = String(str).trim();
  if (!s) return null;
  // Tausenderseparatoren: Whitespace, NBSP, narrow-NBSP, ASCII-Apostroph,
  // typographischer Apostroph (Swiss).
  s = s.replace(/[\s  '’]/g, '');
  // Decimal-Separator: akzeptiere `.` und `,`.
  // Wenn beides vorkommt, ist `,` ein Tausender-Rest (z.B. en-US '10,000.5'
  // → User hat US-Stil getippt) → strippen. Sonst Komma → Punkt.
  if (s.includes('.')) s = s.replace(/,/g, '');
  else s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

export function clampNum(n, min, max) {
  if (n == null) return null;
  if (min != null && n < min) return min;
  if (max != null && n > max) return max;
  return n;
}

// ── Alpine-Komponente ───────────────────────────────────────────────────────

export function registerNumInput() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('numInput', (cfg = {}) => ({
    value: null,
    _cfg: {
      step: cfg.step ?? 1,
      min: cfg.min,
      max: cfg.max,
      decimals: cfg.decimals,
      integer: cfg.integer === true,
      grouping: cfg.grouping !== false,
    },
    _focused: false,
    _pointerFocus: false,

    _decimals() { return inferDecimals(this._cfg); },
    _isInteger() { return this._decimals() === 0; },
    _localeTag() { return localeTagFromUi(Alpine.store('shell')?.uiLocale); },

    _fmt(n) {
      return formatNum(n, {
        localeTag: this._localeTag(),
        decimals: this._decimals(),
        grouping: this._cfg.grouping,
      });
    },
    _fmtRaw(n) {
      return formatNumRaw(n, { decimals: this._decimals() });
    },

    init() {
      const el = this.$el;
      el.setAttribute('inputmode', this._isInteger() ? 'numeric' : 'decimal');
      el.setAttribute('autocomplete', 'off');
      el.setAttribute('spellcheck', 'false');
      if (!el.classList.contains('num-input')) el.classList.add('num-input');

      // Pointer-Focus (Klick) merken, damit der Caret an die geklickte Stelle
      // darf. Bei Maus-Focus weder reformatieren noch Select-All, sonst
      // verschiebt sich der Text unter dem Cursor / die Auswahl killt den Klick.
      el.addEventListener('mousedown', () => { this._pointerFocus = true; });
      el.addEventListener('focus', () => {
        this._focused = true;
        if (this._pointerFocus) return;
        el.value = this._fmtRaw(this.value);
        // Select-All erleichtert direktes Ueberschreiben (Standard-Erwartung
        // bei Keyboard-Navigation in numerischen Settings-Feldern).
        setTimeout(() => { try { el.select(); } catch (_) {} }, 0);
      });
      el.addEventListener('blur', () => {
        this._focused = false;
        this._pointerFocus = false;
        const clamped = clampNum(this.value, this._cfg.min, this._cfg.max);
        if (clamped !== this.value) this.value = clamped;
        el.value = this._fmt(clamped);
      });
      el.addEventListener('input', () => {
        this.value = parseNum(el.value);
      });

      // Externe Aenderungen (Load/Reset) reformatieren, ausser Edit laeuft.
      this.$watch('value', (v) => {
        if (this._focused) return;
        el.value = this._fmt(v);
      });

      // Locale-Switch (uiLocale-Wechsel im User-Settings) reformatieren.
      this.$watch(() => Alpine.store('shell')?.uiLocale, () => {
        if (this._focused) return;
        el.value = this._fmt(this.value);
      });

      el.value = this._fmt(this.value);
    },
  }));
}
