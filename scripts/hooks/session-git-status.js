#!/usr/bin/env node
'use strict';
// SessionStart-Hook: schreibt Branch + Working-Tree-Status in den Session-Kontext,
// damit Claude vor Arbeitsbeginn sieht, was schon uncommittet im Baum liegt.
// Grund: eine Auto-Commit-Automatik kann den ganzen Working Tree als „vom User
// authored" buendeln — fremde/uncommittete Arbeit soll nicht versehentlich in
// einen eigenen Commit geraten. Bei sauberem Tree: knappe Ein-Zeilen-Meldung.

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const git = (args) => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });

const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim() || '?';
const status = git(['status', '--porcelain']);
const lines = (status.stdout || '').trim();

let context;
if (!lines) {
  context = `[git] Branch ${branch}, Working Tree sauber.`;
} else {
  const n = lines.split('\n').length;
  context =
    `[git] Branch ${branch} — ${n} uncommittete Aenderung(en) beim Session-Start:\n` +
    lines + '\n' +
    'Achtung: nicht alles davon stammt zwingend von dieser Session (Auto-Commit-Automatik ' +
    'buendelt den ganzen Tree). Vor eigenen Commits pruefen, was wirklich zu deiner Arbeit gehoert.';
}

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: context,
  },
}));
process.exit(0);
