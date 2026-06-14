// Durchschnittliche Zeichen pro Token für Display-Schätzungen. Wird in app.js aus
// /config überschrieben (Server setzt den provider-spezifischen Wert). Vor dem
// /config-Load bleibt der Claude-Default aktiv. Änderung ist via Live-Binding in
// allen Importern sofort sichtbar.
export let CHARS_PER_TOKEN = 3;

export function configureTokenEstimate(value) {
  const v = parseFloat(value);
  if (Number.isFinite(v) && v > 0) CHARS_PER_TOKEN = v;
}

// App-weite Zeitzone (Single Source of Truth, kommt vom Server via /config
// → app_settings.app.timezone). Treibt localIsoDate, Date-Display-Formatter
// (toLocaleString, Intl.DateTimeFormat) und Streak-Buckets. Browser-TZ wird
// damit ueberschrieben, damit GUI-Zeit zur Server-Zeit passt — z.B. ein in
// Zurich gehosteter Server zeigt fuer einen User, der gerade in NY ist,
// trotzdem Zurich-Zeit.
export let appTimezone = 'Europe/Zurich';

export function configureAppTimezone(tz) {
  if (typeof tz === 'string' && tz.length > 0) appTimezone = tz;
}

// Helper fuer Intl-Options-Bag: mergt `timeZone: appTimezone` in einen
// Options-Object, ohne ein explizites timeZone zu ueberschreiben.
export function tzOpts(opts = {}) {
  return opts.timeZone ? opts : { ...opts, timeZone: appTimezone };
}

/**
 * Fetch mit Pflicht-OK-Check und JSON-Parsing. Wirft bei HTTP-Fehlern,
 * damit der `.then(r => r.json())`-Pattern nicht stillschweigend HTML-
 * Fehlerseiten als JSON parst. 401 läuft durch den globalen fetch-Wrapper
 * in app.js (dispatcht `session-expired`) und wirft hier dann einen Fehler.
 */
export async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) {
    let detail = '';
    try { const e = await r.clone().json(); detail = e.error || e.message || ''; } catch (_) {}
    throw new Error(detail ? `HTTP ${r.status}: ${detail}` : `HTTP ${r.status}`);
  }
  return r.json();
}

/**
 * Löscht eine Alpine-Status-Property nach `delay`, wenn sie dann noch den
 * gesetzten Wert trägt. Verhindert, dass spätere Status-Updates durch einen
 * verzögerten Reset überschrieben werden – eigenes setTimeout-Idiom, das sich
 * an mehreren Stellen wiederholte.
 */
export function clearStatusAfter(obj, prop, expected, delay) {
  setTimeout(() => {
    if (obj[prop] === expected) obj[prop] = '';
  }, delay);
}

export async function fetchText(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// Sicherheitscheck vor dem Speichern: < 50 % wirkt unvollständig → Abbruch
export const SAFETY_HTML_RATIO = 0.5;

// Klassische Normseite (DIN): 30 Zeilen × ~50 Zeichen ≈ 1500 Zeichen.
// Sekundäre Umfangs-Kennzahl neben Zeichen/Wörter.
export const CHARS_PER_NORMSEITE = 1500;
export function charsToNormseiten(chars) {
  const n = Number(chars) || 0;
  return Math.round((n / CHARS_PER_NORMSEITE) * 10) / 10;
}

// Intl-Locale-Tag aus uiLocale (en → en-US, sonst de-CH).
export function localeTag(uiLocale) {
  return uiLocale === 'en' ? 'en-US' : 'de-CH';
}

// Live-Σ Zeichen/Wörter/Tokens über alle Seiten. Spiegelt
// routes/sync.js#syncBook-Total: Σ per-Seite-Stats. Seiten- und Kapitelnamen
// sind kein Teil des Umfangs.
export function aggregateLiveBookStats(tokEsts) {
  let chars = 0, words = 0, tok = 0;
  for (const id of Object.keys(tokEsts || {})) {
    const e = tokEsts[id];
    if (!e) continue;
    chars += Number(e.chars) || 0;
    words += Number(e.words) || 0;
    tok += Number(e.tok) || 0;
  }
  return { chars, words, tok };
}

// Pro Locale gecacht — Intl.RelativeTimeFormat-Konstruktion ist nicht gratis,
// und _fmtRelativeLine wird pro Sidebar-Render mehrfach aufgerufen.
const _RTF_CACHE = new Map();
export function relativeDay(diffDays, uiLocale) {
  const tag = localeTag(uiLocale);
  let rtf = _RTF_CACHE.get(tag);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
    _RTF_CACHE.set(tag, rtf);
  }
  return rtf.format(-diffDays, 'day');
}

// Relative Last-Run-Anzeige aus ISO-Timestamp. Server liefert nur den ISO-
// String; Lokalisierung passiert hier (i18n-Hard-Rule). `t` ist die i18n-Funktion,
// `uiLocale` der Sprachcode aus der App ('de' oder 'en'). Intl.RelativeTimeFormat
// liefert „heute"/„gestern"/„vor 3 Tagen" lokalisiert; Template setzt Time daneben.
export function formatLastRun(isoStr, t, uiLocale) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return '';
  const tag = localeTag(uiLocale);
  const time = d.toLocaleTimeString(tag, tzOpts({ hour: '2-digit', minute: '2-digit' }));
  // Tag-Bucket in appTimezone (nicht Browser-TZ): localIsoDate respektiert
  // app_settings.app.timezone, damit „heute/gestern" konsistent mit den
  // Server-Buckets (lib/local-date.js) und den restlichen TZ-Formattern bleibt
  // — auch wenn der Browser des Users in einer anderen TZ steht. UTC-Mittag-
  // Anker macht den Day-Diff DST-sicher.
  const dDay = new Date(localIsoDate(d) + 'T12:00:00Z');
  const today = new Date(localIsoDate(new Date()) + 'T12:00:00Z');
  const diffDays = Math.round((today - dDay) / 86400000);
  if (diffDays < 7) return t('job.lastRun.rel', { rel: relativeDay(diffDays, uiLocale), time });
  const date = d.toLocaleDateString(tag, tzOpts({ day: '2-digit', month: '2-digit' }));
  return t('job.lastRun.dateAt', { date, time });
}

// Locale-korrekte Zahl mit fixer Dezimalstellenzahl. Null/NaN → '–'.
export function formatNumber(value, uiLocale, decimals = 1) {
  if (value == null || !isFinite(value)) return '–';
  return value.toLocaleString(localeTag(uiLocale), {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// Exakte Dauer in h/min/s. 0 wird als „0 s" zurückgegeben. Komponenten mit
// Wert 0 werden weggelassen, ausser die Gesamtdauer ist 0. Ergebnis: „1 h 23 min 45 s",
// „23 min 5 s", „45 s". Einheiten sind locale-stabil (bewusst nicht übersetzt,
// damit eine Stelle die Reihenfolge h/min/s vorgibt).
// Lokales ISO-Datum (YYYY-MM-DD) — kein UTC. `new Date().toISOString().slice(0,10)`
// liefert UTC-Datum, das in CET um 1 Tag verschoben sein kann (lokal Mitternacht
// = UTC vor-22:00 Tag). Bug-Symptom: heutige Zeichen landen im Streak-Grid auf
// dem Vortag, weil Frontend-Iteration und Server-Snapshots auf unterschiedliche
// Datums-Strings mappen. Beide Seiten müssen lokal-konsistent sein.
//
// 'en-CA' liefert Format YYYY-MM-DD, ist sortier-tauglich, immutable per ECMA-402.
// timeZone ist die app-weite appTimezone (matcht Server-Datums-Buckets).
export function localIsoDate(d = new Date()) {
  return d.toLocaleDateString('en-CA', { timeZone: appTimezone });
}

// Lokales ISO-Datum n Tage in der Vergangenheit, kollisionssicher über
// DST-Wechsel (Math via getTime + 86_400_000 ist DST-blind, kann an
// Umstellungs-Tagen um 1h driften). Wir reduzieren zur Mittagszeit, weil
// Mittag in jeder TZ am gleichen Tag bleibt.
export function localIsoDaysAgo(n, base = new Date()) {
  const noon = new Date(base);
  noon.setHours(12, 0, 0, 0);
  noon.setDate(noon.getDate() - n);
  return localIsoDate(noon);
}

export function fmtExactDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (total === 0) return '0 s';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts = [];
  if (h > 0) parts.push(h + ' h');
  if (m > 0) parts.push(m + ' min');
  if (s > 0) parts.push(s + ' s');
  return parts.join(' ');
}

// Identity-cache memo für teure Filter/Sort-Computations in Alpine-Karten.
// `compute(deps)` läuft nur, wenn das Deps-Array sich per `===`-Identität
// gegenüber dem letzten Aufruf unterscheidet. Längen-Mismatch zählt als Diff.
//
// Use-Case: filteredXxx()/xxxKapitelListe()-Helper, die Alpine pro Render
// mehrfach aufruft. Ohne Memo läuft Filter+Sort jeden Tick — kostet bei
// langen Listen (Figuren mit Sort) merklich Zeit.
//
// Beispiel:
//   const memo = memoizeByIdentity((deps) => {
//     const [items, suche, kapitel] = deps;
//     return items.filter(...).sort(...);
//   });
//   filteredItems() {
//     return memo([this.items, this.filters.suche, this.filters.kapitel]);
//   }
export function memoizeByIdentity(compute) {
  let cachedDeps = null;
  let cachedResult;
  return function (deps) {
    if (cachedDeps && deps.length === cachedDeps.length) {
      let same = true;
      for (let i = 0; i < deps.length; i++) {
        if (deps[i] !== cachedDeps[i]) { same = false; break; }
      }
      if (same) return cachedResult;
    }
    cachedDeps = deps;
    cachedResult = compute(deps);
    return cachedResult;
  };
}

// Min/Max über `items`. `getValue` liefert Zahl oder null/NaN.
// Leere Menge → { min: 0, max: 0 } (konsistent mit den Heatmap-Callern).
export function minMaxBy(items, getValue) {
  let min = Infinity, max = -Infinity;
  for (const it of items) {
    const v = getValue(it);
    if (typeof v !== 'number' || !isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) return { min: 0, max: 0 };
  return { min, max };
}

// Heatmap-Zellfarbe: t∈[0,1], 0 → grün, 1 → rot.
// Liefert ein Style-Objekt mit CSS-Custom-Properties, das Alpine via
// `:style` anbindet. Die Farbberechnung selbst steht in style.css
// (`.heatmap-cell--tinted`), damit keine Inline-Style-Strings im DOM landen.
export function heatmapCellVars(t, opacity = 1) {
  const pct = Math.round(Math.max(0, Math.min(1, t)) * 100);
  return { '--heatmap-t': pct + '%', '--heatmap-opacity': String(opacity) };
}

export function fmtTok(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// Sterne-Render mit Halbschritt-Support. `gesamtnote` ist Dezimal (Schema:
// 1.0–6.0, Halbschritte erlaubt). Liefert HTML-Markup mit zwei übereinander
// liegenden Layern: Hintergrund = max ★ in Mute-Farbe, Vordergrund = max ★ in
// Akzentfarbe, Vordergrund-Width via Step-Klasse (`stars-rating--n-{N}`,
// N = 0..max*2 in halben Schritten). Identische Glyphen + identisches Layout
// auf beiden Layern → fontunabhängig, kein Tofu. Output ist konstantes Markup
// ohne User-Daten — direkt in x-html / Template-Literals einsetzbar.
export function renderStars(note, max = 6) {
  const n = Number(note);
  const safe = Number.isFinite(n) && n > 0 ? Math.min(max, n) : 0;
  const step = Math.round(safe * 2);
  const stars = '★'.repeat(max);
  return `<span class="stars-rating stars-rating--n-${step}" aria-hidden="true">`
    + `<span class="stars-rating__bg">${stars}</span>`
    + `<span class="stars-rating__fg">${stars}</span>`
    + `</span>`;
}

// Tooltip-Text für Sterne: exakter Wert auf 0.5 gerundet, "n / max".
// Null wenn keine numerische Note → :data-tip greift nicht.
export function noteTip(note, max = 6) {
  const n = Number(note);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(Math.min(max, n) * 2) / 2;
  return `${rounded.toFixed(1)} / ${max}`;
}

export function escHtml(s) {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// escHtml + Markdown-Fett-Marker entfernen. Lokale Modelle (v.a. ministral)
// streuen `**...**` inflationär in JSON-Felder; Rendern als <strong> wirkt
// überladen + Pairing bricht regelmässig. Darum nur strippen.
export function escMd(s) {
  return escHtml(String(s ?? '').replace(/\*\*/g, ''));
}

// Escapt alles außer <strong>…</strong> (BookStack-Search-Highlight).
// Verhindert XSS über preview_html, falls ein BookStack-User böswilligen
// HTML-Seitentitel/-Inhalt einschleust.
export function escPreserveStrong(s) {
  if (!s) return '';
  return escHtml(s)
    .replace(/&lt;strong&gt;/g, '<strong>')
    .replace(/&lt;\/strong&gt;/g, '</strong>');
}

export function htmlToText(html) {
  // DOMParser statt detached div: `div.innerHTML = …` triggert in allen
  // Browsern einen GET auf `<img src>`/Background-URLs (HTML-Parser-Pipeline
  // setzt Resource-Loads nicht aus). DOMParser('text/html') produziert ein
  // inert document ohne Resource-Requests.
  if (typeof DOMParser !== 'undefined') {
    try {
      const doc = new DOMParser().parseFromString(html || '', 'text/html');
      return doc.body?.textContent || '';
    } catch { /* fallback unten */ }
  }
  const d = document.createElement('template');
  d.innerHTML = html || '';
  return d.content?.textContent || '';
}

/**
 * Entfernt Fokus-Modus-Artefakte aus BookStack-HTML. Browser friert bei
 * contenteditable-Edits die computed `font-size` des Fokus-Containers als
 * inline `<span style="font-size:1.45rem">` ein; die Klasse
 * `focus-paragraph-active` ist eine rein interne UI-Markierung, die nie ins
 * persistierte HTML gehört. Idempotent – auch auf bereits sauberem HTML
 * sicher aufrufbar. Aufruf an allen Seams: nach dem Laden von BookStack und
 * vor dem Speichern an BookStack.
 */
export function stripFocusArtefacts(html) {
  if (!html) return html;
  // Trigger erweitern: leeres `class=""` entsteht, wenn classList.remove die
  // letzte Klasse wegnimmt — Attribut bleibt mit leerem Wert stehen. Ohne
  // diesen Branch erzeugt Focus-Mode-Aktiv-Markierung beim Save eine Revision,
  // obwohl semantisch nichts geändert wurde.
  if (
    !html.includes('focus-paragraph-active') &&
    !html.includes('hr-selected') &&
    !/font-size|background-color\s*:\s*transparent/i.test(html) &&
    !/\sclass\s*=\s*""/.test(html)
  ) {
    return html;
  }

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Transiente Editor-UI-Markierungen (Focus-Aktiv-Absatz, per Klick selektierte
  // <hr>) sind reine Laufzeit-Dekoration — nie persistieren, sonst falsch-dirty
  // im Vergleich + landen in der Revision.
  tmp.querySelectorAll('.focus-paragraph-active, .hr-selected').forEach(el => {
    el.classList.remove('focus-paragraph-active', 'hr-selected');
    if (el.classList.length === 0) el.removeAttribute('class');
  });

  tmp.querySelectorAll('[style]').forEach(el => {
    const cleaned = (el.getAttribute('style') || '')
      .split(';')
      .map(d => d.trim())
      .filter(d => {
        if (!d) return false;
        const key = d.split(':')[0].trim().toLowerCase();
        if (key === 'font-size') return false;
        if (key === 'background-color' && /transparent/i.test(d)) return false;
        return true;
      })
      .join('; ');
    if (cleaned) el.setAttribute('style', cleaned);
    else el.removeAttribute('style');
  });

  tmp.querySelectorAll('span').forEach(span => {
    if (span.attributes.length === 0) {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  // Verbleibende leere class=""-Attribute unabhängig von ihrer Herkunft entfernen.
  tmp.querySelectorAll('[class=""]').forEach(el => el.removeAttribute('class'));

  return tmp.innerHTML;
}

// Whitelist erlaubter Tags beim Paste. Alles ausserhalb wird zu Text reduziert
// (Tag-Hülle entfernt, Text-Inhalt bleibt). Tags spiegeln den Editor-Toolbar-
// Output (Notebook/Focus/Bucheditor schreiben dasselbe Markup).
const PASTE_ALLOWED_TAGS = new Set([
  'P', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'UL', 'OL', 'LI', 'HR', 'PRE',
  'STRONG', 'B', 'EM', 'I', 'U', 'S', 'STRIKE', 'CODE', 'MARK', 'SUB', 'SUP',
  'A', 'DIV',
]);
// Attribute, die pro Tag erhalten bleiben. Alles andere wird gestrippt
// (insbesondere on*-Handler, style, id, class, data-*).
const PASTE_ALLOWED_ATTRS = {
  A: new Set(['href']),
  DIV: new Set(['class']), // nur .poem (siehe Filter unten)
};

/**
 * Sanitisiert Clipboard-HTML auf eine im Editor unterstützte Form. Wird vor
 * `document.execCommand('insertHTML', …)` aufgerufen. Parsing via DOMParser
 * statt innerHTML — Subtree hängt nie im Live-DOM, on*-Handler werden vor
 * Insert gestrippt.
 *
 * - Whitelist-Tags bleiben (Inhalt wandert mit), unbekannte Tags werden
 *   unwrapped (Text bleibt, Hülle weg).
 * - Skripte/Styles/Metadaten + ihre Subtrees fliegen komplett raus.
 * - `<div>` bleibt nur als `<div class="poem">`, sonst unwrapped.
 * - Alle Attribute weg, ausser denen in `PASTE_ALLOWED_ATTRS`.
 * - Anschliessend durch `cleanContentArtefacts` für inline-style-Reste.
 */
export function sanitizePasteHtml(html) {
  if (!html) return '';
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return '';

  root.querySelectorAll('script, style, meta, link, title, iframe, object, embed, noscript')
    .forEach(el => el.remove());

  let guard = 32;
  let changed = true;
  while (changed && guard-- > 0) {
    changed = false;
    const all = Array.from(root.querySelectorAll('*'));
    for (const el of all) {
      const tag = el.tagName;
      if (tag === 'DIV' && !(el.getAttribute('class') || '').split(/\s+/).includes('poem')) {
        _unwrap(el);
        changed = true;
        continue;
      }
      if (!PASTE_ALLOWED_TAGS.has(tag)) {
        _unwrap(el);
        changed = true;
        continue;
      }
      const allowedAttrs = PASTE_ALLOWED_ATTRS[tag] || null;
      for (const attr of Array.from(el.attributes)) {
        if (!allowedAttrs || !allowedAttrs.has(attr.name)) el.removeAttribute(attr.name);
      }
      if (tag === 'DIV') el.setAttribute('class', 'poem');
      if (tag === 'A' && !el.getAttribute('href')) {
        _unwrap(el);
        changed = true;
      }
    }
  }

  return cleanContentArtefacts(root.innerHTML);
}

function _unwrap(el) {
  const parent = el.parentNode;
  if (!parent) return;
  while (el.firstChild) parent.insertBefore(el.firstChild, el);
  parent.removeChild(el);
}

// Tags, auf denen `style` IMMER unerwünscht ist (Block-Styling kommt über
// .poem/.callout/style.css; der Editor selbst setzt nie inline-style).
// Strukturelemente wie img/table/td/col/figure/iframe bleiben unangetastet,
// dort sind Width-/Height-Angaben legitim.
const STRIP_STYLE_TAGS = new Set([
  'P', 'SPAN', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'UL', 'OL', 'BLOCKQUOTE', 'A', 'B', 'I', 'STRONG', 'EM',
  'BR', 'PRE', 'CODE', 'SMALL', 'MARK', 'U', 'S', 'SUB', 'SUP',
]);

/**
 * Säubert HTML von Inline-Style-Müll, leeren Spans und Paste-Wrapper-Tags.
 *
 * Chrome friert beim Tippen oder Pasten in `contenteditable` die Computed-
 * Styles auf jedem Block ein (z.B. `<p style="margin:0.4em 0px;color:rgb(...);
 * font-family:Lato,...">`). Werden diese Inline-Styles mitgespeichert,
 * überschreiben sie beim Rendern die echten Block-Styles (`.poem` &Co)
 * und das Resultat sieht kaputt aus.
 *
 * Idempotent. Behält `style` auf img/table/td/col/figure/iframe.
 */
export function cleanContentArtefacts(html) {
  if (!html) return html;
  if (!/\sstyle\s*=|<(span|meta|link|script|style|title)\b/i.test(html)) return html;

  const tmp = document.createElement('div');
  tmp.innerHTML = html;

  // Paste-Wrapper aus Browser/Office (komplett raus, samt Inhalt)
  tmp.querySelectorAll('meta, link, script, style, title').forEach(el => el.remove());

  tmp.querySelectorAll('[style]').forEach(el => {
    if (STRIP_STYLE_TAGS.has(el.tagName)) el.removeAttribute('style');
  });

  // Leere Spans aus Paste-/Selection-Operationen entkernen
  tmp.querySelectorAll('span').forEach(span => {
    if (span.attributes.length === 0) {
      const parent = span.parentNode;
      if (!parent) return;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
    }
  });

  return tmp.innerHTML;
}

// Elemente mit eigenem "visuellen" Inhalt (dürfen leer wirken, bleiben erhalten).
const _STRUCTURAL_LEAF = 'img,iframe,video,audio,table,figure,hr,object,embed,canvas,svg,input,button';

function _isBlankTrailing(node) {
  if (!node) return false;
  if (node.nodeType === 3) return !node.textContent.replace(/\u00A0/g, ' ').trim();
  if (node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag !== 'P' && tag !== 'DIV' && tag !== 'BR') return false;
  if (tag === 'BR') return true;
  if ((node.textContent || '').replace(/\u00A0/g, ' ').trim()) return false;
  if (node.querySelector(_STRUCTURAL_LEAF)) return false;
  return true;
}

/**
 * Reduziert Runs aufeinanderfolgender Leerblöcke (`<p></p>`, `<p><br></p>`,
 * `<p>&nbsp;</p>`, top-level `<br>`) auf je einen Block und Runs von `<br>`
 * innerhalb von Inline-Kontext (z.B. `<p>foo<br><br>bar</p>`) auf ein einzelnes
 * `<br>`. Ein einzelner Leerblock bleibt als bewusste Absatz-Trennung erhalten.
 * Idempotent. Nutzt DOMParser, keine Script-Side-Effects.
 */
export function collapseEmptyBlocks(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;

  // Top-Level: Run von Leerblöcken → erster Block bleibt, Rest weg.
  let node = root.firstChild;
  while (node) {
    const next = node.nextSibling;
    if (_isBlankTrailing(node)) {
      let probe = next;
      while (probe) {
        const probeNext = probe.nextSibling;
        if (probe.nodeType === 3 && !probe.textContent.replace(/ /g, ' ').trim()) {
          probe.remove();
          probe = probeNext;
          continue;
        }
        if (_isBlankTrailing(probe)) {
          probe.remove();
          probe = probeNext;
          continue;
        }
        break;
      }
    }
    node = next;
  }

  // Inline: aufeinanderfolgende `<br>` (auch durch Whitespace getrennt) → ein `<br>`.
  root.querySelectorAll('br').forEach(br => {
    let s = br.nextSibling;
    while (s) {
      const sn = s.nextSibling;
      if (s.nodeType === 3 && !s.textContent.replace(/ /g, ' ').trim()) {
        s.remove();
        s = sn;
        continue;
      }
      if (s.nodeType === 1 && s.tagName === 'BR') {
        s.remove();
        s = sn;
        continue;
      }
      break;
    }
  });

  return root.innerHTML;
}

/**
 * Entfernt leere Absätze am Ende des HTML. contenteditable hängt beim Tippen
 * oft `<p><br></p>`/`<p>&nbsp;</p>` an; ohne Strip wachsen beim jedem Save
 * weitere Leerabsätze hinten ans BookStack-HTML. Idempotent, Top-Level only.
 * Nutzt DOMParser statt innerHTML-Assign, um keine Script-Side-Effects auszulösen.
 */
export function stripTrailingEmptyBlocks(html) {
  if (!html) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;
  let last = root.lastChild;
  while (last && _isBlankTrailing(last)) {
    const prev = last.previousSibling;
    root.removeChild(last);
    last = prev;
  }
  return root.innerHTML;
}

// Dekodiert eine einzelne HTML-Entity (z.B. &bdquo;) via Browser-Parser.
// Gibt null zurück, wenn sich die Entity nicht auflöst.
const _entityDecoder = typeof document !== 'undefined' ? document.createElement('textarea') : null;
function _decodeHtmlEntity(entity) {
  if (!_entityDecoder) return null;
  _entityDecoder.innerHTML = entity;
  const decoded = _entityDecoder.value;
  return decoded === entity ? null : decoded;
}

/**
 * Baut eine Text-View von `html` mit Positions-Map zurück ins Original-HTML.
 * - Tags werden entfernt; Tag-Grenzen wirken wie Whitespace.
 * - Aufeinanderfolgender Whitespace wird auf einzelne Spaces kollabiert.
 * - Entities werden via Browser-Parser dekodiert.
 * - Pro Text-Zeichen `text[i]` gilt: es stammt aus dem HTML-Bereich [starts[i], ends[i]).
 */
function _buildHtmlTextMap(html) {
  const chars = [];
  const starts = [];
  const ends = [];
  let pendingSpace = false;
  let emittedNonSpace = false;
  let i = 0;

  const markSpace = () => { if (emittedNonSpace) pendingSpace = true; };

  const pushChar = (ch, start, end) => {
    if (pendingSpace) {
      chars.push(' ');
      starts.push(start);
      ends.push(start);
      pendingSpace = false;
    }
    chars.push(ch);
    starts.push(start);
    ends.push(end);
    emittedNonSpace = true;
  };

  while (i < html.length) {
    const c = html[i];
    if (c === '<') {
      const gt = html.indexOf('>', i);
      if (gt === -1) break;
      markSpace();
      i = gt + 1;
      continue;
    }
    if (c === '&') {
      const semi = html.indexOf(';', i);
      if (semi !== -1 && semi - i <= 10) {
        const entity = html.slice(i, semi + 1);
        const decoded = _decodeHtmlEntity(entity);
        if (decoded != null) {
          for (const dc of decoded) {
            if (/\s/.test(dc)) markSpace();
            else pushChar(dc, i, semi + 1);
          }
          i = semi + 1;
          continue;
        }
      }
    }
    if (/\s/.test(c)) {
      markSpace();
      i++;
      continue;
    }
    pushChar(c, i, i + 1);
    i++;
  }
  return { text: chars.join(''), starts, ends };
}

/**
 * Sucht `needle` in `html`. Exakter Substring-Match hat Vorrang; sonst
 * toleranter Match über die Text-View (Tags ignorieren, Entities dekodieren,
 * Whitespace kollabieren). Gibt { htmlStart, htmlEnd } zurück oder null.
 *
 * Typischer Fall: Chat-/Lektorat-KI sieht die Seite als Plaintext und
 * liefert `Er sagte das magische Wort.`, im HTML steht aber
 * `Er sagte <em>das magische</em> Wort.`. Der Tolerant-Match findet die
 * Stelle trotzdem; die `<em>`-Tags fallen beim Ersatz weg, was akzeptabel
 * ist, weil die KI ohnehin eine neue Formulierung vorschlägt.
 */
export function findInHtml(html, needle) {
  if (!html || !needle) return null;
  const exact = html.indexOf(needle);
  if (exact !== -1) return { htmlStart: exact, htmlEnd: exact + needle.length };

  const normalized = needle.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const { text, starts, ends } = _buildHtmlTextMap(html);
  const idx = text.indexOf(normalized);
  if (idx === -1) return null;
  return { htmlStart: starts[idx], htmlEnd: ends[idx + normalized.length - 1] };
}

const _VOID_TAGS = new Set([
  'area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr',
]);

// Inline-Elemente, ueber die eine Ersetzung gefahrlos hinweggehen darf — ihre
// Tag-Balance haelt der Orphan-Schutz in `_splitOrphanTags`. Alles andere
// (p, li, h1-h6, blockquote, pre, table-Teile, div, figure …) ist eine
// Block-Grenze: ein Match, der sie kreuzt, wuerde beim Ersetzen Absatzstruktur
// zerreissen (verschachtelte/aufgespaltene Bloecke). Default-Deny: unbekannte
// Tags gelten als Block-Grenze, damit nichts stillschweigend korrumpiert.
const _INLINE_TAGS = new Set([
  'a','abbr','b','bdi','bdo','br','cite','code','data','dfn','em','i','kbd',
  'mark','q','rp','rt','ruby','s','samp','small','span','strong','sub','sup',
  'time','u','var','wbr',
]);

// True, wenn der Slice ein Nicht-Inline-Tag (Block-Grenze) enthaelt.
function _crossesBlockBoundary(slice) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let m;
  while ((m = tagRe.exec(slice))) {
    if (!_INLINE_TAGS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

/**
 * Findet im Slice Tags ohne Partner: Closes ohne vorheriges Open im Slice
 * (Open liegt VOR dem Slice, Tag muss nach dem Replacement erhalten bleiben),
 * bzw. Opens ohne nachfolgendes Close im Slice (Close liegt NACH dem Slice).
 * Self-closing/Void-Elemente werden ignoriert.
 */
function _splitOrphanTags(slice) {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  const stack = [];
  const orphanCloses = [];
  let m;
  while ((m = tagRe.exec(slice))) {
    const full = m[0];
    const tag = m[1].toLowerCase();
    if (_VOID_TAGS.has(tag) || /\/>$/.test(full)) continue;
    if (full.startsWith('</')) {
      if (stack.length && stack[stack.length - 1].tag === tag) stack.pop();
      else orphanCloses.push(full);
    } else {
      stack.push({ tag, full });
    }
  }
  return { orphanOpens: stack.map(s => s.full), orphanCloses };
}

/**
 * Ersetzt `needle` im HTML durch `replacement`. Nutzt `findInHtml` für die
 * Position. Wenn der Match nur Inline-Tag-Grenzen kreuzt (toleranter Match),
 * bleiben Waisen-Tags innerhalb der ersetzten Range erhalten, sonst zerbricht
 * die Tag-Balance (typisch: KI ändert Phrase, die ein `<em>kursiv</em>` umfasst,
 * dabei darf weder das öffnende noch das schliessende Tag verloren gehen).
 *
 * Kreuzt der Match dagegen eine BLOCK-Grenze (`</p><p>`, `</li><li>`, Heading,
 * Tabelle …), wird NICHT ersetzt — eine solche Ersetzung würde verschachtelte
 * oder aufgespaltene Blöcke erzeugen und damit Absätze zerstören. Die Korrektur
 * wird dann stillschweigend übersprungen (Text bleibt unverändert) statt die
 * Struktur zu beschädigen.
 *
 * Gibt das neue HTML zurück, oder das Original wenn nichts gefunden bzw. der
 * Match eine Block-Grenze kreuzt.
 */
export function replaceInHtml(html, needle, replacement) {
  if (!html || !needle) return html;
  const m = findInHtml(html, needle);
  if (!m) return html;
  const removed = html.slice(m.htmlStart, m.htmlEnd);
  let inserted = replacement;
  if (removed.includes('<')) {
    if (_crossesBlockBoundary(removed)) return html;
    const { orphanOpens, orphanCloses } = _splitOrphanTags(removed);
    if (orphanOpens.length || orphanCloses.length) {
      inserted = orphanOpens.join('') + replacement + orphanCloses.join('');
    }
  }
  return html.slice(0, m.htmlStart) + inserted + html.slice(m.htmlEnd);
}

/**
 * Display-Pass: Markiert Slack-Style `@mentions` (User-Handles) und `#channels`
 * im View-Modus als Chips. Pure HTML-String-Transform, nicht persistent —
 * läuft auf `renderedPageHtml`, niemals auf `originalHtml`. Überspringt Text
 * in `<a>`, `<pre>`, `<code>` und bereits dekorierten Spans (idempotent).
 *
 * `@name`: 2+ Wortzeichen, beginnt mit Buchstabe.
 * `#tag`:  2+ Wortzeichen, beginnt mit Buchstabe oder Ziffer; Bindestrich erlaubt
 *           (matcht `#1-vbs`, `#dot-sync`).
 * Boundary: vorheriges Zeichen darf kein Wortzeichen oder `/` sein.
 */
const _MENTION_SKIP_ANCESTOR = new Set(['A', 'PRE', 'CODE']);
const _CHIP_RE = /(^|[^\w/&])([@#])([A-Za-z0-9][\w-]{1,})/g;

export function decorateMentions(html) {
  if (!html || (!html.includes('@') && !html.includes('#'))) return html;
  const doc = new DOMParser().parseFromString('<div id="r">' + html + '</div>', 'text/html');
  const root = doc.getElementById('r');
  if (!root) return html;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  let n = walker.nextNode();
  while (n) {
    if (!_mentionAncestorSkip(n) && /[@#]/.test(n.textContent)) texts.push(n);
    n = walker.nextNode();
  }
  for (const textNode of texts) {
    const text = textNode.textContent;
    const matches = [...text.matchAll(_CHIP_RE)];
    if (matches.length === 0) continue;
    const frag = doc.createDocumentFragment();
    let last = 0;
    for (const m of matches) {
      const pre = m[1];
      const sigil = m[2];
      const word = m[3];
      const start = m.index + pre.length;
      const end = start + 1 + word.length;
      if (start > last) frag.appendChild(doc.createTextNode(text.slice(last, start)));
      const span = doc.createElement('span');
      span.className = sigil === '@' ? 'mention' : 'channel';
      span.textContent = sigil + word;
      frag.appendChild(span);
      last = end;
    }
    if (last < text.length) frag.appendChild(doc.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  }
  return root.innerHTML;
}

function _mentionAncestorSkip(node) {
  let p = node.parentNode;
  while (p && p.nodeType === 1) {
    if (_MENTION_SKIP_ANCESTOR.has(p.tagName)) return true;
    const cls = p.getAttribute && p.getAttribute('class');
    if (cls && /\b(mention|channel)\b/.test(cls)) return true;
    p = p.parentNode;
  }
  return false;
}

// Erkennt eine Listenzeile (geordnet «1. » oder ungeordnet «- »/«* ») inkl.
// führender Einrückung (Spaces/Tabs). Gruppe 1 = Indent, 2 = Marker, 3 = Text.
const _CHAT_LIST_RE = /^([ \t]*)([-*]|\d+\.)[ ]+(.*)$/;

// Baut aus aufeinanderfolgenden Listenzeilen verschachtelte <ul>/<ol> anhand
// der Einrückungstiefe. Tabs zählen als 4 Spaces. Pure Funktion (kein DOM).
function _buildNestedList(blockLines) {
  const items = [];
  for (const l of blockLines) {
    const m = l.match(_CHAT_LIST_RE);
    if (!m) continue;
    items.push({
      indent: m[1].replace(/\t/g, '    ').length,
      ordered: /\d/.test(m[2]),
      text: m[3],
    });
  }
  const open = (ord) => ord ? '<ol class="chat-list chat-list--ol">' : '<ul class="chat-list">';
  const close = (ord) => ord ? '</ol>' : '</ul>';
  const stack = [];
  let out = '';
  for (const it of items) {
    const top = stack[stack.length - 1];
    if (!top || it.indent > top.indent) {
      stack.push(it);
      out += open(it.ordered) + '<li>' + it.text;
    } else if (it.indent === top.indent) {
      out += '</li><li>' + it.text;
    } else {
      while (stack.length > 1 && it.indent < stack[stack.length - 1].indent) {
        out += '</li>' + close(stack.pop().ordered);
      }
      out += '</li><li>' + it.text;
    }
  }
  while (stack.length) out += '</li>' + close(stack.pop().ordered);
  return out;
}

// Ersetzt zusammenhängende Listenblöcke im Text durch ihr verschachteltes
// HTML; alle übrigen Zeilen bleiben unangetastet. Eine einzelne Leerzeile
// zwischen Items hält die Liste zusammen.
function _renderChatLists(html) {
  const lines = html.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (!_CHAT_LIST_RE.test(lines[i])) { out.push(lines[i]); i++; continue; }
    const block = [];
    while (i < lines.length) {
      if (_CHAT_LIST_RE.test(lines[i])) { block.push(lines[i]); i++; continue; }
      if (lines[i].trim() === '' && _CHAT_LIST_RE.test(lines[i + 1] || '')) { i++; continue; }
      break;
    }
    out.push(_buildNestedList(block));
  }
  return out.join('\n');
}

/**
 * Einfaches Markdown → HTML für Chat-Antworten.
 * Unterstützt: # Überschriften, **fett**, *kursiv*, `code`, ```Code-Blöcke```,
 * [Links](url), Blockquotes (>), Tabellen, Zeilenumbrüche, verschachtelte Listen (- und 1.).
 */
export function renderChatMarkdown(text) {
  if (!text) return '';
  let html = escHtml(text);

  // Fenced Code-Blöcke ```…``` vorab extrahieren und durch Platzhalter ersetzen,
  // damit weder Listen-/Inline-Regex noch \n→<br> ihren Inhalt anfassen. Inhalt
  // ist durch escHtml bereits sicher; \n bleiben für die <pre>-Anzeige erhalten.
  // Platzhalter-Delimiter ist U+E000 (Private-Use-Area): kommt in echtem
  // Chat-/Markdown-Text nicht vor (kollisionsfrei) und ist — anders als das
  // früher genutzte NUL — druckbares UTF-8, sodass die Datei text-/grep-bar
  // bleibt. Restore weiter unten muss denselben Delimiter matchen.
  const codeBlocks = [];
  html = html.replace(/```[^\n]*\n([\s\S]*?)```/g, (_m, body) => {
    codeBlocks.push('<pre class="chat-pre"><code>' + body.replace(/\n+$/, '') + '</code></pre>');
    return 'CB' + (codeBlocks.length - 1) + '';
  });

  // Überschriften: ### ## #
  html = html.replace(/^### (.+)$/gm, '<h4 class="chat-heading chat-heading--3">$1</h4>');
  html = html.replace(/^## (.+)$/gm,  '<h3 class="chat-heading chat-heading--2">$1</h3>');
  html = html.replace(/^# (.+)$/gm,   '<h2 class="chat-heading chat-heading--1">$1</h2>');

  // Horizontale Linie
  html = html.replace(/^---$/gm, '<hr class="chat-hr">');

  // Markdown-Tabellen: Block aus Zeilen die mit | beginnen
  html = html.replace(/((?:\|[^\n]+\n)+)/g, (block) => {
    const lines = block.trimEnd().split('\n');
    if (lines.length < 3) return block;
    if (!/^\|[\s\-:|]+\|$/.test(lines[1])) return block;
    const headers = lines[0].split('|').slice(1, -1).map(h => h.trim());
    const rows = lines.slice(2).map(row => row.split('|').slice(1, -1).map(c => c.trim()));
    const thead = `<tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>`;
    const tbody = rows.map(row => `<tr>${row.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
    return `<div class="table-scroll"><table class="chat-table"><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
  });

  // Listen (geordnet + ungeordnet, mit Verschachtelung via Einrückung)
  html = _renderChatLists(html);

  // Blockquote: Zeilen mit «> » (nach escHtml «&gt; ») → temporäres <bq>-Tag,
  // aufeinanderfolgende Zeilen werden zu einem <blockquote> gruppiert.
  html = html.replace(/^&gt; ?(.*)$/gm, '<bq>$1</bq>');
  html = html.replace(/(?:<bq>[\s\S]*?<\/bq>\n?)+/g, m =>
    '<blockquote class="chat-quote">' +
    m.replace(/<bq>/g, '').replace(/<\/bq>\n?/g, '\n').trimEnd() +
    '</blockquote>');

  // Inline: [Text](url) — nur http(s)/mailto, sonst Klartext belassen (XSS-Schutz).
  // url ist durch escHtml bereits attribut-sicher (" → &quot; etc.).
  html = html.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    /^(https?:|mailto:)/i.test(url)
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${label}</a>`
      : m);

  // Inline: **fett**
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline: *kursiv*
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Inline: `code`
  html = html.replace(/`([^`]+)`/g, '<code class="chat-code">$1</code>');

  // Leerzeile → <br><br> (direkt, ohne weitere \n die nochmals zu <br> werden)
  html = html.replace(/\n\n+/g, '<br><br>');
  // Einfacher Zeilenumbruch → <br>
  html = html.replace(/\n/g, '<br>');

  // Fenced Code-Blöcke zurückspielen (Inhalt war über Platzhalter geschützt)
  html = html.replace(/CB(\d+)/g, (_m, i) => codeBlocks[Number(i)] || '');

  // Überschüssige <br> direkt vor/nach Block-Elementen entfernen
  html = html.replace(/(<br>\s*)+(<(?:ol|ul|h[2-4]|hr|blockquote|pre)\b)/gi, '$2');
  html = html.replace(/(\/(?:ol|ul|h[2-4]|blockquote|pre)>|<hr[^>]*>)(\s*<br>)+/gi, '$1');

  return html;
}
