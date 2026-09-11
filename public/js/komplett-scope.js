// Lauf-Umfang der Komplettanalyse — Frontend-Spiegel von lib/komplett-scope.js.
// Begruendung des Katalogs (was abwaehlbar ist und warum) steht dort; hier nur die
// Daten, die das Modal braucht. Drift gegated: tests/unit/komplett-scope.test.mjs.
//
// Bewusste Kopie statt Import: der Server ist CJS und muss den Umfang synchron im
// Route-Handler normalisieren, der Browser braucht ihn zur Render-Zeit des Modals.

export const KOMPLETT_STEPS = [
  { key: 'orte',          group: 'katalog',  cloudOnly: false },
  { key: 'szenen',        group: 'katalog',  cloudOnly: false },
  { key: 'ereignisse',    group: 'katalog',  cloudOnly: false },
  { key: 'beziehungen',   group: 'katalog',  cloudOnly: false },
  { key: 'songs',         group: 'katalog',  cloudOnly: false },
  { key: 'kontinuitaet',  group: 'pruefung', cloudOnly: true  },
  { key: 'erzaehlprofil', group: 'pruefung', cloudOnly: true  },
  { key: 'coverage',      group: 'pruefung', cloudOnly: true  },
];

export const KOMPLETT_CORE_STEPS = ['seiten', 'extraktion', 'figuren', 'weltfakten'];

export const KOMPLETT_STEP_KEYS = KOMPLETT_STEPS.map(s => s.key);

/** Rohen Umfang auf die bekannten Schluessel normalisieren. Fehlendes ist AN. */
export function normalizeKomplettScope(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const key of KOMPLETT_STEP_KEYS) out[key] = src[key] !== false;
  return out;
}

/** Laeuft alles? Steuert die Beschriftung des Start-Knopfs. */
export function isFullKomplettScope(scope) {
  const s = normalizeKomplettScope(scope);
  return KOMPLETT_STEP_KEYS.every(k => s[k] === true);
}
