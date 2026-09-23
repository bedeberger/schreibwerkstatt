'use strict';
// Default-Mindmap einer neuen Werkstatt-Figur (jsMind `node_tree`): Wurzel =
// Figurname, vier feste Branches. Topics als `__i18n:werkstatt.tree.<key>__`-
// Marker — das Frontend loest sie zur Render-Zeit auf.
//
// Eigenes Modul, weil zwei Seiten es brauchen: die CRUD-Route (Neuanlage) und
// lib/draft-mindmap-builder.js (Skelett beim Katalog-Import). In der Route
// importierten sich Route und Builder gegenseitig, und bei der Ladereihenfolge
// des Servers (Route zuerst) saehe der Builder `undefined` statt der Funktion.

function defaultMindmap(name) {
  return {
    meta: { name: 'figur-werkstatt', version: '1' },
    format: 'node_tree',
    data: {
      id: 'root',
      topic: name,
      children: [
        { id: 'steckbrief', topic: '__i18n:werkstatt.tree.steckbrief__', expanded: true, children: [
          { id: 'aussehen',        topic: '__i18n:werkstatt.tree.aussehen__' },
          { id: 'persoenlichkeit', topic: '__i18n:werkstatt.tree.persoenlichkeit__' },
          { id: 'hintergrund',     topic: '__i18n:werkstatt.tree.hintergrund__' },
          { id: 'beziehungen',     topic: '__i18n:werkstatt.tree.beziehungen__' },
          { id: 'konflikt',        topic: '__i18n:werkstatt.tree.konflikt__' },
          { id: 'bogen',           topic: '__i18n:werkstatt.tree.bogen__' },
          { id: 'musikgeschmack',  topic: '__i18n:werkstatt.tree.musikgeschmack__' },
        ]},
        { id: 'stimme', topic: '__i18n:werkstatt.tree.stimme__', expanded: true, children: [
          { id: 'sprechweise', topic: '__i18n:werkstatt.tree.sprechweise__' },
          { id: 'phrasen',     topic: '__i18n:werkstatt.tree.phrasen__' },
          { id: 'verben',      topic: '__i18n:werkstatt.tree.verben__' },
        ]},
        { id: 'subtext', topic: '__i18n:werkstatt.tree.subtext__', expanded: true, children: [
          { id: 'want',  topic: '__i18n:werkstatt.tree.want__' },
          { id: 'need',  topic: '__i18n:werkstatt.tree.need__' },
          { id: 'wound', topic: '__i18n:werkstatt.tree.wound__' },
          { id: 'lie',   topic: '__i18n:werkstatt.tree.lie__' },
        ]},
        { id: 'custom', topic: '__i18n:werkstatt.tree.custom__', children: [] },
      ],
    },
  };
}

module.exports = { defaultMindmap };
