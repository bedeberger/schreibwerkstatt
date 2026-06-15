// Searchable Dropdown-Combobox.
//
// Ersetzt `<select>` mit Tastatur-Nav, Such-Filter, optionaler Multi-Auswahl
// und Footer-Aktion. `init()` rendert Trigger + Dropdown + Search + Liste
// komplett selbst und ueberschreibt den Inhalt des Wrapper-Divs.
//
// Verwendung (DESIGN.md-konform, Pattern wie num-input):
//
//   <div x-data="combobox(placeholder, emptyLabel?)"
//        x-modelable="value" x-model="selectedRef"
//        x-effect="options = computeOptionsInline()"></div>
//
// Pflicht-Attribute (3): `x-data="combobox(...)"`, `x-modelable="value"`,
// `x-model="..."`. `init()` setzt `combobox-wrap[--compact]`-Klassen,
// document-Mousedown (Outside-Close), Element-Keydown (Tastatur-Nav) und
// ARIA-Rollen — Konsumenten brauchen kein `@click.outside`, kein `@keydown`,
// keine `class`-Attribute.

// comboboxData: pure Factory ohne Alpine-Registrierung. Wird von
// `registerCombobox` UND von Wrapper-Komponenten (z. B. `catalogFilter`)
// genutzt, damit Spezialisierungen die volle Combobox-Mechanik erben statt
// sie zu reimplementieren. cfg-Form deckt sich mit der Object-Variante von
// `combobox(...)` aus den Templates: { placeholder, emptyLabel, compact,
// multiple, transient, footer }. Sowohl `placeholder` als auch `emptyLabel`
// duerfen Funktionen sein (fuer reaktive i18n-Aufloesung).
export function comboboxData(cfg = {}) {
  if (cfg.compact === undefined) cfg.compact = true;
  return {
      open: false,
      query: '',
      // Single mode: scalar; Multi mode: Array. x-modelable seeded from parent.
      value: cfg.multiple ? [] : null,
      options: [],
      _disabled: false,
      _placeholder: cfg.placeholder ?? null,
      _emptyLabel: cfg.emptyLabel ?? null,
      _compact: cfg.compact !== false,
      _multiple: !!cfg.multiple,
      _transient: !!cfg.transient,
      _footer: (cfg.footer && typeof cfg.footer.action === 'function') ? cfg.footer : null,
      _onOutside: null,
      _onScrollResize: null,
      highlighted: -1,
      openUp: false,

      get placeholder() {
        const p = this._placeholder;
        if (typeof p === 'function') return p() ?? window.__app?.t?.('common.choose') ?? 'Auswählen…';
        return p ?? window.__app?.t?.('common.choose') ?? 'Auswählen…';
      },
      get emptyLabel() {
        const e = this._emptyLabel;
        if (typeof e === 'function') return e() ?? null;
        return e;
      },
      get _allOptions() {
        if (this._multiple) return this.options;
        return this.emptyLabel
          ? [{ value: '', label: this.emptyLabel }, ...this.options]
          : this.options;
      },
      get filtered() {
        if (!this.query) return this._allOptions;
        const q = this.query.toLowerCase();
        // Optionale sublabel (Zweitzeile, z. B. Figuren-Kontext) ist mitsuchbar.
        return this._allOptions.filter(o =>
          String(o.label).toLowerCase().includes(q) ||
          (o.sublabel && String(o.sublabel).toLowerCase().includes(q)));
      },
      _isSelected(val) {
        if (this._multiple) {
          const arr = Array.isArray(this.value) ? this.value : [];
          return arr.some(v => String(v) === String(val));
        }
        return String(this.value ?? '') === String(val);
      },
      get selectedLabel() {
        if (this._multiple) {
          const arr = Array.isArray(this.value) ? this.value : [];
          if (!arr.length) return '';
          const app = window.__app;
          return app?.t ? app.t('common.multiSelected', { n: arr.length }) : `${arr.length}`;
        }
        const v = this.value ?? '';
        const opt = this._allOptions.find(o => String(o.value) === String(v));
        if (opt) return opt.label;
        return this.emptyLabel || '';
      },

      toggle() {
        if (this._disabled) return;
        if (this.open) { this.close(); return; }
        this.open = true;
        this.query = '';
        if (this._multiple) {
          const arr = Array.isArray(this.value) ? this.value : [];
          this.highlighted = arr.length
            ? this._allOptions.findIndex(o => arr.some(v => String(v) === String(o.value)))
            : 0;
        } else {
          this.highlighted = this._allOptions.findIndex(o => String(o.value) === String(this.value));
        }
        this.$nextTick(() => {
          this._positionDropdown();
          this.$refs.cbInput?.focus();
          // Listener erst nach Position + Fokus binden — ein evtl. durch den
          // Fokus ausgeloestes scrollIntoView soll das Dropdown nicht sofort
          // wieder schliessen.
          window.addEventListener('scroll', this._onScrollResize, true);
          window.addEventListener('resize', this._onScrollResize);
        });
      },
      // Dropdown ist `position: fixed` und wird hier an den Trigger gekoppelt —
      // so entkommt es overflow-clippenden Vorfahren (z. B. dem horizontal
      // scrollenden Plot-Swimlane-Grid). Bei Scroll/Resize wird stattdessen
      // geschlossen (siehe _onScrollResize), statt nachzuziehen.
      _positionDropdown() {
        const trigger = this.$el.querySelector('.combobox-trigger');
        const dropdown = this.$el.querySelector('.combobox-dropdown');
        if (!trigger || !dropdown) { this.openUp = false; return; }
        const tr = trigger.getBoundingClientRect();
        const dropdownH = dropdown.getBoundingClientRect().height || 250;
        const spaceBelow = window.innerHeight - tr.bottom;
        const spaceAbove = tr.top;
        this.openUp = spaceBelow < dropdownH && spaceAbove > spaceBelow;

        const margin = 8;
        const width = Math.min(
          Math.max(tr.width, this._compact ? 180 : 0),
          window.innerWidth - margin * 2
        );
        let left = tr.left;
        if (left + width > window.innerWidth - margin) left = window.innerWidth - margin - width;
        if (left < margin) left = margin;
        dropdown.style.left = left + 'px';
        dropdown.style.width = width + 'px';
        if (this.openUp) {
          dropdown.style.top = 'auto';
          dropdown.style.bottom = (window.innerHeight - tr.top) + 'px';
        } else {
          dropdown.style.bottom = 'auto';
          dropdown.style.top = tr.bottom + 'px';
        }
      },
      close() {
        this.open = false;
        this.query = '';
        this.highlighted = -1;
        this.openUp = false;
        window.removeEventListener('scroll', this._onScrollResize, true);
        window.removeEventListener('resize', this._onScrollResize);
      },
      select(val) {
        if (this._multiple) {
          const arr = Array.isArray(this.value) ? this.value : [];
          const idx = arr.findIndex(v => String(v) === String(val));
          this.value = idx >= 0
            ? arr.filter((_, i) => i !== idx)
            : [...arr, val];
          this.$dispatch('combobox-change', this.value);
          return;
        }
        this.value = val;
        this.close();
        this.$dispatch('combobox-change', val);
        if (this._transient) this.value = null;
      },
      triggerFooter() {
        const f = this._footer;
        if (!f || typeof f.action !== 'function') return;
        this.close();
        try { f.action(); } catch (e) { console.error('[combobox.footer]', e); }
      },
      get _footerLabel() {
        const f = this._footer;
        if (!f) return '';
        return typeof f.label === 'function' ? f.label() : (f.label || '');
      },
      onKeydown(e) {
        if (!this.open) {
          if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); this.toggle(); }
          return;
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.highlighted = Math.min(this.highlighted + 1, this.filtered.length - 1);
          this._scrollHl();
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.highlighted = Math.max(this.highlighted - 1, 0);
          this._scrollHl();
        } else if (e.key === 'Enter') {
          e.preventDefault();
          if (this.highlighted >= 0 && this.filtered[this.highlighted]) this.select(this.filtered[this.highlighted].value);
        } else if (e.key === 'Escape') {
          e.preventDefault(); this.close();
        }
      },
      _scrollHl() {
        this.$nextTick(() => {
          const list = this.$el.querySelector('.combobox-list');
          const item = list?.children[this.highlighted];
          item?.scrollIntoView({ block: 'nearest' });
        });
      },
      init() {
        this.$el.classList.add('combobox-wrap');
        if (this._compact) this.$el.classList.add('combobox-wrap--compact');

        this._onOutside = (e) => { if (!this.$el.contains(e.target)) this.close(); };
        // Bei Scroll/Resize schliessen (fixed Dropdown zieht nicht nach). Scroll
        // INNERHALB der eigenen Liste (lange Kapitel-/Figurenliste) darf nicht
        // schliessen — der capture-Listener auf window faengt sonst auch den
        // List-Scroll ab.
        this._onScrollResize = (e) => {
          if (!this.open) return;
          if (e && e.type === 'scroll' && this.$el.contains(e.target)) return;
          this.close();
        };
        document.addEventListener('mousedown', this._onOutside);
        this.$el.addEventListener('keydown', (e) => this.onKeydown(e));

        this.$el.setAttribute('role', 'combobox');
        this.$el.setAttribute('aria-haspopup', 'listbox');
        if (this._multiple) {
          this.$el.classList.add('combobox-wrap--multi');
          this.$el.setAttribute('aria-multiselectable', 'true');
        }
        this.$watch('query', () => {
          this.highlighted = this.filtered.length > 0 ? 0 : -1;
        });
        const template = [
          '<button type="button" class="combobox-trigger" @click="toggle()"',
          '        :aria-expanded="open ? \'true\' : \'false\'"',
          '        :aria-label="selectedLabel || placeholder">',
          '  <span class="combobox-value" x-text="selectedLabel || placeholder"></span>',
          '  <svg class="combobox-chevron" :class="{\'combobox-chevron--open\': open}" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M1.5 3.5L5 7L8.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          '</button>',
          '<div class="combobox-dropdown" :class="{\'combobox-dropdown--up\': openUp}" x-show="open" x-cloak>',
          '  <input type="text" class="combobox-search" x-model="query" x-ref="cbInput"',
          '         :placeholder="$app.t(\'common.searchShort\')" role="searchbox" :aria-label="$app.t(\'common.searchShort\')">',
          '  <ul class="combobox-list" role="listbox"',
          '      :aria-activedescendant="highlighted >= 0 ? ($id(\'cb-opt\') + \'-\' + highlighted) : null">',
          '    <template x-for="(opt, i) in filtered" :key="opt.value">',
          '      <li class="combobox-option"',
          '          role="option"',
          '          :id="$id(\'cb-opt\') + \'-\' + i"',
          '          :aria-selected="_isSelected(opt.value) ? \'true\' : \'false\'"',
          '          :class="{\'combobox-option--selected\': _isSelected(opt.value), \'combobox-option--hl\': i === highlighted}"',
          '          @click="select(opt.value)" @mouseenter="highlighted = i">',
          '        <span class="combobox-option__label" x-text="opt.label"></span>',
          '        <span class="combobox-option__sub" x-show="opt.sublabel" x-cloak x-text="opt.sublabel"></span>',
          '      </li>',
          '    </template>',
          '    <li class="combobox-empty" x-show="filtered.length === 0" x-text="$app.t(\'find.noMatches\')"></li>',
          '  </ul>',
          '  <button type="button" class="combobox-footer-btn"',
          '          x-show="_footer" x-cloak',
          '          @click="triggerFooter()"',
          '          x-text="_footerLabel"></button>',
          '</div>',
        ].join('\n');
        this.$el.innerHTML = template;
        // Alpine processed das frisch gesetzte Markup nicht zuverlaessig, wenn
        // die Combobox innerhalb eines spaet hydratisierten Subtrees liegt
        // (template x-if mit nested x-data-Wrappern, Beispiel pdfExportCard).
        window.Alpine.initTree(this.$el);
      },
      destroy() {
        if (this._onOutside) {
          document.removeEventListener('mousedown', this._onOutside);
          this._onOutside = null;
        }
        if (this._onScrollResize) {
          window.removeEventListener('scroll', this._onScrollResize, true);
          window.removeEventListener('resize', this._onScrollResize);
          this._onScrollResize = null;
        }
      },
    };
}

export function registerCombobox() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('combobox', (placeholderOrCfg = null, emptyLabelArg = null) => {
    const cfg = (placeholderOrCfg && typeof placeholderOrCfg === 'object')
      ? placeholderOrCfg
      : { placeholder: placeholderOrCfg, emptyLabel: emptyLabelArg, compact: true };
    return comboboxData(cfg);
  });
}
