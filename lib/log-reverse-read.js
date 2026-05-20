'use strict';
// Reverse-Chunk-Reader fuer rueckwaerts-Pagination durch Log-Files.
// Liest 64-KB-Chunks vom File-Ende, splittet an '\n' und yieldet Zeilen
// von neu nach alt. Mehr-File-Ketten (.log, .log1, .log2, ...) werden in
// Reihenfolge durchlaufen — current zuerst, dann rotated.

const fs = require('node:fs');
const path = require('node:path');

const CHUNK = 64 * 1024;

// Liest File rueckwaerts und yieldet Zeilen (ohne '\n'), von neu nach alt.
async function* readLinesReverse(filePath) {
  let fd;
  try { fd = await fs.promises.open(filePath, 'r'); }
  catch { return; }
  try {
    const stat = await fd.stat();
    let pos = stat.size;
    let trailing = '';
    let first = true;
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      const buf = Buffer.alloc(len);
      pos -= len;
      await fd.read(buf, 0, len, pos);
      const chunk = buf.toString('utf8') + trailing;
      const lines = chunk.split('\n');
      trailing = lines.shift() || '';
      // Trailing newline am File-Ende erzeugt im ersten Chunk eine leere
      // Schluss-Zeile — verwerfen.
      if (first && lines.length && lines[lines.length - 1] === '') lines.pop();
      first = false;
      for (let i = lines.length - 1; i >= 0; i--) yield lines[i];
    }
    if (trailing) yield trailing;
  } finally {
    try { await fd.close(); } catch {}
  }
}

// Auflistung rotierter Log-Files. winston haengt Suffixe als File1/File2/...
// an den Basisnamen vor der Extension an: schreibwerkstatt.log,
// schreibwerkstatt1.log, schreibwerkstatt2.log, ...
function listRotatedFiles(basePath, maxFiles = 4) {
  const dir = path.dirname(basePath);
  const ext = path.extname(basePath);
  const stem = path.basename(basePath, ext);
  const out = [];
  if (fs.existsSync(basePath)) out.push(basePath);
  for (let i = 1; i < maxFiles; i++) {
    const candidate = path.join(dir, `${stem}${i}${ext}`);
    if (fs.existsSync(candidate)) out.push(candidate);
  }
  return out;
}

module.exports = { readLinesReverse, listRotatedFiles };
