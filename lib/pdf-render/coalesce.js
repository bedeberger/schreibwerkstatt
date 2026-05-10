'use strict';
// Gruppiert die loadBookContents-Output zu Render-Blöcken. Pro Kapitel ein
// Block; Modus 'flatten' verkettet alle Pages, 'nested' rendert pro Page einen
// h2-Sub-Heading.

function _coalesceGroups(groups, pageStructure, pageBreakBetweenPages) {
  // Liefert eine Liste { title, level, isChapter, body: [{ heading?, html }] }
  // - flatten:  pro Kapitel ein Block; alle Pages des Kapitels werden im
  //             Body-HTML verkettet, einzelne Page-Headings entfallen.
  // - nested:   pro Kapitel ein Block; jede BookStack-Page bekommt h2-Heading.
  const out = [];
  for (const g of groups) {
    if (g.chapter && g.pages.length > 1 && pageStructure === 'nested') {
      const items = [];
      for (let i = 0; i < g.pages.length; i++) {
        items.push({
          heading: g.pages[i].p.name,
          pageName: g.pages[i].p.name,
          html: g.pages[i].pd.html,
          breakBefore: i > 0 && pageBreakBetweenPages,
        });
      }
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        introHtml: g.chapter.description_html || '',
        items,
      });
    } else if (g.chapter) {
      // flatten: alle Pages im Kapitel zu einem Item zusammengefasst, einzelne
      // pageNames trotzdem behalten, damit `{pageTitle}` im Header/Footer auch
      // bei flattend-Rendering Sinn ergibt — wir nehmen den Namen der ERSTEN
      // BookStack-Page als Anker.
      const html = (g.chapter.description_html || '') + g.pages.map(x => x.pd.html).join('\n');
      out.push({
        title: g.chapter.name, level: 0, isChapter: true,
        introHtml: '',
        items: [{ html, pageName: g.pages[0]?.p?.name || g.chapter.name }],
      });
    } else {
      // Lose Seite ohne Kapitel.
      const x = g.pages[0];
      out.push({
        title: x.p.name, level: 0, isChapter: false, introHtml: '',
        items: [{ html: x.pd.html, pageName: x.p.name }],
      });
    }
  }
  return out;
}

module.exports = { _coalesceGroups };
