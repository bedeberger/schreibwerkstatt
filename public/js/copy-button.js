// Copy-to-Clipboard-Button.
//
// Kapselt das ueberall gleiche Mikro-Muster: Text in die Zwischenablage
// schreiben, kurz „Kopiert"-Label flashen, danach zurueck auf „Kopieren".
// `init()` setzt `type=button`, haengt den Click-Handler an und rendert das
// Label selbst — Konsumenten brauchen weder `@click` noch `x-text`.
//
// Verwendung (DESIGN.md-konform, Pattern wie num-input / combobox):
//
//   <button x-data="copyButton({ text: () => someUrl })"></button>
//
// Pflicht: `x-data="copyButton({ text })"`. `text` ist eine Funktion (oder ein
// String), die den zu kopierenden Wert liefert — als Getter, damit der aktuelle
// Wert zur Klick-Zeit gelesen wird.
//
// Config-Optionen:
//   text     Pflicht. Funktion oder String → kopierter Wert.
//   html     Optional. Funktion oder String → zusaetzlich als text/html in die
//            Zwischenablage (Rich-Text-Editoren uebernehmen Liste, Kursiv und
//            Links). Leer → nur Klartext.
//   label    Default-Label. Funktion oder String. Default `t('common.copy')`.
//   copied   Flash-Label. Funktion oder String. Default `t('common.copied')`.
//   duration Flash-Dauer in ms. Default 2000.

// Pure Helper: schreibt in die Zwischenablage, mit execCommand-Fallback fuer
// aeltere Browser / non-secure-context. Auch standalone importierbar (z. B.
// Auto-Copy nach Link-Erstellung, ohne Button).
export async function copyText(text) {
  if (text == null || text === '') return false;
  const str = String(text);
  try {
    await navigator.clipboard.writeText(str);
    return true;
  } catch (_) {
    try {
      const ta = document.createElement('textarea');
      ta.value = str;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (_) {
      return false;
    }
  }
}

/** Klartext UND HTML in die Zwischenablage: ein Rich-Text-Ziel (Moodle, Word,
 *  Mail) nimmt die HTML-Fassung, ein Textfeld die Klartext-Fassung. Ohne
 *  ClipboardItem-Support (aeltere Browser, non-secure-context) bleibt es beim
 *  Klartext. */
export async function copyRich(text, html) {
  if (!html) return copyText(text);
  try {
    if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) throw new Error('no ClipboardItem');
    await navigator.clipboard.write([new ClipboardItem({
      'text/plain': new Blob([String(text ?? '')], { type: 'text/plain' }),
      'text/html': new Blob([String(html)], { type: 'text/html' }),
    })]);
    return true;
  } catch (_) {
    return copyText(text);
  }
}

export function registerCopyButton() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('copyButton', (cfg = {}) => ({
    _copied: false,
    _timer: null,
    _cfg: {
      text: cfg.text,
      html: cfg.html ?? null,
      label: cfg.label ?? (() => window.__app?.t?.('common.copy') ?? 'Copy'),
      copiedLabel: cfg.copied ?? (() => window.__app?.t?.('common.copied') ?? 'Copied'),
      duration: cfg.duration ?? 2000,
    },

    _resolve(v) { return typeof v === 'function' ? v() : v; },

    _render() {
      this.$el.textContent = this._copied
        ? this._resolve(this._cfg.copiedLabel)
        : this._resolve(this._cfg.label);
    },

    init() {
      const el = this.$el;
      el.setAttribute('type', 'button');
      el.addEventListener('click', async () => {
        const ok = await copyRich(this._resolve(this._cfg.text), this._resolve(this._cfg.html));
        if (!ok) return;
        this._copied = true;
        this._render();
        if (this._timer) clearTimeout(this._timer);
        this._timer = setTimeout(() => { this._copied = false; this._render(); }, this._cfg.duration);
      });
      // Locale-Switch (uiLocale-Wechsel im User-Settings) re-rendert das Label.
      this.$watch(() => Alpine.store('shell')?.uiLocale, () => this._render());
      this._render();
    },

    destroy() {
      if (this._timer) clearTimeout(this._timer);
    },
  }));
}
