// `.internal-link`-Spans verhalten sich wie Buttons (z.B. Kapitel-Sprünge,
// Figuren-Öffnen). Per Delegation und MutationObserver machen wir sie
// tastatur-erreichbar (Tab/Enter/Space), ohne in jedem Partial role/tabindex
// setzen zu müssen. `:focus-visible`-Stil kommt aus style.css.
export function setupInternalLinkA11y() {
  const decorate = (root) => {
    root.querySelectorAll?.('.internal-link').forEach(el => {
      if (!el.hasAttribute('role')) el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '0');
    });
  };
  new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        // `:class="…internal-link…"`-Toggles auf bereits gemounteten Elementen
        // tauchen nicht in addedNodes auf; ohne attributeFilter würde A11y dort
        // nie greifen (Tab/Enter würde den Klick nicht auslösen).
        const t = m.target;
        if (t?.nodeType === 1 && t.classList?.contains('internal-link')) {
          if (!t.hasAttribute('role')) t.setAttribute('role', 'button');
          if (!t.hasAttribute('tabindex')) t.setAttribute('tabindex', '0');
        }
        continue;
      }
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue;
        if (n.classList?.contains('internal-link')) {
          if (!n.hasAttribute('role')) n.setAttribute('role', 'button');
          if (!n.hasAttribute('tabindex')) n.setAttribute('tabindex', '0');
        }
        decorate(n);
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!t?.classList?.contains?.('internal-link')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      t.click();
    }
  });
}
