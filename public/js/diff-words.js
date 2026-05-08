// Word-Level-Diff für Lektorat-Findings (Original vs. Korrektur als Inline-Redline).
//
// Ausgabe-Pattern: Liste von Segmenten { type: 'eq' | 'del' | 'ins', text }.
// Whitespace bleibt als eigene Tokens erhalten, damit Re-Assembly die
// Original-Spacings respektiert.
//
// Komplexität O(n*m); Lektorat-Strings sind kurz (< 50 Wörter), daher
// völlig ausreichend ohne Myers-Optimierung.

function tokenize(str) {
  return String(str || '').match(/\s+|\S+/g) || [];
}

function lcsMatrix(a, b) {
  const m = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      m[i + 1][j + 1] = a[i] === b[j] ? m[i][j] + 1 : Math.max(m[i + 1][j], m[i][j + 1]);
    }
  }
  return m;
}

export function wordDiff(oldStr, newStr) {
  const a = tokenize(oldStr);
  const b = tokenize(newStr);
  if (!a.length && !b.length) return [];
  const m = lcsMatrix(a, b);
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: 'eq', text: a[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || m[i][j - 1] >= m[i - 1][j])) {
      ops.push({ type: 'ins', text: b[j - 1] });
      j--;
    } else {
      ops.push({ type: 'del', text: a[i - 1] });
      i--;
    }
  }
  ops.reverse();
  // Adjazente gleichartige Segmente verschmelzen, damit Markup kompakt bleibt.
  const out = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.text += op.text;
    else out.push({ type: op.type, text: op.text });
  }
  return out;
}

// Convenience für Findings: leeres korrektur → kein Diff, sondern reine
// del-Anzeige des Originals (nutzt im Template den Single-Box-Pfad).
export function findingDiff(finding) {
  if (!finding || !finding.original) return [];
  if (!finding.korrektur) return [{ type: 'del', text: finding.original }];
  return wordDiff(finding.original, finding.korrektur);
}
