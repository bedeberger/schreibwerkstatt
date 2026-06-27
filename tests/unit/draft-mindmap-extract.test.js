'use strict';
// Tests für lib/draft-mindmap-extract.js — extrahiert Subtext/Bogen/Konflikt aus
// einer Werkstatt-Mindmap (Cross-Feature-Kontext der Plot-KI-Jobs).

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractPsychologie, hasDevelopedArc } = require('../../lib/draft-mindmap-extract');

function mm(children) {
  return { meta: {}, format: 'node_tree', data: { id: 'root', topic: 'Anna', children } };
}

test('extractPsychologie: leerer Default-Baum (Container ohne Kinder) → null', () => {
  const m = mm([
    { id: 'subtext', topic: 'Subtext', children: [
      { id: 'want', topic: 'Will' },
      { id: 'need', topic: 'Braucht' },
    ]},
    { id: 'steckbrief', topic: 'Steckbrief', children: [{ id: 'bogen', topic: 'Bogen' }] },
  ]);
  assert.equal(extractPsychologie(m), null);
  assert.equal(hasDevelopedArc(m), false);
});

test('extractPsychologie: liest Kinder unter want/need/wound/lie/bogen/konflikt', () => {
  const m = mm([
    { id: 'steckbrief', topic: 'Steckbrief', children: [
      { id: 'bogen', topic: 'Bogen', children: [
        { id: 'b1', topic: 'naiv' }, { id: 'b2', topic: 'desillusioniert' },
      ]},
      { id: 'konflikt', topic: 'Konflikt', children: [{ id: 'k1', topic: 'Pflicht vs. Liebe' }] },
    ]},
    { id: 'subtext', topic: 'Subtext', children: [
      { id: 'want', topic: 'Will', children: [{ id: 'w1', topic: 'Anerkennung' }] },
      { id: 'need', topic: 'Braucht', children: [{ id: 'n1', topic: 'Selbstwert' }] },
      { id: 'wound', topic: 'Wunde', children: [{ id: 'wo1', topic: 'verlassen worden' }] },
      { id: 'lie', topic: 'Lüge', children: [{ id: 'l1', topic: 'Ich bin wertlos' }] },
    ]},
  ]);
  const p = extractPsychologie(m);
  assert.deepEqual(p.bogen, ['naiv', 'desillusioniert']);
  assert.deepEqual(p.konflikt, ['Pflicht vs. Liebe']);
  assert.deepEqual(p.want, ['Anerkennung']);
  assert.deepEqual(p.need, ['Selbstwert']);
  assert.deepEqual(p.wound, ['verlassen worden']);
  assert.deepEqual(p.lie, ['Ich bin wertlos']);
  assert.equal(hasDevelopedArc(m), true);
});

test('hasDevelopedArc: nur Konflikt ausgearbeitet (ohne Bogen/Subtext) → false', () => {
  const m = mm([
    { id: 'steckbrief', topic: 'Steckbrief', children: [
      { id: 'konflikt', topic: 'Konflikt', children: [{ id: 'k1', topic: 'innerer Zwist' }] },
    ]},
  ]);
  // Konflikt zählt für extractPsychologie (nicht-null), aber NICHT als „Bogen/Subtext".
  assert.notEqual(extractPsychologie(m), null);
  assert.equal(hasDevelopedArc(m), false);
});

test('extractPsychologie: keine/kaputte Mindmap → null (robust)', () => {
  assert.equal(extractPsychologie(null), null);
  assert.equal(extractPsychologie({}), null);
  assert.equal(extractPsychologie({ data: null }), null);
  assert.equal(hasDevelopedArc(undefined), false);
});
