// Facade: appViewMethods aus thematischen Submodulen in app-view/.
// Submodul-Aufteilung nach Domäne; Methoden teilen sich zur Laufzeit ein
// gemeinsames `this` (in das Objekt gespreadet). Geteilte Imports/Konstanten
// in app-view/_shared.js.
import { pageMethods } from './app-view/page.js';
import { scrollMethods } from './app-view/scroll.js';
import { cardsMethods } from './app-view/cards.js';
import { badgesMethods } from './app-view/badges.js';
import { bookscopeMethods } from './app-view/bookscope.js';
import { shareMethods } from './app-view/share.js';
import { generatedToggles } from './app-view/_shared.js';

export { FILTER_SCOPES } from './app-view/_shared.js';

export const appViewMethods = {
  ...generatedToggles,
  ...pageMethods,
  ...scrollMethods,
  ...cardsMethods,
  ...badgesMethods,
  ...bookscopeMethods,
  ...shareMethods,
};
