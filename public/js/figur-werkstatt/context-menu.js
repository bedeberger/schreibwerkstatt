// Rechtsklick-Menü auf Mindmap-Knoten: Brainstorm/Rename/AddChild/AddSibling/Delete.

import { _newNodeId } from './mindmap.js';

export const contextMenuMethods = {
  _onMindmapContextMenu(ev) {
    const target = ev.target.closest?.('jmnode');
    if (!target) { this._hideContextMenu(); return; }
    const nodeId = target.getAttribute('nodeid');
    if (!nodeId) return;
    ev.preventDefault();
    this._selectNodeQuiet(nodeId);
    this.selectedKnotenId = nodeId;
    this.contextMenuNodeId = nodeId;
    this.contextMenuPos = this._clampMenuPos(ev.clientX, ev.clientY);
    this.contextMenuOpen = true;
    if (!this._ctxOutsideHandler) {
      this._ctxOutsideHandler = (e) => {
        const menu = this.$el?.querySelector('.werkstatt-context-menu');
        if (menu && !menu.contains(e.target)) this._hideContextMenu();
      };
      document.addEventListener('mousedown', this._ctxOutsideHandler, true);
      document.addEventListener('keydown', this._ctxEscHandler = (e) => {
        if (e.key === 'Escape') this._hideContextMenu();
      });
    }
  },

  _clampMenuPos(x, y) {
    const W = 240, H = 240;
    // .card-Ancestor hat transform (cardFadeIn) → erzeugt Containing-Block für
    // position:fixed. clientX/Y sind viewport-relativ; Card-Rect-Offset abziehen.
    let dx = 0, dy = 0;
    const cb = this.$el?.closest('.card');
    if (cb) {
      const r = cb.getBoundingClientRect();
      dx = r.left; dy = r.top;
    }
    return {
      left: Math.min(window.innerWidth - W - 8, x) - dx,
      top: Math.min(window.innerHeight - H - 8, y) - dy,
    };
  },

  _hideContextMenu() {
    this.contextMenuOpen = false;
    this.contextMenuNodeId = null;
    if (this._ctxOutsideHandler) {
      document.removeEventListener('mousedown', this._ctxOutsideHandler, true);
      this._ctxOutsideHandler = null;
    }
    if (this._ctxEscHandler) {
      document.removeEventListener('keydown', this._ctxEscHandler);
      this._ctxEscHandler = null;
    }
  },

  ctxRename() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id || !this._jm) return;
    try { this._jm.begin_edit(id); } catch {}
  },

  ctxAddChild() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id) return;
    const newId = _newNodeId();
    const label = window.__app.t('werkstatt.tree.custom') || 'Neuer Knoten';
    this._mutateMindmapQuiet(jm => {
      jm.add_node(id, newId, label);
      jm.select_node(newId);
      jm.begin_edit(newId);
    });
  },

  ctxAddSibling() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id) return;
    const newId = _newNodeId();
    const label = window.__app.t('werkstatt.tree.custom') || 'Neuer Knoten';
    this._mutateMindmapQuiet(jm => {
      jm.insert_node_after(id, newId, label);
      jm.select_node(newId);
      jm.begin_edit(newId);
    });
  },

  ctxDelete() {
    const id = this.contextMenuNodeId;
    this._hideContextMenu();
    if (!id || id === 'root') return;
    this._mutateMindmap(jm => jm.remove_node(id));
  },

  ctxBrainstorm() {
    this._hideContextMenu();
    this.runBrainstorm();
  },
};
