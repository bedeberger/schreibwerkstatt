// Facade: bündelt Graph-Render-Methoden aus den Submodulen.
// graphMethods wird in Alpine.data('figurenCard') gespreaded.
// Root-Zugriffe via window.__app. vis-network-Instanz (_figurenNetwork) +
// Graph-Modus-State leben in der Card; destroy() räumt beides auf.
import { coreMethods } from './graph/core.js';
import { sharedMethods } from './graph/shared.js';
import { figurengraphMethods } from './graph/figurengraph.js';
import { familiengraphMethods } from './graph/familiengraph.js';
import { soziogrammMethods } from './graph/soziogramm.js';

export const graphMethods = {
  ...coreMethods,
  ...sharedMethods,
  ...figurengraphMethods,
  ...familiengraphMethods,
  ...soziogrammMethods,
};
