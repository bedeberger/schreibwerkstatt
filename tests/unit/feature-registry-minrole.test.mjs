// Jeder FEATURES-Eintrag braucht ein explizites `minRole` — implizites
// Default (`editor`) ist verboten, weil Viewer/Lektor sonst Cards sehen, die
// sie nicht aufrufen dürfen.
//
// hasMinRole + featuresVisibleFor sind die SSoT für Frontend-Sichtbarkeit.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FEATURES,
  ROLE_RANK,
  hasMinRole,
  featuresVisibleFor,
  featureByKey,
  isFeatureAvailable,
  unavailabilityReasonKey,
} from '../../public/js/cards/feature-registry.js';

test('jeder FEATURES-Eintrag hat ein gültiges minRole', () => {
  const valid = new Set(Object.keys(ROLE_RANK));
  for (const f of FEATURES) {
    assert.ok(f.minRole, `feature "${f.key}" hat kein minRole`);
    assert.ok(valid.has(f.minRole), `feature "${f.key}" hat ungültiges minRole "${f.minRole}"`);
  }
});

test('hasMinRole respektiert Hierarchie owner > editor > lektor > viewer', () => {
  assert.equal(hasMinRole('owner',  'editor'), true);
  assert.equal(hasMinRole('editor', 'editor'), true);
  assert.equal(hasMinRole('lektor', 'editor'), false);
  assert.equal(hasMinRole('viewer', 'lektor'), false);
  assert.equal(hasMinRole('owner',  'viewer'), true);
  assert.equal(hasMinRole(null,     'viewer'), false);
  // required null → immer true (Action ohne Rollenbindung).
  assert.equal(hasMinRole(null,     null),     true);
  assert.equal(hasMinRole('viewer', null),     true);
});

test('featuresVisibleFor(viewer): nur overview/export/pdfExport/epubExport/docxExport/bookEditor/search/help', () => {
  const visible = featuresVisibleFor(FEATURES, 'viewer').map(f => f.key).sort();
  assert.deepEqual(visible, ['bookEditor', 'docxExport', 'epubExport', 'export', 'help', 'overview', 'pdfExport', 'search'].sort());
});

test('featuresVisibleFor(lektor): viewer-Set (lektor hat keine zusätzlichen FEATURES)', () => {
  // FEATURES-Subset für lektor ist identisch zu viewer, weil lektor-spezifische
  // Pfade (Lektorat-Findings-Card im Editor) keine eigenen FEATURES-Einträge
  // haben — die laufen aus dem Editor heraus.
  const viewerSet = new Set(featuresVisibleFor(FEATURES, 'viewer').map(f => f.key));
  const lektorSet = new Set(featuresVisibleFor(FEATURES, 'lektor').map(f => f.key));
  for (const k of viewerSet) assert.ok(lektorSet.has(k), `${k} fehlt bei lektor`);
});

// `requiresBuchtyp`-Karten sind nur sichtbar, wenn der Buchtyp passt — auch für
// editor/owner. Ohne passenden Buchtyp fallen sie raus.
test('featuresVisibleFor(editor, buchtyp=tagebuch): alle FEATURES', () => {
  const all = FEATURES.map(f => f.key).sort();
  const visible = featuresVisibleFor(FEATURES, 'editor', 'tagebuch').map(f => f.key).sort();
  assert.deepEqual(visible, all);
});

test('featuresVisibleFor(owner, buchtyp=tagebuch): alle FEATURES', () => {
  const all = FEATURES.map(f => f.key).sort();
  const visible = featuresVisibleFor(FEATURES, 'owner', 'tagebuch').map(f => f.key).sort();
  assert.deepEqual(visible, all);
});

// requiresClaude: Kontinuität + Erzählprofil sind Claude-only (die Qualitätsstufen
// gibt es nur bei Claude). Für Nicht-Claude ausgeblendet.
test('requiresClaude-Karten sind kontinuitaet + erzaehlprofil', () => {
  const gated = FEATURES.filter(f => f.requiresClaude).map(f => f.key).sort();
  assert.deepEqual(gated, ['erzaehlprofil', 'kontinuitaet']);
});

test('featuresVisibleFor blendet requiresClaude-Karten aus, wenn effektiver Provider nicht Claude', () => {
  const withClaude = new Set(featuresVisibleFor(FEATURES, 'editor', null, true).map(f => f.key));
  const noClaude = new Set(featuresVisibleFor(FEATURES, 'editor', null, false).map(f => f.key));
  for (const k of ['kontinuitaet', 'erzaehlprofil']) {
    assert.ok(withClaude.has(k), `${k} bei Claude sichtbar`);
    assert.ok(!noClaude.has(k), `${k} bei Nicht-Claude ausgeblendet`);
  }
});

test('featuresVisibleFor: claudeEffective default true (Rückwärtskompatibilität)', () => {
  const visible = new Set(featuresVisibleFor(FEATURES, 'editor').map(f => f.key));
  assert.ok(visible.has('kontinuitaet') && visible.has('erzaehlprofil'));
});

test('isFeatureAvailable + unavailabilityReasonKey gaten requiresClaude', () => {
  const feat = featureByKey('kontinuitaet');
  const base = { selectedBookId: 1, pages: [{}], bookRole: 'editor' };
  assert.equal(isFeatureAvailable(feat, { ...base, claudeEffective: true }), true);
  assert.equal(isFeatureAvailable(feat, { ...base, claudeEffective: false }), false);
  assert.equal(unavailabilityReasonKey(feat, { ...base, claudeEffective: false }), 'palette.disabled.needClaude');
});

test('featuresVisibleFor(editor) ohne passenden Buchtyp blendet requiresBuchtyp-Karten aus', () => {
  const gated = FEATURES.filter(f => f.requiresBuchtyp).map(f => f.key);
  assert.ok(gated.includes('tagebuchRueckblick'), 'Test-Voraussetzung: gated Card existiert');
  const visibleNoBuchtyp = new Set(featuresVisibleFor(FEATURES, 'editor').map(f => f.key));
  for (const k of gated) assert.ok(!visibleNoBuchtyp.has(k), `${k} darf ohne passenden Buchtyp nicht sichtbar sein`);
  // Mit passendem Buchtyp wieder sichtbar.
  const visibleTagebuch = new Set(featuresVisibleFor(FEATURES, 'editor', 'tagebuch').map(f => f.key));
  assert.ok(visibleTagebuch.has('tagebuchRueckblick'));
});
