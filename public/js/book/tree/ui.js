// Sidebar-Tooltip-Helper (Token-Badge + Page-Status). Halten Layout-Code aus dem
// Template fern; die im Root liegenden Show-Flags + Pos werden direkt mutiert.
// `this` = die Alpine-Komponente.
import { EVT } from '../../events.js';

export const treeUiMethods = {
  _showTokTip(el, data, opts = {}) {
    if (!el || !data) return;
    // Badge lebt in einem [data-tip]-Vorfahren (Kapitel-Header, Page-Item); der
    // geteilte Tooltip-Layer klettert sonst dorthin und konkurriert mit diesem.
    window.dispatchEvent(new CustomEvent(EVT.TOOLTIP_HIDE));
    const r = el.getBoundingClientRect();
    this.tokLegendPos = { x: r.left, y: r.top };
    this.tokTooltipData = { ...data, ...opts };
    this.showTokLegend = true;
  },
  _hideTokTip() {
    this.showTokLegend = false;
    this.tokTooltipData = null;
  },
  _showStatusTip(el, page) {
    if (!el || !page) return;
    window.dispatchEvent(new CustomEvent(EVT.TOOLTIP_HIDE));
    const r = el.getBoundingClientRect();
    this.pageStatusTipPos = { x: r.left, y: r.top };
    this.pageStatusTipLines = this.pageStatusTooltip(page);
    this.showPageStatusTip = true;
  },
  _hideStatusTip() {
    this.showPageStatusTip = false;
  },
};
