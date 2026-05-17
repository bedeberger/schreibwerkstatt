'use strict';
// Einmaliger Auto-Seed fuer LOCAL_DEV_MODE + app.backend='localdb'.
// Verhindert, dass der Dev-User auf
// leerer DB ohne Buch landet.
//
// Trigger-Bedingung (alle vier muessen passen):
//   - LOCAL_DEV_MODE === 'true'
//   - LOCAL_DEV_SEED !== 'false' (Default an; explizit auf 'false' fuer
//     Empty-State-Tests aus Prod-Sicht)
//   - app.backend === 'localdb' (im bookstack-Mode irrelevant)
//   - SELECT COUNT(*) FROM books = 0 (idempotent)
//
// Prosa-Text: Public-Domain (Franz Kafka, „Die Verwandlung" — gemeinfrei seit
// 1995). Genug Material, damit figuren/szenen/lektorat/komplett echte Findings
// erzeugen, nicht Empty-State.

const { db } = require('../db/connection');
const appSettings = require('./app-settings');
const logger = require('../logger');

const _PROSE = [
  {
    chapter: 'Kapitel 1',
    pages: [
      {
        name: 'Die Verwandlung',
        html:
          '<p>Als Gregor Samsa eines Morgens aus unruhigen Träumen erwachte, fand er sich in seinem Bett zu einem ungeheueren Ungeziefer verwandelt. Er lag auf seinem panzerartig harten Rücken und sah, wenn er den Kopf ein wenig hob, seinen gewölbten, braunen, von bogenförmigen Versteifungen geteilten Bauch, auf dessen Höhe sich die Bettdecke, zum gänzlichen Niedergleiten bereit, kaum noch erhalten konnte. Seine vielen, im Vergleich zu seinem sonstigen Umfang kläglich dünnen Beine flimmerten ihm hilflos vor den Augen.</p>' +
          '<p>„Was ist mit mir geschehen?", dachte er. Es war kein Traum. Sein Zimmer, ein richtiges, nur etwas zu kleines Menschenzimmer, lag ruhig zwischen den vier wohlbekannten Wänden. Über dem Tisch, auf dem eine auseinandergepackte Musterkollektion von Tuchwaren ausgebreitet war — Samsa war Reisender — hing das Bild, das er vor kurzem aus einer illustrierten Zeitschrift ausgeschnitten und in einem hübschen, vergoldeten Rahmen untergebracht hatte.</p>',
      },
      {
        name: 'Familie',
        html:
          '<p>Die Verwandlung hatte den Haushalt der Familie Samsa von einem Tag auf den anderen verändert. Der Vater, der seit fünf Jahren nicht mehr gearbeitet hatte, kramte alte Anzüge aus dem Schrank. Die Mutter, von Asthma geplagt, nähte feine Wäsche für ein Modegeschäft, und die Schwester Grete, gerade siebzehn Jahre alt, hatte ein Stellung als Verkäuferin gefunden.</p>' +
          '<p>Gregor verfolgte alle Geräusche durch die geschlossene Tür. Er erkannte den Gang des Vaters, das schleppende Schreiten der Mutter, den raschen, leichten Schritt der Schwester. Manchmal wurde die Tür geöffnet, und Grete trat herein. Sie stellte die Schüssel mit alten Speiseresten in eine Ecke und zog sich rasch wieder zurück.</p>',
      },
    ],
  },
  {
    chapter: 'Kapitel 2',
    pages: [
      {
        name: 'Der Apfel',
        html:
          '<p>Eines Abends kam der Vater früher als sonst nach Hause. Gregor hatte das Zimmer verlassen wollen, um die Schwester nicht zu erschrecken. Doch der Vater, in seiner blauen Uniform mit den Goldknöpfen, sah die Tochter mit dem Schreckensschrei umsinken. Er griff nach einer Schüssel mit Obst, die auf der Anrichte stand, und begann, Apfel um Apfel zu werfen.</p>' +
          '<p>Ein schwach geworfener Apfel streifte Gregors Rücken, glitt aber ohne Schaden ab. Ein ihm sofort nachfliegender drang dagegen förmlich in Gregors Rücken ein. Gregor wollte sich weiter schleppen, als drücke ihn der überraschende, unglaubliche Schmerz. Mit dem letzten Blick sah er noch, wie die Tür seines Zimmers aufgerissen wurde und vor der schreienden Schwester die Mutter herauslief, gänzlich entkleidet, denn die Schwester hatte sie entkleidet, um ihr im Ohnmachtsanfall Luft zu verschaffen.</p>',
      },
      {
        name: 'Drei Untermieter',
        html:
          '<p>Die drei Zimmerherren waren ernste Männer. Alle drei trugen Vollbärte und sahen einander zum Verwechseln ähnlich. Sie nahmen ihre Mahlzeiten mit ungeheurer Würde ein und prüften jeden Bissen, bevor er in den Mund gelangte. Die Eltern sahen ihnen mit Sorgfalt zu, dass nichts fehlte. Grete war stets bereit, das geringste Bedürfnis zu erfüllen.</p>' +
          '<p>Doch eines Abends spielte Grete Violine in der Küche. Der mittlere Herr rief zuerst seinen Freunden zu: „Kommen Sie doch, die Tochter spielt!" Sie nickten und setzten sich erwartungsvoll. Da öffnete Gregor die Tür um einen Spalt — und alle drei Herren bemerkten ihn zugleich.</p>',
      },
      {
        name: 'Ende',
        html:
          '<p>Am frühen Morgen kam die Bedienerin und schrie laut auf. Sie stand vor dem leblosen Körper Gregors. Die Familie eilte herbei: der Vater im Hemd, die Mutter im Schlafrock, Grete in einem dünnen Kleid. „Tot?", fragte die Mutter. „Ich glaub schon", sagte die Bedienerin. Herr Samsa sagte: „Nun, jetzt können wir Gott danken." Er bekreuzigte sich, und die drei Frauen folgten seinem Beispiel.</p>' +
          '<p>Grete wandte den Blick nicht von dem Leichnam ab. „Seht nur, wie mager er war. Er hat ja auch schon so lange nichts gegessen. So wie die Speisen hereinkamen, sind sie wieder hinausgekommen." Tatsächlich war Gregors Körper vollständig flach und trocken; man erkannte es eigentlich erst jetzt, da er nicht mehr von den Beinchen gehoben wurde und auch sonst kein Blick die Sicht ablenkte.</p>',
      },
    ],
  },
];

function _shouldSeed() {
  const devMode = String(process.env.LOCAL_DEV_MODE || '').toLowerCase() === 'true';
  if (!devMode) return { run: false, reason: 'LOCAL_DEV_MODE != true' };
  const seedOn = String(process.env.LOCAL_DEV_SEED || '').toLowerCase() !== 'false';
  if (!seedOn) return { run: false, reason: 'LOCAL_DEV_SEED = false' };
  const backend = String(appSettings.get('app.backend') || 'bookstack').toLowerCase();
  if (backend !== 'localdb') return { run: false, reason: `app.backend = ${backend}` };
  const { c } = db.prepare('SELECT COUNT(*) AS c FROM books').get();
  if (c > 0) return { run: false, reason: `books-Tabelle hat bereits ${c} Eintraege` };
  return { run: true, reason: null };
}

function runDevSeedIfNeeded() {
  const decision = _shouldSeed();
  if (!decision.run) {
    if (decision.reason && String(process.env.LOCAL_DEV_MODE || '').toLowerCase() === 'true') {
      logger.info(`LOCAL_DEV_SEED uebersprungen: ${decision.reason}`);
    }
    return null;
  }
  const now = new Date().toISOString();
  const bookId = db.prepare(`
    INSERT INTO books (name, slug, description, owner_email, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('Devmode-Testbuch', 'devmode-testbuch', 'Public-Domain-Prosa fuer Local-Dev-Smoke-Tests.', 'dev@local', now, now).lastInsertRowid;

  let chapterPosition = 0;
  let pagePosition = 0;
  let pageCount = 0;
  for (const ch of _PROSE) {
    const chapterId = db.prepare(`
      INSERT INTO chapters (book_id, chapter_name, position, priority, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(bookId, ch.chapter, chapterPosition, chapterPosition, now).lastInsertRowid;
    chapterPosition += 1;

    for (const p of ch.pages) {
      db.prepare(`
        INSERT INTO pages (book_id, chapter_id, page_name, body_html, position, priority, updated_at, local_updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(bookId, chapterId, p.name, p.html, pagePosition, pagePosition, now, now);
      pagePosition += 1;
      pageCount += 1;
    }
  }

  logger.info(`LOCAL_DEV_SEED: Buch "Devmode-Testbuch" (id=${bookId}) mit ${_PROSE.length} Kapiteln + ${pageCount} Pages angelegt.`);
  return { bookId, chapters: _PROSE.length, pages: pageCount };
}

module.exports = { runDevSeedIfNeeded, _shouldSeed };
