// Geteilter Review-Renderer für Buch- und Kapitelbewertung.
// Achsen-Set wird von aussen reingereicht, damit Buch- und Kapitel-Card
// dasselbe Markup teilen (Header/Stars/Summary/Achsen/Stärken/Schwächen/
// Empfehlungen/Zitate/Fazit) – nur die Achsen-Liste unterscheidet sich.

import { escHtml, escMd, renderStars, noteTip } from './utils.js';

// Mapping Prio → severity-tag-Variante. Reuse statt eigene Badge-Klassen.
// hoch = rot (kritisch), mittel = amber, niedrig = grau.
const PRIO_TO_SEVERITY = {
  hoch:    'kritisch',
  mittel:  'mittel',
  niedrig: 'niedrig',
};

// Achsen-Sets: [feldname-in-review-JSON, i18n-key-für-Section-Title]
export const BOOK_REVIEW_AXES = [
  ['struktur',    'review.section.struktur'],
  ['stil',        'review.section.stil'],
  ['plot',        'review.section.plot'],
  ['figuren',     'review.section.figuren'],
  ['dramaturgie', 'review.section.dramaturgie'],
  ['pacing',      'review.section.pacing'],
  ['thema',       'review.section.thema'],
];

export const CHAPTER_REVIEW_AXES = [
  ['dramaturgie', 'kapitelReview.section.dramaturgie'],
  ['pacing',      'kapitelReview.section.pacing'],
  ['kohaerenz',   'kapitelReview.section.kohaerenz'],
  ['perspektive', 'kapitelReview.section.perspektive'],
  ['figuren',     'kapitelReview.section.figuren'],
];

function renderEmpfehlungItem(item, translate) {
  // Backward-Compat: alte Reviews speichern empfehlungen als string[].
  if (typeof item === 'string') return `<li>${escMd(item)}</li>`;
  const prio      = (item?.prio || '').toLowerCase();
  const kategorie = (item?.kategorie || '').toLowerCase();
  const text      = item?.text || '';
  const sev       = PRIO_TO_SEVERITY[prio];
  const prioBadge = sev
    ? `<span class="severity-tag severity-tag--${sev}">${escHtml(translate('review.prio.' + prio))}</span>`
    : '';
  const catLabel  = kategorie ? translate('review.cat.' + kategorie) : '';
  const catSpan   = catLabel ? `<span class="rec-kategorie">${escHtml(catLabel)}</span>` : '';
  return `<li class="rec-item">${prioBadge}${catSpan}<span class="rec-text">${escMd(text)}</span></li>`;
}

function renderZitatItem(z, translate) {
  const kind = z?.kind === 'staerke' ? 'staerke' : 'schwaeche';
  const label = translate('review.zitate.' + kind);
  return `
        <li class="zitat-item zitat-item--${kind}">
          <div class="zitat-label">${escHtml(label)}</div>
          <blockquote class="zitat-text">${escMd(z?.zitat || '')}</blockquote>
          <div class="zitat-comment">${escMd(z?.kommentar || '')}</div>
        </li>`;
}

export function renderReviewHtml(r, axes, translate) {
  const stars = renderStars(r.gesamtnote);
  const tip = noteTip(r.gesamtnote);
  const tipAttr = tip ? ` data-tip="${escHtml(tip)}"` : '';
  let html = `
      <div class="bewertung-header">
        <span class="bewertung-stars"${tipAttr}>${stars}</span>
        <span class="bewertung-header-note">${escMd(r.gesamtnote_begruendung || '')}</span>
      </div>
      <div class="stilbox stilbox--review-summary">${escMd(r.zusammenfassung || '')}</div>`;
  for (const [key, i18n] of axes) {
    if (!r[key]) continue;
    html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate(i18n))}</div>
        <p class="bewertung-section-text">${escMd(r[key])}</p>
      </div>`;
  }
  if (r.staerken?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.strengths'))}</div>
        <ul class="bullet-list pos">${r.staerken.map(s => `<li>${escMd(s)}</li>`).join('')}</ul>
      </div>`;
  if (r.schwaechen?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.weaknesses'))}</div>
        <ul class="bullet-list neg">${r.schwaechen.map(s => `<li>${escMd(s)}</li>`).join('')}</ul>
      </div>`;
  if (r.empfehlungen?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.empfehlungen'))}</div>
        <ul class="rec-list">${r.empfehlungen.map(e => renderEmpfehlungItem(e, translate)).join('')}</ul>
      </div>`;
  if (r.beispielzitate?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.zitate'))}</div>
        <ul class="zitate-list">${r.beispielzitate.map(z => renderZitatItem(z, translate)).join('')}</ul>
      </div>`;
  if (r.fazit) html += `<div class="fazit fazit--review">${escMd(r.fazit)}</div>`;
  return html;
}
