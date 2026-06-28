// Alpine.store('tts') — TTS / Proof-Listening-State (Notebook-Seitenansicht,
// Read-Modus). Vorher flach in der Root-God-State; jetzt eine schmale, benannte
// Store-Oberfläche. Der Store-Name liefert den Namespace, darum tragen die Keys
// kein `tts`-Präfix mehr (Zugriff via `$store.tts.playing`).
//
// Der Root spiegelt die Felder via Getter/Setter-Proxy (app.js) als
// `this.ttsPlaying`/`ttsEnabled`/…, sodass die Methoden in tts-proof.js und die
// bare Template-Bindings in editor-body-view.html unverändert funktionieren.
//
// Feld-Bedeutung:
//   enabled — /config `tts.enabled` (Admin enabled + Host gesetzt); blendet den
//             Vorlese-Dock in der Leseansicht ein. Voice/Speed/Format löst der
//             /tts/speak-Proxy serverseitig auf — kein Frontend-State dafür.
//   pause   — Atempause (ms) zwischen den Fragmenten (aus /config, Admin-konfig.):
//             fragmentMs Satz-zu-Satz, paragraphMs an Absatzgrenzen; 0 = keine.
//             Defaults mirroren die app-settings-Defaults.
//   playing — Session aktiv (inkl. pausiert).
//   paused  — pausiert.
//   loading — wartet auf Audio des aktuellen Satzes.
//   index/total — Satz-Fortschritt für die Status-Pille.

export function registerTtsStore() {
  if (typeof window === 'undefined' || !window.Alpine) return;
  window.Alpine.store('tts', {
    enabled: false,
    pause: { fragmentMs: 250, paragraphMs: 550 },
    playing: false,
    paused: false,
    loading: false,
    index: 0,
    total: 0,
  });
}
