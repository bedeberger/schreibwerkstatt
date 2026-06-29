// Modal-Shell für natives `<dialog>` — Verhaltens-Primitiv, das das überall
// gleiche Dialog-Boilerplate kapselt: `showModal()`/`close()` an einen Boolean-
// State koppeln, ESC-Routing (`cancel`-Event), Backdrop-Klick zum Schliessen
// und Fokus-Restore auf das vorher fokussierte Element. Liegt DIREKT auf dem
// `<dialog>` (x-data) — analog combobox/collapsible.
//
// WARUM nativ: `showModal()` liefert Focus-Trap, Inert-Hintergrund und ESC
// gratis vom Browser (window.confirm() reisst Chrome auf macOS aus dem nativen
// Vollbild-Space — <dialog> ist DOM, kein OS-Modal). CSS bleibt beim Konsumenten
// (eigene Panel-Klasse + `::backdrop`).
//
// Einsatzbereich: PRÄSENTATIVE / selbst-tragende Dialoge, deren Inhalt nur den
// Root via `$app` braucht (z. B. das Tastenkürzel-Overlay). Dialoge mit eigener
// Karten-Logik (book-create) behalten ihre Karten-x-data; sie können das
// Öffnen/Schliessen weiter selbst über `showModal()/close()` fahren ODER diese
// Mechanik per `x-modelable`-Kopplung aus der Karte steuern (siehe unten).
//
// Verwendung A — Event-getriggert (Pattern wie EVT.BOOK_CREATE_OPEN):
//
//   <dialog class="shortcuts-panel" x-data="modal({ openOn: EVT.SOME_OPEN })">
//     <button @click="close()" …>×</button>
//     …Inhalt mit $app.t('…')…
//   </dialog>
//
//   Ein window-Event dieses Namens öffnet das Modal. Der Wert MUSS ein EVT.*-
//   Konstantenwert aus events.js sein (keine String-Literale, Architektur-Regel).
//
// Verwendung B — Flag-gesteuert (Parent koppelt seinen Boolean):
//
//   <dialog x-data="modal()" x-modelable="open" x-model="someFlag">…</dialog>
//
//   `someFlag = true` öffnet, `false` schliesst. `close()` setzt den Flag zurück.
//
// Config:
//   openOn       Event-Name (window). Öffnet das Modal beim Empfang. Optional.
//   dismissable  Backdrop-Klick + ESC schliessen (Default true). false →
//                nur `close()` schliesst (z. B. laufender Submit).
//   restoreFocus Fokus aufs auslösende Element zurückgeben (Default true).

export function modalData(cfg = {}) {
  return {
    open: false,
    _dlg: null,
    _prevFocus: null,
    _dismissable: cfg.dismissable !== false,
    _restoreFocus: cfg.restoreFocus !== false,
    _openOn: cfg.openOn || null,
    _abort: null,

    openModal() { this.open = true; },
    close() { this.open = false; },
    // Konsument kann Dismiss dynamisch sperren (z. B. während eines Submits):
    //   this.$data.setDismissable(false)
    setDismissable(v) { this._dismissable = !!v; },

    _show() {
      const dlg = this._dlg;
      if (!dlg || dlg.open) return;
      this._prevFocus = document.activeElement;
      dlg.showModal();
      // Native showModal() fokussiert das erste fokussierbare Element bzw.
      // [autofocus] selbst — kein manueller Fokus nötig.
    },
    _hide() {
      const dlg = this._dlg;
      if (dlg && dlg.open) dlg.close();
      if (this._restoreFocus && this._prevFocus && typeof this._prevFocus.focus === 'function') {
        this._prevFocus.focus();
      }
      this._prevFocus = null;
    },

    init() {
      this._dlg = this.$el; // x-data liegt auf dem <dialog>
      this._abort = new AbortController();
      const sig = { signal: this._abort.signal };

      // State → DOM: zentraler Punkt, egal ob über Flag (x-model), openModal()
      // oder das openOn-Event geöffnet wurde.
      this.$watch('open', (v) => { v ? this._show() : this._hide(); });

      // ESC (native cancel): nicht den Browser default-schliessen lassen,
      // sondern über unseren State, damit Flag + Fokus-Restore synchron sind.
      this._dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        if (this._dismissable) this.close();
      }, sig);

      // Backdrop-Klick: Klick direkt auf das <dialog>-Element (= ausserhalb des
      // Panel-Inhalts, der Padding-frei sein muss, damit das funktioniert).
      this._dlg.addEventListener('click', (e) => {
        if (this._dismissable && e.target === this._dlg) this.close();
      }, sig);

      // Falls das Dialog anderweitig geschlossen wird (z. B. form method=dialog),
      // den Flag nachziehen.
      this._dlg.addEventListener('close', () => {
        if (this.open) this.open = false;
      }, sig);

      if (this._openOn) {
        window.addEventListener(this._openOn, () => this.openModal(), sig);
      }
    },

    destroy() {
      this._abort?.abort();
      this._abort = null;
      const dlg = this._dlg;
      if (dlg && dlg.open) dlg.close();
      this._dlg = null;
    },
  };
}

export function registerModal() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.data('modal', (cfg = {}) => modalData(cfg));
}
