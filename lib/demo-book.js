'use strict';
// Beispielbuch fuer echte User (Onboarding „Erste Schritte"): ein kleines,
// vollstaendiges Buch mit Kapiteln + Seiten, das ueber die Content-Store-Facade
// (gleicher Write-Chokepoint wie der Buch-Import → data-bid-Vergabe) angelegt
// wird. Kein KI-Call, kein Job noetig (5 Seiten, synchron).
//
// Prosa-Text: Public-Domain (Franz Kafka, „Die Verwandlung"). Bewusst als eigene
// SSoT hier — entkoppelt vom LOCAL_DEV_MODE-Seed (lib/dev-seed.js), der nur lokal
// laeuft. Der Text ist Anschauungsmaterial, damit Neue die Analyse-Funktionen
// (Figuren, Orte, Zeitstrahl, Lektorat) an echtem Inhalt sehen.

const contentStore = require('./content-store');
const bookAccess = require('../db/book-access');
const logger = require('../logger');

const DEMO_BOOK_NAME = 'Beispiel: Die Verwandlung';
const DEMO_BOOK_DESCRIPTION = 'Ein Beispielbuch zum Ausprobieren — gemeinfreie Prosa von Franz Kafka. Leg damit los, lass es analysieren oder loesche es jederzeit wieder.';

// Prosa block-weise (ein Eintrag = ein <p>). data-bid vergibt der Content-Store
// am Write-Chokepoint automatisch — hier bewusst reines Markup.
const DEMO_PROSE = [
  {
    chapter: 'Kapitel 1 — Das Erwachen',
    pages: [
      {
        name: 'Die Verwandlung',
        blocks: [
          'Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt. Er lag auf seinem panzerartig harten Rücken und sah, wenn er den Kopf ein wenig hob, seinen gewölbten, braunen, von bogenförmigen Versteifungen geteilten Bauch, auf dessen Höhe sich die Bettdecke, zum gänzlichen Niedergleiten bereit, kaum noch erhalten konnte.',
          '„Was ist mit mir geschehen?", dachte er. Es war kein Traum. Sein Zimmer, ein richtiges, nur etwas zu kleines Menschenzimmer, lag ruhig zwischen den vier wohlbekannten Wänden. Über dem Tisch, auf dem eine auseinandergepackte Musterkollektion von Tuchwaren ausgebreitet war — Samsa war Reisender — hing das Bild, das er vor kurzem aus einer illustrierten Zeitschrift ausgeschnitten und in einem hübschen, vergoldeten Rahmen untergebracht hatte.',
        ],
      },
      {
        name: 'Die Familie',
        blocks: [
          'Die Verwandlung hatte den Haushalt der Familie Samsa von einem Tag auf den anderen verändert. Der Vater, der seit fünf Jahren nicht mehr gearbeitet hatte, kramte alte Anzüge aus dem Schrank. Die Mutter, von Asthma geplagt, nähte feine Wäsche für ein Modegeschäft, und die Schwester Grete, gerade siebzehn Jahre alt, hatte eine Stellung als Verkäuferin gefunden.',
          'Gregor verfolgte alle Geräusche durch die geschlossene Tür. Er erkannte den Gang des Vaters, das schleppende Schreiten der Mutter, den raschen, leichten Schritt der Schwester. Manchmal wurde die Tür geöffnet, und Grete trat herein. Sie stellte die Schüssel mit Speiseresten in eine Ecke und zog sich rasch wieder zurück.',
        ],
      },
    ],
  },
  {
    chapter: 'Kapitel 2 — Der Rückzug',
    pages: [
      {
        name: 'Der Apfel',
        blocks: [
          'Eines Abends kam der Vater früher als sonst nach Hause. Gregor hatte das Zimmer verlassen wollen, um die Schwester nicht zu erschrecken. Doch der Vater, in seiner blauen Uniform mit den Goldknöpfen, sah die Tochter mit dem Schreckensschrei umsinken. Er griff nach einer Schüssel mit Obst, die auf der Anrichte stand, und begann, Apfel um Apfel zu werfen.',
          'Ein schwach geworfener Apfel streifte Gregors Rücken, glitt aber ohne Schaden ab. Ein ihm sofort nachfliegender drang dagegen förmlich in Gregors Rücken ein. Gregor wollte sich weiterschleppen, als drücke ihn der überraschende, unglaubliche Schmerz.',
        ],
      },
      {
        name: 'Drei Untermieter',
        blocks: [
          'Die drei Zimmerherren waren ernste Männer. Alle drei trugen Vollbärte und sahen einander zum Verwechseln ähnlich. Sie nahmen ihre Mahlzeiten mit ungeheurer Würde ein und prüften jeden Bissen, bevor er in den Mund gelangte. Die Eltern sahen ihnen mit Sorgfalt zu, dass nichts fehlte.',
          'Doch eines Abends spielte Grete Violine in der Küche. Der mittlere Herr rief zuerst seinen Freunden zu: „Kommen Sie doch, die Tochter spielt!" Sie nickten und setzten sich erwartungsvoll. Da öffnete Gregor die Tür um einen Spalt — und alle drei Herren bemerkten ihn zugleich.',
        ],
      },
      {
        name: 'Ende',
        blocks: [
          'Am frühen Morgen kam die Bedienerin und schrie laut auf. Sie stand vor dem leblosen Körper Gregors. Die Familie eilte herbei: der Vater im Hemd, die Mutter im Schlafrock, Grete in einem dünnen Kleid. „Tot?", fragte die Mutter. „Ich glaub schon", sagte die Bedienerin.',
          'Grete wandte den Blick nicht von dem Leichnam ab. „Seht nur, wie mager er war. Er hat ja auch schon so lange nichts gegessen." Dann verließ die Familie gemeinsam die Wohnung, was sie seit Monaten nicht mehr getan hatte, und fuhr mit der elektrischen Bahn ins Freie vor die Stadt.',
        ],
      },
    ],
  },
];

// Legt das Beispielbuch fuer einen User an (idempotent pro User: existiert es
// schon, wird die bestehende Buch-ID zurueckgegeben statt eines Duplikats).
// Laeuft ueber die Content-Store-Facade (createBook/createChapter/createPage) —
// der Write-Chokepoint vergibt data-bid, hookt den FTS-Index und legt eine
// Erst-Revision an. Rueckgabe: { bookId, deduplicated }.
async function createDemoBook(userEmail) {
  const ctx = { session: { user: { email: userEmail } } };

  // Dedup: Buchliste des Users ueber die Facade (kein direkter books-Zugriff).
  const existing = (await contentStore.listBooks(ctx)).find(b => b && b.name === DEMO_BOOK_NAME);
  if (existing) return { bookId: existing.id, deduplicated: true };

  const created = await contentStore.createBook(
    { name: DEMO_BOOK_NAME, description: DEMO_BOOK_DESCRIPTION, owner_email: userEmail },
    ctx,
  );
  const bookId = created.id;
  try {
    bookAccess.grantAccess(bookId, userEmail, 'owner', userEmail);
  } catch (e) {
    logger.warn(`Demo-Buch: Owner-Grant fuer book=${bookId} fehlgeschlagen: ${e.message}`);
  }

  let pages = 0;
  for (const ch of DEMO_PROSE) {
    const chapter = await contentStore.createChapter(
      { book_id: bookId, name: ch.chapter, parent_chapter_id: null },
      ctx,
    );
    for (const p of ch.pages) {
      const html = p.blocks.map(t => `<p>${t}</p>`).join('');
      await contentStore.createPage(
        { book_id: bookId, chapter_id: chapter.id, name: p.name, html },
        ctx,
      );
      pages += 1;
    }
  }

  logger.info(`Demo-Buch «${DEMO_BOOK_NAME}» angelegt (id=${bookId}, ${DEMO_PROSE.length} Kapitel, ${pages} Seiten) fuer ${userEmail}`);
  return { bookId, deduplicated: false };
}

module.exports = { createDemoBook, DEMO_BOOK_NAME };
