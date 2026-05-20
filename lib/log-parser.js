'use strict';
// Streaming-Parser fuer das winston-File-Format aus logger.js:
//   YYYY-MM-DD HH:MM:SS [LEVEL] [scope|user|book|jobId] message
//   <optional unindented stack-trace lines until next timestamped line>
//
// Stack-Traces sind Folgezeilen ohne Timestamp und gehoeren zur vorigen Zeile.
// Malformed Lines werden uebersprungen, kein Throw.

const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[([A-Z]+)\] \[([^|]+)\|([^|]+)\|([^|\]]+)(?:\|([^\]]+))?\] (.*)$/;

function _parseHeader(line) {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [, ts, level, scope, user, book, jobId, msg] = m;
  return {
    ts,
    level: level.toLowerCase(),
    scope,
    user: user === '-' ? null : user,
    book: book === '-' ? null : book,
    jobId: jobId || null,
    msg,
    stack: null,
  };
}

// Generator: nimmt eine Iterable von Zeilen (ohne newline) und liefert
// geparste Eintraege. Stack-Trace-Append: nicht-matchende Zeilen werden an
// die zuletzt emittierte Header-Zeile gehaengt.
function* parseLines(lines) {
  let pending = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    const header = _parseHeader(line);
    if (header) {
      if (pending) yield pending;
      pending = header;
      continue;
    }
    if (line.trim() === '') {
      if (pending && pending.stack) pending.stack.push(line);
      continue;
    }
    if (pending) {
      if (!pending.stack) pending.stack = [];
      pending.stack.push(line);
    }
  }
  if (pending) yield pending;
}

function parseBuffer(text) {
  return [...parseLines(text.split('\n'))];
}

module.exports = { parseLines, parseBuffer, _parseHeader };
