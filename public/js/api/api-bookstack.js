import { buildStilkorrekturPrompt } from '../prompts.js';
import { SAFETY_HTML_RATIO, replaceInHtml, stripFocusArtefacts, fmtTok } from '../utils.js';
import { contentRepo } from '../repo/content.js';

// Editor-/Lektorat-Domain-Methoden, die in die Alpine-Komponente gespreadet
// werden. `this` bezeigt auf die Alpine-Wurzel. Storage-Zugriff laeuft
// ausschliesslich ueber contentRepo (Domain-Repository, /content/*).
//
// Hier verbleiben nur Funktionen, die nicht woanders besser passen:
//   - `_loadApplyAndSave` / `_applyStilkorrektur` / `_applyCorrections`
//     (Lektorat-Pipeline, ruft contentRepo + Stil-KI),
//   - `_checkPageConflict` (Optimistic-Concurrency-Vergleich),
//   - `bsRegisterPageLocally` / `bsRegisterChapterLocally` (lokale
//     `pages`/`chapters`-Cache-Upserts nach Page/Chapter-Create, hitten
//     `/sync/pages/upsert` bzw. `/sync/chapters/upsert` — kein BookStack-API).

export const bookstackMethods = {
  // Frisch erzeugte Seite sofort in die lokale `pages`-Tabelle eintragen,
  // damit FK-abhängige Features (ideen, page_checks, figure_scenes, …) auf der
  // Seite arbeiten können, bevor der nächste Sync läuft. Kapitel mit-upserten,
  // falls der Caller chapter_name kennt — sonst hängt ggf. auch dort eine
  // unbekannte chapter_id-FK.
  async bsRegisterPageLocally(created, chapter) {
    if (!created?.id || !created?.book_id) return;
    const body = {
      book_id: created.book_id,
      page_id: created.id,
      page_name: created.name || '',
      updated_at: created.updated_at || null,
    };
    if (created.chapter_id || chapter?.id) {
      body.chapter_id = created.chapter_id || chapter.id;
      if (chapter?.name) body.chapter_name = chapter.name;
    }
    try {
      await fetch('/sync/pages/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (_) { /* non-fatal */ }
  },

  async bsRegisterChapterLocally(created) {
    if (!created?.id || !created?.book_id || !created?.name) return;
    try {
      await fetch('/sync/chapters/upsert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          book_id: created.book_id,
          chapter_id: created.id,
          chapter_name: created.name,
          updated_at: created.updated_at || null,
        }),
      });
    } catch (_) { /* non-fatal */ }
  },

  // Pre-Save-Conflict-Check für Read-Modify-Write-Pfade. BookStack hat keinen
  // If-Match-Support — Optimistic-Concurrency baut die App selbst: kurz vor
  // dem PUT die Seite frisch lesen und `updated_at` mit dem Snapshot vergleichen,
  // den der Editor beim Öffnen mitgenommen hat. Mismatch → ein anderer User
  // hat zwischendrin gespeichert.
  // Liefert null bei keiner Diskrepanz, sonst { remoteUpdatedAt, remoteUserName,
  // remoteHtml }. Wirft nicht — Aufrufer entscheidet, was bei Read-Fehler passiert.
  async _checkPageConflict(pageId, expectedUpdatedAt) {
    if (!expectedUpdatedAt) return null;
    let remote;
    try {
      remote = await contentRepo.loadPage(pageId, { fresh: true });
    } catch {
      return null;
    }
    if (!remote?.updated_at || remote.updated_at === expectedUpdatedAt) return null;
    return {
      remoteUpdatedAt: remote.updated_at,
      remoteUserName: remote.updated_by_name || null,
      remoteHtml: remote.html || '',
    };
  },

  _applyCorrections(html, fehler) {
    let result = html;
    for (const f of fehler) {
      if (!f.original || !f.korrektur || f.original === f.korrektur) continue;
      result = replaceInHtml(result, f.original, f.korrektur);
    }
    return result;
  },

  // Ruft den Stil-KI-Call auf und wendet Korrekturen an.
  // Liefert { html, log, appliedStyles } – log enthält requested/returned/applied/items/error
  // für Debugging und Persistenz in page_checks.stilkorrektur_log.
  // hardOriginals: Originaltexte der Hard-Findings, die VOR der Stilkorrektur
  // schon ins HTML appliziert wurden — Stil-Findings, deren `original` sich mit
  // einem dieser Hard-Strings überschneidet, werden vor dem KI-Call gefiltert
  // (sonst sucht die KI Texte, die so nicht mehr im HTML stehen).
  async _applyStilkorrektur(html, selectedStyles, onProgress, hardOriginals = []) {
    const aiBase = html.length || 1;
    const log = {
      requested: selectedStyles.length,
      returned: 0,
      applied: 0,
      items: [],
      error: null,
      attempted_at: new Date().toISOString(),
    };
    // (1) Überlappungs-Filter: Stil-Findings, deren Originaltext sich mit einem
    // ausgewählten Hard-Finding überlappt (Substring in eine Richtung), schon
    // vor dem KI-Call droppen. Loggen mit reason='overlapped_with_hard'.
    const usableStyles = [];
    for (const s of selectedStyles) {
      const orig = s.original || '';
      const overlap = orig && hardOriginals.some(h => h && (h.includes(orig) || orig.includes(h)));
      if (overlap) {
        log.items.push({
          original: orig,
          ersatz: s.korrektur || '',
          applied: false,
          reason: 'overlapped_with_hard',
        });
      } else {
        usableStyles.push(s);
      }
    }
    if (usableStyles.length === 0) {
      console.info(`[stilkorrektur] requested=${log.requested} all dropped (overlapped_with_hard)`);
      return { html, log, appliedStyles: [] };
    }
    this.setStatus(this.t('stilkorrektur.workingChars', { chars: 0 }), true);
    try {
      let completionInfo = null;
      const result = await this.callAI(
        buildStilkorrekturPrompt(html, usableStyles),
        'stilkorrektur',
        (chars, tokIn) => {
          // tokensIn ist erst ab message_start verfügbar; tokensOut erst am Ende.
          // Bis tokensIn da ist: chars-Fallback. Danach: ↑in↓~out (chars/4-Schätzung,
          // Provider-Tokenizer divergieren → ~).
          const status = (tokIn > 0)
            ? this.t('stilkorrektur.workingTokens', {
                tokIn: fmtTok(tokIn),
                tokOutEst: fmtTok(Math.round(chars / 4)),
              })
            : this.t('stilkorrektur.workingChars', { chars });
          this.setStatus(status, true);
          if (onProgress) onProgress(chars, aiBase);
        },
        ({ tokensIn, tokensOut, tokPerSec }) => { completionInfo = { tokensIn, tokensOut, tokPerSec }; }
      );
      if (completionInfo) {
        this.setStatus(this.t('stilkorrektur.done', {
          tokIn: fmtTok(completionInfo.tokensIn || 0),
          tokOut: fmtTok(completionInfo.tokensOut || 0),
          tps: completionInfo.tokPerSec ? Math.round(completionInfo.tokPerSec) : 0,
        }), true);
      }
      const korrekturen = Array.isArray(result?.korrekturen) ? result.korrekturen : [];
      log.returned = korrekturen.length;
      let outHtml = html;
      // Per usableStyle merken, ob sie applied wurde – Mapping primär via
      // index-Feld der KI (1-basiert auf Liste oben), Fallback positional bei
      // Count-Match (KI liefert genau ebensoviele Einträge wie verlangt).
      const styleApplied = new Array(usableStyles.length).fill(false);
      const countMatches = korrekturen.length === usableStyles.length;
      for (let i = 0; i < korrekturen.length; i++) {
        const k = korrekturen[i];
        const skip = !k.original || !k.ersatz || k.original === k.ersatz;
        const before = outHtml;
        const after = skip ? before : replaceInHtml(outHtml, k.original, k.ersatz);
        const applied = !skip && after !== before;
        // Style-Index ableiten: KI-`index` bevorzugen, sonst positional bei Count-Match.
        let styleIdx = null;
        if (Number.isInteger(k.index)) {
          const cand = k.index - 1;
          if (cand >= 0 && cand < usableStyles.length) styleIdx = cand;
        }
        if (styleIdx === null && countMatches) styleIdx = i;
        log.items.push({
          index: k.index ?? null,
          style_idx: styleIdx,
          original: k.original || '',
          ersatz: k.ersatz || '',
          applied,
          reason: skip ? 'empty_or_identical' : (applied ? null : 'not_found_in_html'),
        });
        if (applied) {
          log.applied++;
          outHtml = after;
          if (styleIdx !== null) styleApplied[styleIdx] = true;
        }
      }
      const appliedStyles = usableStyles.filter((_, i) => styleApplied[i]);
      const dropped = log.requested - usableStyles.length;
      console.info(`[stilkorrektur] requested=${log.requested} dropped_overlap=${dropped} returned=${log.returned} applied=${log.applied} mappable=${appliedStyles.length}`);
      return { html: outHtml, log, appliedStyles };
    } catch (e) {
      console.error('[_applyStilkorrektur]', e);
      log.error = e?.message || String(e);
      this.setStatus(this.t('stilkorrektur.failed'), true);
      return { html, log, appliedStyles: [] };
    }
  },

  // Gemeinsamer Kern für Lektorat-Save und History-Apply:
  // Seite frisch laden → Korrekturen anwenden → Stilkorrektur → Safety-Check → Speichern.
  // onProgress(pct, statusText) – Fortschritt (10–85), statusText nur bei Phasenwechsel.
  // Liefert { finalHtml, stilLog } (stilLog null wenn keine Stil-Findings). Wirft bei Fehler.
  async _loadApplyAndSave(selectedErrors, selectedStyles, onProgress) {
    onProgress(10, this.t('bs.loadingPage'));
    // `fresh: true` umgeht SWR — sonst kann der CONTENT_CACHE nach kurz zuvor
    // gesetzten Edits noch die alte Fassung liefern, und der gleich folgende
    // PUT würde frische Server-Edits mit Stale-Daten überschreiben.
    // contentRepo.loadPage ruft stripFocusArtefacts intern, der zweite Aufruf
    // ist idempotenter Sicherheitsgurt.
    const page = await contentRepo.loadPage(this.currentPage.id, { fresh: true });
    page.html = stripFocusArtefacts(page.html || '');

    let finalHtml = selectedErrors.length > 0
      ? this._applyCorrections(page.html, selectedErrors)
      : page.html;

    let stilLog = null;
    let appliedStyles = [];
    if (selectedStyles.length > 0) {
      onProgress(30, null);
      const hardOriginals = selectedErrors.map(e => e?.original).filter(Boolean);
      const r = await this._applyStilkorrektur(
        finalHtml,
        selectedStyles,
        (chars, aiBase) => onProgress(Math.min(70, 30 + Math.round((chars / aiBase) * 40)), null),
        hardOriginals,
      );
      finalHtml = r.html;
      stilLog = r.log;
      appliedStyles = r.appliedStyles || [];
    }

    if (finalHtml.length < page.html.length * SAFETY_HTML_RATIO) {
      throw new Error(this.t('bs.unsafeHtml'));
    }

    onProgress(85, this.t('bs.savingToBookStack'));
    const saved = await contentRepo.savePage(this.currentPage.id, { html: finalHtml, name: this.currentPage.name });
    if (saved?.updated_at) this.currentPage.updated_at = saved.updated_at;
    // Übernommene Korrekturen sind eine direkte Folge des Lektorats — Seite soll nicht
    // unmittelbar danach auf "seit Lektorat bearbeitet" flippen.
    this.markPageChecked?.(this.currentPage.id);
    this._syncPageStatsAfterSave?.(this.currentPage, finalHtml);
    return { finalHtml, stilLog, appliedStyles };
  },
};
