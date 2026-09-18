// Gestaltungs-Vorlagen des Custom-PDF-Exports (public/js/cards/pdf-export-templates.js).
//
// Eine Vorlage ist eine Teilkonfiguration, die der Server beim Anlegen durch
// `validateConfig` schickt. Genau daraus entstehen die Fehler, die man der
// Vorlage nicht ansieht:
//   - ein Wert ausserhalb der Range wird STILL geclampt (die Vorlage sagt 9 mm,
//     das Profil trägt 5 mm) — der User sieht nur ein Layout, das anders aussieht
//     als beschrieben;
//   - eine Schriftfamilie/ein Gewicht ausserhalb der Whitelist lässt sich
//     anlegen, aber nicht mehr SPEICHERN (`FONT_NOT_ALLOWED` beim PUT) — der
//     Fehler trifft den User erst nach der ersten eigenen Änderung;
//   - ein Textfeld in `extras` würde fremden Werk-Text ins Profil schreiben.
// Darum prüft der Test die Vorlagen gegen dieselbe Validierung, die der Server
// fährt, statt gegen eine Nacherzählung ihrer Regeln.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateConfig } = require('../../lib/pdf-export-defaults');
// font-fetch legt beim Laden Statements auf `font_cache` an — Schema zuerst.
require('../../db/migrations');
const { listFonts } = require('../../lib/font-fetch');
const de = require('../../public/js/i18n/de.json');
const en = require('../../public/js/i18n/en.json');

const { PDF_TEMPLATES, templateConfig, templateById, HYPHEN_BROKEN_FAMILIES } =
  await import('../../public/js/cards/pdf-export-templates.js');

const FONTS = new Map(listFonts().map(f => [f.family, f]));

// Blattweiser Vergleich: jeder Wert, den die Vorlage setzt, muss die
// Validierung unverändert überleben. Objekte steigen ab, Skalare vergleichen.
function assertSurvives(tplNode, validNode, path) {
  for (const [key, want] of Object.entries(tplNode)) {
    const got = validNode?.[key];
    const at = `${path}.${key}`;
    if (want && typeof want === 'object' && !Array.isArray(want)) {
      assert.ok(got && typeof got === 'object', `${at}: von der Validierung verworfen`);
      assertSurvives(want, got, at);
    } else {
      assert.deepEqual(got, want, `${at}: Validierung änderte den Vorlagenwert`);
    }
  }
}

test('Vorlagen-Katalog: eindeutige IDs, vollständige Felder', () => {
  assert.ok(PDF_TEMPLATES.length >= 2);
  const ids = PDF_TEMPLATES.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, 'doppelte Vorlagen-ID');
  for (const tpl of PDF_TEMPLATES) {
    assert.match(tpl.id, /^[a-z0-9-]+$/);
    assert.ok(tpl.nameKey && tpl.descKey && tpl.config);
    assert.equal(templateById(tpl.id), tpl);
  }
  assert.equal(templateById('gibtsnicht'), null);
  assert.equal(templateConfig('gibtsnicht'), null);
});

test('templateConfig liefert eine Kopie, keinen Verweis auf den Katalog', () => {
  const a = templateConfig(PDF_TEMPLATES[0].id);
  a.layout.customWidthMm = 999;
  const b = templateConfig(PDF_TEMPLATES[0].id);
  assert.notEqual(b.layout.customWidthMm, 999);
});

for (const tpl of PDF_TEMPLATES) {
  test(`Vorlage «${tpl.id}»: jeder gesetzte Wert überlebt validateConfig`, () => {
    const cfg = validateConfig(templateConfig(tpl.id));
    assertSurvives(tpl.config, cfg, 'config');
  });

  test(`Vorlage «${tpl.id}»: alle Schriften stehen in der Whitelist`, () => {
    const cfg = validateConfig(templateConfig(tpl.id));
    for (const [role, f] of Object.entries(cfg.font)) {
      const meta = FONTS.get(f.family);
      assert.ok(meta, `font.${role}: Familie «${f.family}» nicht in der Whitelist`);
      assert.ok(meta.weights.includes(f.weight),
        `font.${role}: ${f.family} kennt kein Gewicht ${f.weight} (${meta.weights.join('/')})`);
      // Kursive Rollen brauchen den Kursivschnitt — sonst registriert der
      // Renderer still die Body-Schrift und die Rolle verliert ihre Auszeichnung.
      if (f.italic) {
        assert.ok(meta.styles.includes('italic'),
          `font.${role}: ${f.family} hat keinen Kursivschnitt, die Rolle verlangt ihn`);
      }
    }
    // Rollen, für die lib/pdf-render/fonts.js ALLE VIER Schnitte vorlädt
    // (regVariants): ihr Text kann Inline-Auszeichnung tragen — Kopf-/Fusszeile
    // über layout.hfStyle, Verzeichnis-/Notentext über <em>. Fehlt der Familie
    // ein Schnitt, registriert der Renderer still die Body-Schrift darunter und
    // loggt bei JEDEM Export eine Warnung. Die Vorlage soll dort nicht landen.
    const FOUR_CUT_ROLES = ['body', 'header', 'footer', 'bibliography', 'footnote'];
    for (const role of FOUR_CUT_ROLES) {
      const f = cfg.font[role];
      const meta = FONTS.get(f.family);
      assert.ok(meta.styles.includes('italic'),
        `font.${role}: ${f.family} hat keinen Kursivschnitt, der Renderer lädt ihn für diese Rolle aber`);
      assert.ok(meta.weights.includes(Math.min(900, f.weight + 300)),
        `font.${role}: ${f.family} hat kein Gewicht ${Math.min(900, f.weight + 300)} als Fettschnitt`);
    }
  });

  test(`Vorlage «${tpl.id}»: keine Familie, die den Trennstrich verliert`, () => {
    // Bei diesen Familien zeichnet der Renderer den Trennstrich am
    // Zeilenumbruch nicht — das Wort wird dann still in zwei Teile zerschnitten.
    // Sichtbar nur im gesetzten Absatz, darum hier gegated.
    const cfg = validateConfig(templateConfig(tpl.id));
    for (const [role, f] of Object.entries(cfg.font)) {
      assert.ok(!HYPHEN_BROKEN_FAMILIES.includes(f.family),
        `font.${role}: «${f.family}» verliert den Trennstrich am Zeilenumbruch`);
    }
  });

  test(`Vorlage «${tpl.id}»: Überschriften-Kette bleibt absteigend`, () => {
    const cfg = validateConfig(templateConfig(tpl.id));
    const s = cfg.font.heading.sizes;
    const chain = [s.h1, s.h2, s.h3, s.h4, s.h5, s.h6];
    for (let i = 1; i < chain.length; i++) {
      assert.ok(chain[i] < chain[i - 1], `h${i + 1} (${chain[i]}) ist nicht kleiner als h${i} (${chain[i - 1]})`);
    }
    assert.ok(s.h6 >= cfg.font.body.sizePt, 'h6 ist kleiner als der Fliesstext');
  });

  test(`Vorlage «${tpl.id}»: Satzspiegel passt aufs Blatt`, () => {
    const cfg = validateConfig(templateConfig(tpl.id));
    const { customWidthMm: w, customHeightMm: h, marginsMm: m } = cfg.layout;
    assert.equal(cfg.layout.pageSize, 'custom', 'Vorlage nennt ein Format, also muss pageSize custom sein');
    const textW = w - m.left - m.right;
    const textH = h - m.top - m.bottom;
    assert.ok(textW > 60, `Satzbreite ${textW} mm ist unbrauchbar schmal`);
    assert.ok(textH > 100, `Satzhöhe ${textH} mm ist unbrauchbar niedrig`);
  });

  test(`Vorlage «${tpl.id}»: bringt keinen Werk-Text mit`, () => {
    // extras trägt Widmung/Impressum/ISBN/Klappentext — Eigentum des Werks.
    // Eine Vorlage, die sie setzt, schriebe beim Anwenden fremden Text hinein.
    const TEXT_FIELDS = ['dedication', 'imprint', 'subtitle', 'year', 'isbn', 'copyright', 'frontMatter', 'authorBio'];
    for (const f of TEXT_FIELDS) {
      assert.equal(tpl.config.extras?.[f], undefined, `extras.${f} gehört dem Werk, nicht der Vorlage`);
    }
    assert.equal(tpl.config.coverSpec?.blurb, undefined, 'coverSpec.blurb gehört dem Werk');
    assert.equal(tpl.config.coverSpec?.spineText, undefined, 'coverSpec.spineText gehört dem Werk');
    // Die Seitenzahl des Innenteils trägt der Export selbst nach.
    assert.equal(tpl.config.coverSpec?.pageCount, undefined, 'coverSpec.pageCount setzt der Innenteil-Export');
  });

  test(`Vorlage «${tpl.id}»: Name + Beschreibung in beiden Locales`, () => {
    for (const key of [tpl.nameKey, tpl.descKey]) {
      assert.ok(de[key], `${key} fehlt in de.json`);
      assert.ok(en[key], `${key} fehlt in en.json`);
    }
  });
}

test('Die beiden Vorlagen sind unterscheidbar, nicht zwei Namen für dasselbe', () => {
  const [a, b] = PDF_TEMPLATES.map(t => validateConfig(templateConfig(t.id)));
  assert.notEqual(a.layout.customWidthMm, b.layout.customWidthMm);
  assert.notEqual(a.font.body.family, b.font.body.family);
  assert.notEqual(a.chapter.titleStyle, b.chapter.titleStyle);
});
