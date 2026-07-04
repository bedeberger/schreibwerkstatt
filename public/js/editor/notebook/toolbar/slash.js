// editorToolbarCard: Slash-Menü (Block-Transforms). `this` = Sub-Komponente
// (editorToolbarCard). Im Fokus-Modus deaktiviert (Trigger im keydown-Dispatch
// hinter dem Focus-Hard-Stop).

import { getEditEl, placeCaretIn, SLASH_ITEMS, _formatStamp } from './_shared.js';
import { contentRepo } from '../../../repo/content.js';

export const slashMethods = {
  _updateSlashPosition() {
    if (!this.slashShow || !this._slashBlock || !this._slashBlock.isConnected) return;
    const rect = this._slashBlock.getBoundingClientRect();
    // Block komplett ausserhalb des Viewports → schliessen.
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      this._closeSlash();
      return;
    }
    // Menü oberhalb des Blocks (näher am Caret in langen Texten, springt nicht
    // unter Fold). Position als Distanz vom Viewport-Boden, damit das Menü
    // mit seiner Unterkante am Block-Top „klebt" und nach oben wächst —
    // unabhängig von eigener Höhe.
    this.slashX = rect.left;
    this.slashY = Math.max(4, window.innerHeight - rect.top + 4);
  },

  // ── Slash-Menü ────────────────────────────────────────────────────────
  // Labels werden einmalig beim Öffnen aufgelöst (`_slashLabels`, gesetzt in
  // `_openSlashAt`) statt bei jedem Keystroke 14× `t()` aufzurufen.
  // `_buildSlashLabels` ist der Fallback, falls `slashItems` vor dem Öffnen
  // läuft (defensiv) – kein Getter im Data-Spread, sonst würde `this.t` zu
  // früh auf den Methoden selbst aufgerufen.
  _buildSlashLabels() {
    const app = window.__app;
    // Alles, was sich pro Eintrag nicht mit der Query ändert, wird hier einmal
    // beim Öffnen aufgelöst (Label, Gruppen-Label, Modifier-Klasse, Stempel).
    // Das Template liest dann nur noch Properties – keine `t()`-/Funktions-
    // Aufrufe pro Eintrag und Render, die beim Tippen reaktiv neu liefen.
    return SLASH_ITEMS.map(it => ({
      key: it.key,
      group: it.group,
      groupLabel: app?.t('editor.slash.group.' + it.group) || it.group,
      label: app?.t('editor.slash.' + it.key) || it.key,
      modClass: 'edit-slash-item--' + it.key,
      // Datums-/Zeit-Items zeigen den tatsächlich einzufügenden Wert als
      // Sekundär-Text (beim Öffnen aufgelöst; `_applySlashItem` rechnet beim
      // Einfügen ohnehin frisch).
      preview: it.insertText ? _formatStamp(it.insertText) : '',
    }));
  },
  // Filter: Substring-Match (case-insensitive) auf Label + Key, damit sowohl
  // DE-Labels („Über") als auch interne Keys („h2") tippbar sind. Ergebnis
  // wird pro Query gecacht – Template ruft `slashItems()` zweimal pro Render
  // (x-for + Leer-Check), der zweite Aufruf trifft den Cache statt neu zu
  // filtern.
  slashItems() {
    const q = (this.slashQuery || '').trim().toLowerCase();
    if (this._slashFilterCache && this._slashFilterCache.q === q) {
      return this._slashFilterCache.r;
    }
    const items = this._slashLabels || this._buildSlashLabels();
    const filtered = !q ? items : items.filter(it =>
      it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q));
    // `showGroup`: erstes Item seiner Gruppe in der gefilterten Liste → der
    // Gruppen-Header wird gerendert. Einmal pro Query berechnet, damit das
    // Template beim Tippen nicht pro Eintrag erneut `slashItems()` aufruft.
    let prevGroup = null;
    const r = filtered.map(it => {
      const showGroup = it.group !== prevGroup;
      prevGroup = it.group;
      return { ...it, showGroup };
    });
    this._slashFilterCache = { q, r };
    return r;
  },

  _openSlashAt(block) {
    this._slashBlock = block;
    this.slashIdx = 0;
    this.slashQuery = '';
    // Labels einmalig in der aktuellen Sprache auflösen; Filter-Cache leeren.
    this._slashLabels = this._buildSlashLabels();
    this._slashFilterCache = null;
    const rect = block.getBoundingClientRect();
    this.slashX = rect.left;
    this.slashY = Math.max(4, window.innerHeight - rect.top + 4);
    this.slashShow = true;
  },

  // Bild-Upload: Datei-Dialog → Upload → <figure>-Insert. Der Trigger-Block
  // wird vor dem async Upload gesichert; ist er beim Zurueckkommen weg (User hat
  // weitergetippt), haengen wir das Bild ans Editor-Ende.
  async _slashInsertImage(block) {
    const app = window.__app;
    const pageId = app?.currentPage?.id;
    if (!pageId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/webp,image/gif';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      let result;
      try {
        result = await contentRepo.uploadPageImage(pageId, file);
      } catch {
        app?._showJobToast?.({
          message: app?.t?.('editor.image.uploadError') || 'Bild-Upload fehlgeschlagen',
          severity: 'err', jobType: 'image', bookId: null,
        });
        return;
      }
      this._insertImageFigure(block, result);
    }, { once: true });
    input.click();
  },

  _insertImageFigure(block, result) {
    const editEl = getEditEl();
    if (!editEl || !result?.url) return;
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.src = result.url;
    img.alt = '';
    const cap = document.createElement('figcaption');
    cap.appendChild(document.createElement('br'));
    fig.appendChild(img);
    fig.appendChild(cap);
    if (block && block.isConnected && block.parentNode && editEl.contains(block)) {
      block.parentNode.replaceChild(fig, block);
    } else {
      editEl.appendChild(fig);
    }
    placeCaretIn(cap);
    window.__app?._markEditDirty?.();
  },

  _closeSlash() {
    this.slashShow = false;
    this.slashQuery = '';
    this._slashBlock = null;
    this._slashLabels = null;
    this._slashFilterCache = null;
    getEditEl()?.focus();
  },

  _applySlashByKey(key) {
    const item = SLASH_ITEMS.find(i => i.key === key);
    if (item) this._applySlashItem(item);
  },

  _applySlashItem(item) {
    const editEl = getEditEl();
    const block = this._slashBlock;
    if (!editEl || !block || !block.parentNode) { this._closeSlash(); return; }

    // Bild: oeffnet den Datei-Dialog. Async → Block vor dem Schliessen sichern,
    // Menue sofort schliessen (der Dialog uebernimmt).
    if (item.upload === 'image') {
      this._slashInsertImage(block);
      this._closeSlash();
      return;
    }

    // Datums-/Zeit-Stempel: ersetzt den (per Trigger leeren) Block durch
    // einen <p> mit dem formatierten Stempel-String. Caret hinter den Text,
    // damit der User direkt weiterschreiben kann.
    if (item.insertText) {
      const stamp = _formatStamp(item.insertText);
      const p = document.createElement('p');
      p.textContent = stamp;
      block.parentNode.replaceChild(p, block);
      const sel = document.getSelection();
      if (sel) {
        const range = document.createRange();
        range.selectNodeContents(p);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      window.__app?._markEditDirty?.();
      this._closeSlash();
      return;
    }

    let replacement;
    let caretTarget;

    if (item.tag === 'hr') {
      replacement = document.createElement('hr');
      if (item.className) replacement.className = item.className;
      block.parentNode.replaceChild(replacement, block);
      const next = document.createElement('p');
      next.appendChild(document.createElement('br'));
      replacement.insertAdjacentElement('afterend', next);
      caretTarget = next;
    } else if (item.todoList) {
      // Checkbox-Liste: <ul class="todo"><li class="todo-item">
      //   <input type=checkbox><span class="todo-text"><br></span></li></ul>
      replacement = document.createElement('ul');
      replacement.className = 'todo';
      const li = document.createElement('li');
      li.className = 'todo-item';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      const span = document.createElement('span');
      span.className = 'todo-text';
      span.appendChild(document.createElement('br'));
      li.appendChild(cb);
      li.appendChild(span);
      replacement.appendChild(li);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = span;
    } else if (item.list) {
      replacement = document.createElement(item.tag);
      const li = document.createElement('li');
      li.appendChild(document.createElement('br'));
      replacement.appendChild(li);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = li;
    } else if (item.wrapP) {
      // blockquote / .poem → enthält ein <p> als Schreibfläche.
      replacement = document.createElement(item.tag);
      if (item.className) replacement.className = item.className;
      const p = document.createElement('p');
      p.innerHTML = '<br>';
      replacement.appendChild(p);
      block.parentNode.replaceChild(replacement, block);
      caretTarget = p;
    } else {
      // Einfacher Tag-Swap (p, h2, h3).
      replacement = document.createElement(item.tag);
      replacement.innerHTML = '<br>';
      block.parentNode.replaceChild(replacement, block);
      caretTarget = replacement;
    }

    placeCaretIn(caretTarget);
    window.__app?._markEditDirty?.();
    this._closeSlash();
  },
};
