// Read-only Stream→HTML-Renderer für das kanonische Manuskript-Stream-Modell
// (manuscript-stream.js). Konsument: Share-SSR (routes/share.js lädt das Modul
// serverseitig via dynamic import(), Muster wie lib/prompts-loader.js).
//
// PURE + ISOMORPH: kein DOM, kein Browser-Import. Lokales escHtml (kein Import
// aus utils.js — das trägt Browser-Annahmen und würde den Node-Import brechen).
//
// ESCAPING-INVARIANTE: Entry-Namen werden via escHtml escaped; entry.html wird
// VERBATIM eingefügt (bereits via lib/html-clean.js sanitisiert, trägt data-bid
// für Kommentar-Anker). Niemals beides vertauschen — roher Name = XSS-Sink,
// doppelt-escaptes html = kaputte Anzeige.

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DEFAULTS = {
  chapterTag: 'h2',
  pageTag: 'h3',
  // Neutrale .ms-*-Klassen → geteilter Stream-Look (public/css/components/
  // manuscript-stream.css), gespiegelt vom Bucheditor.
  chapterClass: 'ms-chapter',
  pageSectionClass: 'ms-page',
  pageTitleClass: 'ms-page__title',
  pageBodyClass: 'ms-page__body',
  anchorPrefix: 'sec',
  // Bei Kapitel-Shares hängt der Kapitel-Titel schon im Seiten-Header (h1) —
  // dann KEIN Kapitel-Heading im Body (sonst doppelt), Seiten bleiben Top-Level.
  omitChapterHeaders: false,
};

// entries: StreamEntry[] (siehe manuscript-stream.js).
// Liefert { html, toc } — toc = [{ level, label, anchor, chapterId, pageId }] für
// buildTocBlock (label/anchor/level) sowie die Reader-Lesetiefe-Zuordnung
// (chapterId/pageId → echte Entitäten; additiv, andere Konsumenten ignorieren sie).
export function renderStreamHtml(entries, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const sections = [];
  const toc = [];
  let n = 0;
  for (const e of (entries || [])) {
    if (e.kind === 'chapter') {
      if (o.omitChapterHeaders) continue;
      const a = o.anchorPrefix + (++n);
      toc.push({ level: 1, label: e.name || '', anchor: a, chapterId: e.chapterId ?? null, pageId: null });
      sections.push(`<${o.chapterTag} id="${a}" class="${o.chapterClass}">${escHtml(e.name || '')}</${o.chapterTag}>`);
    } else if (e.kind === 'page') {
      const a = o.anchorPrefix + (++n);
      const level = (e.chapterId && !o.omitChapterHeaders) ? 2 : 1;
      toc.push({ level, label: e.name || '', anchor: a, chapterId: e.chapterId ?? null, pageId: e.id ?? null });
      sections.push(`<section class="${o.pageSectionClass}">
            <${o.pageTag} id="${a}" class="${o.pageTitleClass}">${escHtml(e.name || '')}</${o.pageTag}>
            <div class="${o.pageBodyClass}">${e.html || ''}</div>
          </section>`);
    }
  }
  return { html: sections.join('\n'), toc };
}
