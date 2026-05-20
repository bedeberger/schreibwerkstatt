// Per-Container-Counter. Phase-1: re-exportiert die bestehende
// installEditCounter-Implementierung aus focus/storage.js, damit Aufrufer
// nicht mehr quer auf das Focus-Modul greifen müssen.
//
// Phase-2 wird die Funktion in dieses File ziehen und auf einen reinen
// Container-Parameter (statt `app`) umstellen, sobald beide Editoren ihre
// eigenen Cardroots besitzen und nicht mehr denselben globalen Container
// teilen.

export { installEditCounter } from '../focus/storage.js';
