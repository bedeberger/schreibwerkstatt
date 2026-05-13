// Buchbewertungs-Render-Helper. Der Job-Flow (Start, Poll, Render) lebt in
// Alpine.data('bookReviewCard'); hier nur das HTML-Rendering.

import { escHtml, escMd, renderStars } from './utils.js';

// Mapping Prio → severity-tag-Variante. Reuse statt eigene Badge-Klassen.
// hoch = rot (kritisch), mittel = amber, niedrig = grau.
const PRIO_TO_SEVERITY = {
  hoch:    'kritisch',
  mittel:  'mittel',
  niedrig: 'niedrig',
};

function _renderEmpfehlungItem(item, translate) {
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

function _renderZitatItem(z, translate) {
  const kind = z?.kind === 'staerke' ? 'staerke' : 'schwaeche';
  const label = translate('review.zitate.' + kind);
  return `
        <li class="zitat-item zitat-item--${kind}">
          <div class="zitat-label">${escHtml(label)}</div>
          <blockquote class="zitat-text">${escMd(z?.zitat || '')}</blockquote>
          <div class="zitat-comment">${escMd(z?.kommentar || '')}</div>
        </li>`;
}

export function renderReviewHtml(r, translate) {
  const stars = renderStars(r.gesamtnote);
  let html = `
      <div class="bewertung-header">
        <span class="bewertung-stars">${stars}</span>
        <span class="bewertung-header-note">${escMd(r.gesamtnote_begruendung || '')}</span>
      </div>
      <div class="stilbox stilbox--review-summary">${escMd(r.zusammenfassung || '')}</div>`;
  if (r.struktur) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.struktur'))}</div>
        <p class="bewertung-section-text">${escMd(r.struktur)}</p>
      </div>`;
  if (r.stil) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.stil'))}</div>
        <p class="bewertung-section-text">${escMd(r.stil)}</p>
      </div>`;
  if (r.plot) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.plot'))}</div>
        <p class="bewertung-section-text">${escMd(r.plot)}</p>
      </div>`;
  if (r.figuren) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.figuren'))}</div>
        <p class="bewertung-section-text">${escMd(r.figuren)}</p>
      </div>`;
  if (r.dramaturgie) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.dramaturgie'))}</div>
        <p class="bewertung-section-text">${escMd(r.dramaturgie)}</p>
      </div>`;
  if (r.pacing) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.pacing'))}</div>
        <p class="bewertung-section-text">${escMd(r.pacing)}</p>
      </div>`;
  if (r.thema) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.thema'))}</div>
        <p class="bewertung-section-text">${escMd(r.thema)}</p>
      </div>`;
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
        <ul class="rec-list">${r.empfehlungen.map(e => _renderEmpfehlungItem(e, translate)).join('')}</ul>
      </div>`;
  if (r.beispielzitate?.length) html += `
      <div class="bewertung-section">
        <div class="bewertung-section-title">${escHtml(translate('review.section.zitate'))}</div>
        <ul class="zitate-list">${r.beispielzitate.map(z => _renderZitatItem(z, translate)).join('')}</ul>
      </div>`;
  if (r.fazit) html += `<div class="fazit fazit--review">${escMd(r.fazit)}</div>`;
  return html;
}
