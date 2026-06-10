'use strict';

const { splitParagraphs, splitSentences, splitAtSentence } = require('../lib/text');

function buildStyleSamples(ctx) {
  const {
    samples, counts, opts, langIsEn, unifiedSys,
    pageContents,
    chapterKeys, chapterFullTextByKey, chapterNameByKey, pagesByChapter,
    sceneRows, pageTextById,
  } = ctx;
  const { minChars, maxChars } = opts;

  const prefix = langIsEn
    ? "Continue the following passage in the author's style:\n\n"
    : 'Setze den folgenden Abschnitt im Stil des Autors fort:\n\n';
  const contextPrefix = langIsEn
    ? "Given this passage, continue in the author's style. Write only the next paragraph:\n\n"
    : 'Setze den folgenden Abschnitt fort. Schreibe nur den nächsten Absatz im Stil des Autors:\n\n';

  // Split-Ratios pro Absatz: 50/50 ist das stärkste Signal (Haupt-Sample),
  // 25/75 und 75/25 ergänzen als augmentierte Varianten (Training-Volumen
  // ×3 bei gleichem Ausgangsmaterial). Verhindert dass das Modell nur
  // „halbierte" Prompt-Länge als Stil-Fortsetzung kennt.
  const splitRatios = [0.50, 0.25, 0.75];

  for (const p of pageContents) {
    const paragraphs = splitParagraphs(p.text);
    // Split-Gruppe = Kapitel der Seite (siehe finalize.js: Train/Val-Split auf
    // Quell-Ebene, damit Ableitungen derselben Seite/desselben Kapitels nicht
    // über train und val lecken).
    const pageCh = 'ch:' + (p.chapter_id ?? 0);

    // ── Intra-Absatz-Splits (Sliding-Windows) ─────────────────────────
    for (let pi = 0; pi < paragraphs.length; pi++) {
      const para = paragraphs[pi];
      if (para.length < minChars) continue;
      const clipped = para.length > maxChars ? para.slice(0, maxChars) : para;
      for (let ri = 0; ri < splitRatios.length; ri++) {
        const [first, second] = splitAtSentence(clipped, splitRatios[ri]);
        if (first.length < 60 || second.length < 60) continue;
        samples.push({
          id: 'style|' + p.id + '|' + pi + '|r' + ri,
          type: 'style',
          sourceKey: pageCh,
          messages: [
            { role: 'system', content: unifiedSys },
            { role: 'user', content: prefix + first },
            { role: 'assistant', content: second },
          ],
        });
        counts.style++;
      }
    }

    // ── Multi-Absatz-Kontext (Langstrecken-Kohärenz) ──────────────────
    // Prompt = vorhergehende 1–3 Absätze, Completion = nächster Absatz.
    // Teaches long-range coherence so dass Fortsetzungen über Absätze
    // hinweg klingen wie der Autor. Überspringt Einträge, wenn der
    // Prompt-Kontext zu kurz oder zu lang ist.
    const CTX_MAX_PROMPT = Math.floor(maxChars * 2);
    for (let i = 1; i < paragraphs.length; i++) {
      const next = paragraphs[i];
      if (next.length < minChars) continue;
      const ctxStart = Math.max(0, i - 3);
      const context = paragraphs.slice(ctxStart, i).join('\n\n');
      if (context.length < 200) continue;
      const ctxClipped = context.length > CTX_MAX_PROMPT
        ? context.slice(context.length - CTX_MAX_PROMPT)
        : context;
      const completion = next.length > maxChars ? next.slice(0, maxChars) : next;
      if (completion.length < 80) continue;
      samples.push({
        id: 'styleCtx|' + p.id + '|' + i,
        type: 'style',
        sourceKey: pageCh,
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user', content: contextPrefix + ctxClipped },
          { role: 'assistant', content: completion },
        ],
      });
      counts.style++;
    }

    // ── Satz-Level-Fortsetzung (#1) ───────────────────────────────────
    // Feinstes Kontinuitäts-Signal: pro Satz Kontext (1–2 vorherige Sätze)
    // → nächster Satz. Limit pro Seite, damit einzelne lange Seiten nicht
    // den Trainings-Pool dominieren. Nur Sätze 40–300 Zeichen (Rauschen raus).
    const SENT_CAP_PER_PAGE = 40 * (opts.biasBoost || 1);
    const sentPrefix = langIsEn ? 'Next sentence after:\n\n' : 'Nächster Satz nach:\n\n';
    const pageSentences = paragraphs.flatMap(splitSentences);
    let sentEmit = 0;
    for (let i = 1; i < pageSentences.length && sentEmit < SENT_CAP_PER_PAGE; i++) {
      const cur = pageSentences[i];
      if (cur.length < 40 || cur.length > 300) continue;
      const prev = pageSentences.slice(Math.max(0, i - 2), i).join(' ');
      if (prev.length < 30) continue;
      samples.push({
        id: 'styleSent|' + p.id + '|' + i,
        type: 'style',
        sourceKey: pageCh,
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user',   content: sentPrefix + prev },
          { role: 'assistant', content: cur },
        ],
      });
      counts.style++;
      sentEmit++;
    }
  }

  // ── Kapitel-Transitions (#2) ────────────────────────────────────────
  // Ende Kapitel N → Anfang Kapitel N+1. Zentrales Signal für das „wie
  // beginne ich ein neues Kapitel"-Gefühl — genau das, was fürs
  // Fortsetzungs-Schreiben gebraucht wird.
  for (let i = 0; i + 1 < chapterKeys.length; i++) {
    const kA = chapterKeys[i];
    const kB = chapterKeys[i + 1];
    const textA = chapterFullTextByKey.get(kA) || '';
    const textB = chapterFullTextByKey.get(kB) || '';
    if (textA.length < 400 || textB.length < 400) continue;
    const tailA = splitAtSentence(textA.slice(-Math.min(textA.length, 1200)), 0.2)[1] || textA.slice(-600);
    const headB = splitAtSentence(textB.slice(0, Math.min(textB.length, 1200)), 0.8)[0] || textB.slice(0, 600);
    if (tailA.length < 120 || headB.length < 120) continue;
    const nameA = chapterNameByKey.get(kA);
    const nameB = chapterNameByKey.get(kB);
    const prompt = (langIsEn
      ? `End of chapter «${nameA}»:\n\n`
      : `Ende von Kapitel «${nameA}»:\n\n`)
      + tailA
      + (langIsEn
        ? `\n\nNow begin chapter «${nameB}» in the same voice:`
        : `\n\nBeginne nun Kapitel «${nameB}» im selben Ton:`);
    samples.push({
      id: 'chapTrans|' + kA + '|' + kB,
      type: 'style',
      sourceKey: 'ch:' + kB, // Completion = Anfang Kapitel B
      messages: [
        { role: 'system', content: unifiedSys },
        { role: 'user',   content: prompt },
        { role: 'assistant', content: headB.length > maxChars ? headB.slice(0, maxChars) : headB },
      ],
    });
    counts.style++;
  }

  // ── Szenen-Transitions (#3) ────────────────────────────────────────
  // Ende einer Szene → Anfang der nächsten. Nutzt sceneRows-Reihenfolge
  // pro Kapitel; beide Szenen müssen einen page_id-Mapping haben, sonst
  // kein Text zum Anknüpfen.
  const sceneByChapterKey = new Map();
  for (const s of sceneRows) {
    if (!s.page_id) continue;
    const k = s.chapter_id ?? 0;
    if (!sceneByChapterKey.has(k)) sceneByChapterKey.set(k, []);
    sceneByChapterKey.get(k).push(s);
  }
  for (const [scnChKey, scenesInCh] of sceneByChapterKey) {
    for (let i = 0; i + 1 < scenesInCh.length; i++) {
      const sA = scenesInCh[i], sB = scenesInCh[i + 1];
      const txtA = pageTextById.get(sA.page_id) || '';
      const txtB = pageTextById.get(sB.page_id) || '';
      if (txtA.length < 200 || txtB.length < 200) continue;
      if (sA.page_id === sB.page_id) continue;
      const tailA = txtA.slice(-Math.min(txtA.length, 800));
      const headB = txtB.slice(0, Math.min(txtB.length, 800));
      const prompt = (langIsEn
        ? `End of scene «${sA.titel || ''}»:\n\n${tailA}\n\nContinue with scene «${sB.titel || ''}»:`
        : `Ende der Szene «${sA.titel || ''}»:\n\n${tailA}\n\nFahre fort mit der Szene «${sB.titel || ''}»:`);
      samples.push({
        id: 'scnTrans|' + sA.id + '|' + sB.id,
        type: 'style',
        sourceKey: 'ch:' + scnChKey,
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user',   content: prompt },
          { role: 'assistant', content: headB },
        ],
      });
      counts.style++;
    }
  }

  // ── Kapitel-Level-Sliding-Windows (#5) ──────────────────────────────
  // Alle Absätze eines Kapitels als durchgängiger Stream — Sliding mit
  // Fenster 3 (Kontext) → 1 (Completion). Verbindet sich über Seitengrenzen
  // hinweg, anders als der page-lokale Multi-Absatz-Kontext oben.
  const chapWinPrefix = contextPrefix;
  for (const k of chapterKeys) {
    const pages = pagesByChapter.get(k) || [];
    if (pages.length < 2) continue;
    const allParas = pages.flatMap(pp => splitParagraphs(pp.text));
    if (allParas.length < 4) continue;
    const WIN = 3;
    const STRIDE = 2; // jedes zweite Absatz-Target: reduziert Duplikation mit dem page-lokalen Block
    for (let i = WIN; i < allParas.length; i += STRIDE) {
      const next = allParas[i];
      if (next.length < minChars) continue;
      const context = allParas.slice(i - WIN, i).join('\n\n');
      if (context.length < 300) continue;
      const ctxClipped = context.length > Math.floor(maxChars * 2)
        ? context.slice(context.length - Math.floor(maxChars * 2))
        : context;
      const completion = next.length > maxChars ? next.slice(0, maxChars) : next;
      if (completion.length < 80) continue;
      samples.push({
        id: 'chapWin|' + k + '|' + i,
        type: 'style',
        sourceKey: 'ch:' + k,
        messages: [
          { role: 'system', content: unifiedSys },
          { role: 'user',   content: chapWinPrefix + ctxClipped },
          { role: 'assistant', content: completion },
        ],
      });
      counts.style++;
    }
  }
}

module.exports = { buildStyleSamples };
