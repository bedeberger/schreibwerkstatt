// Notebook-Subfolder-Facade. Pendant zu editor/focus/* — re-exportiert alle
// Notebook-spezifischen Methods + Helpers an einer Stelle, damit Cards und
// Root nur eine Import-Quelle anbinden.

export { notebookEditMethods } from './edit.js';
export { notebookTrampoline } from './trampoline.js';
export { toolbarCardMethods } from './toolbar.js';
export {
  writeNormalSnapshot,
  readNormalSnapshot,
  clearNormalSnapshot,
} from './storage.js';
export { notebookCardMethods } from './card.js';
