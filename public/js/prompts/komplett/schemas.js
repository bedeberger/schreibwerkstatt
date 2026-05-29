// Dynamische JSON-Schemas für Grammar-Constrained Decoding (lokale Provider) +
// statische Konsolidierungs-Schemas. _rebuildKomplettSchemas() baut die _isLocal-abhängigen
// Schemas nach configurePrompts() neu.
import { _isLocal } from '../state.js';
import { _obj, _str, _num } from '../schema-utils.js';

// ═════════════════════════════════════════════════════════════════════════════
// JSON-Schemas für Grammar-Constrained Decoding (lokale Provider)
// ═════════════════════════════════════════════════════════════════════════════
// Beziehungs-Items: für lokale Provider wird `machtverhaltnis` absichtlich aus dem
// JSON-Schema weggelassen – kleine Modelle setzen es fast immer 0 oder halluzinieren.
// Lieber das Feld leer lassen als falsche Werte anzeigen. Für Claude bleibt es erhalten.

const _bzBeleg = _obj({ kapitel: _str, seite: _str });
const _bzItem = () => _obj(_isLocal
  ? { figur_id: _str, typ: _str, beschreibung: _str, belege: { type: 'array', items: _bzBeleg } }
  : { figur_id: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str, belege: { type: 'array', items: _bzBeleg } }
);

const _figurSchemaProps = () => ({
  id: _str,
  name: _str,
  kurzname: _str,
  typ: _str,
  geburtstag: _str,
  geschlecht: _str,
  beruf: _str,
  wohnadresse: _str,
  rolle: _str,
  motivation: _str,
  konflikt: _str,
  beschreibung: _str,
  sozialschicht: _str,
  praesenz: { type: 'string', enum: ['zentral', 'regelmaessig', 'punktuell', 'randfigur'] },
  entwicklung: _str,
  erste_erwaehnung: _str,
  schluesselzitate: { type: 'array', items: _str },
  eigenschaften: { type: 'array', items: _str },
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  beziehungen: { type: 'array', items: _bzItem() },
});

// _figurSchema und alle abgeleiteten Schemas werden in _rebuildKomplettSchemas() bei jedem
// configurePrompts-Aufruf neu gebaut, damit der dynamisch gesetzte _isLocal-Flag korrekt
// wirkt (z.B. machtverhaltnis-Weglassen).
let _figurSchema = _obj(_figurSchemaProps());

// Stammdaten-Schema OHNE Beziehungen (Claude-Single-Pass A1).
const _figurStammSchemaProps = () => {
  const p = _figurSchemaProps();
  delete p.beziehungen;
  return p;
};
let _figurStammSchema = _obj(_figurStammSchemaProps());

const _ortSchema = _obj({
  id: _str,
  name: _str,
  typ: _str,
  beschreibung: _str,
  erste_erwaehnung: _str,
  stimmung: _str,
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  figuren: { type: 'array', items: _str },
});

const _songSchema = _obj({
  id: _str,
  titel: _str,
  interpret: _str,
  genre: _str,
  kontext_typ: _str,
  beschreibung: _str,
  stimmung: _str,
  erste_erwaehnung: _str,
  kapitel: { type: 'array', items: _obj({ name: _str, haeufigkeit: _num }) },
  figuren: { type: 'array', items: _str },
});

const _faktSchema = _obj({ kategorie: _str, subjekt: _str, fakt: _str, seite: _str });

export let SCHEMA_KOMPLETT_EXTRAKTION = null;
export let SCHEMA_KOMPLETT_FIGUREN_PASS = null;
export let SCHEMA_KOMPLETT_FIGUREN_STAMM = null;
export let SCHEMA_KOMPLETT_ORTE_PASS = null;
export let SCHEMA_FIGUREN_KONSOL = null;
export let SCHEMA_BEZIEHUNGEN = null;

function _szenenField() {
  return {
    type: 'array',
    items: _obj({
      seite: _str,
      kapitel: _str,
      titel: _str,
      wertung: { type: 'string', enum: ['stark', 'mittel', 'schwach'] },
      kommentar: _str,
      figuren_namen: { type: 'array', items: _str },
      orte_namen: { type: 'array', items: _str },
    }),
  };
}

// Whitelist für Event-Subtypen (Phase 2). KI darf nur diese Werte liefern;
// Server-Save fällt sonst auf 'sonstiges' zurück.
const EVENT_SUBTYP_ENUM = [
  'geburt', 'tod', 'hochzeit', 'reise', 'konflikt', 'wendepunkt',
  'entdeckung', 'verlust', 'sieg',
  'extern_politisch', 'extern_natur', 'extern_kulturell', 'sonstiges',
];

function _assignmentsField() {
  return {
    type: 'array',
    items: _obj({
      figur_name: _str,
      lebensereignisse: {
        type: 'array',
        items: _obj({
          datum: _str,
          datum_label: _str,
          datum_year:  _num,
          datum_month: _num,
          datum_day:   _num,
          datum_ende_year:  _num,
          datum_ende_month: _num,
          datum_ende_day:   _num,
          story_tag:   _num,
          subtyp: { type: 'string', enum: EVENT_SUBTYP_ENUM },
          ereignis: _str,
          typ: { type: 'string', enum: ['persoenlich', 'extern'] },
          bedeutung: _str,
          seite: _str,
          kapitel: _str,
        }),
      },
    }),
  };
}

function _buildExtraktionSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurSchema },
    orte: { type: 'array', items: _ortSchema },
    songs: { type: 'array', items: _songSchema },
    fakten: { type: 'array', items: _faktSchema },
    szenen: _szenenField(),
    assignments: _assignmentsField(),
  });
}

function _buildFigurenPassSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurSchema },
    assignments: _assignmentsField(),
  });
}

function _buildFigurenStammSchema() {
  return _obj({
    figuren: { type: 'array', items: _figurStammSchema },
    assignments: _assignmentsField(),
  });
}

function _buildOrtePassSchema() {
  return _obj({
    orte: { type: 'array', items: _ortSchema },
    songs: { type: 'array', items: _songSchema },
    fakten: { type: 'array', items: _faktSchema },
    szenen: _szenenField(),
  });
}

function _buildBeziehungenSchema() {
  const belegeField = { belege: { type: 'array', items: _bzBeleg } };
  const props = _isLocal
    ? { von: _str, zu: _str, typ: _str, beschreibung: _str, ...belegeField }
    : { von: _str, zu: _str, typ: _str, machtverhaltnis: _num, beschreibung: _str, ...belegeField };
  return _obj({ beziehungen: { type: 'array', items: _obj(props) } });
}

export function _rebuildKomplettSchemas() {
  _figurSchema = _obj(_figurSchemaProps());
  _figurStammSchema = _obj(_figurStammSchemaProps());
  SCHEMA_KOMPLETT_EXTRAKTION = _buildExtraktionSchema();
  SCHEMA_KOMPLETT_FIGUREN_PASS = _buildFigurenPassSchema();
  SCHEMA_KOMPLETT_FIGUREN_STAMM = _buildFigurenStammSchema();
  SCHEMA_KOMPLETT_ORTE_PASS = _buildOrtePassSchema();
  SCHEMA_FIGUREN_KONSOL = _obj({ figuren: { type: 'array', items: _figurSchema } });
  SCHEMA_BEZIEHUNGEN = _buildBeziehungenSchema();
}

_rebuildKomplettSchemas();

// ── Statische Schemas (nicht _isLocal-abhängig) ──────────────────────────────

export const SCHEMA_ORTE_KONSOL = _obj({ orte: { type: 'array', items: _ortSchema } });

export const SCHEMA_SONGS_KONSOL = _obj({ songs: { type: 'array', items: _songSchema } });

export const SCHEMA_SOZIOGRAMM_KONSOL = _obj({
  figuren:     { type: 'array', items: _obj({ id: _str, sozialschicht: _str }) },
  beziehungen: { type: 'array', items: _obj({ from_fig_id: _str, to_fig_id: _str, machtverhaltnis: _num }) },
});

export const SCHEMA_ZEITSTRAHL = _obj({
  ereignisse: {
    type: 'array',
    items: _obj({
      datum: _str,
      datum_label: _str,
      datum_year:  _num,
      datum_month: _num,
      datum_day:   _num,
      datum_ende_year:  _num,
      datum_ende_month: _num,
      datum_ende_day:   _num,
      story_tag:   _num,
      subtyp: { type: 'string', enum: EVENT_SUBTYP_ENUM },
      ereignis: _str,
      typ: { type: 'string', enum: ['persoenlich', 'extern'] },
      bedeutung: _str,
      kapitel: { type: 'array', items: _str },
      seiten: { type: 'array', items: _str },
      figuren: { type: 'array', items: _obj({ id: _str, name: _str, typ: _str }) },
    }),
  },
});

export const SCHEMA_KONTINUITAET_FAKTEN = _obj({
  fakten: { type: 'array', items: _faktSchema },
});

export const SCHEMA_KONTINUITAET_PROBLEME = _obj({
  probleme: {
    type: 'array',
    items: _obj({
      schwere: { type: 'string', enum: ['kritisch', 'mittel', 'niedrig'] },
      typ: _str,
      beschreibung: _str,
      stelle_a: _str,
      stelle_b: _str,
      figuren: { type: 'array', items: _str },
      kapitel: { type: 'array', items: _str },
      empfehlung: _str,
    }),
  },
  zusammenfassung: _str,
});
