#!/usr/bin/env node
'use strict';
// PreToolUse-Hook (Agent|EnterWorktree|Bash): entwickelt wird ausschliesslich auf
// main. Blockt jeden Weg, auf dem eine Session einen Branch oder Worktree anlegt:
//   • Agent mit isolation: "worktree"  → jeder Subagent bekaeme einen eigenen
//     worktree-agent-*-Branch, der nach dem Aufraeumen des Worktrees liegen bleibt
//   • EnterWorktree
//   • Bash: git checkout -b/-B, git switch -c/-C/--create, git worktree add,
//     git branch <name> (Anlegen; -d/-D/-a/--list usw. beginnen mit '-' und bleiben frei)
// Block via Exit 2 + stderr. Die Regel steht in CLAUDE.md unter „Arbeitsweise".

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }
  const tool = payload.tool_name || '';
  const ti = payload.tool_input || {};

  let reason = null;
  if (tool === 'Agent' && ti.isolation === 'worktree') {
    reason = 'Subagent mit isolation: "worktree" — ohne isolation starten, der Agent arbeitet direkt auf main.';
  } else if (tool === 'EnterWorktree') {
    reason = 'EnterWorktree — hier wird nur auf main gearbeitet, kein Worktree.';
  } else if (tool === 'Bash' && typeof ti.command === 'string') {
    // Befehle an ; && || | und Zeilenumbruechen trennen, jeden Teil einzeln pruefen.
    // `git` muss am Anfang des Teils stehen — sonst schluege eine Commit-Message an,
    // die „git branch foo" nur erwaehnt.
    for (const part of ti.command.split(/;|&&|\|\||\||\n/)) {
      const m = part.match(/^\s*(?:\w+=\S*\s+)*git\s+(?:-C\s+\S+\s+|-c\s+\S+\s+)*(checkout|switch|worktree|branch)\b(.*)$/);
      if (!m) continue;
      const [, sub, rest] = m;
      const args = rest.trim();
      if ((sub === 'checkout' && /(?:^|\s)-[bB]\b/.test(args))
        || (sub === 'switch' && /(?:^|\s)(?:-[cC]\b|--create\b|--force-create\b)/.test(args))
        || (sub === 'worktree' && /^add\b/.test(args))
        || (sub === 'branch' && /^[^-\s]/.test(args))) {
        reason = `\`git ${sub} ${args}\` legt einen Branch/Worktree an — hier wird nur auf main committet.`;
        break;
      }
    }
  }

  if (reason) {
    process.stderr.write('[main-only-guard] blockiert: ' + reason +
      '\nRegel: in diesem Repo wird ausschliesslich auf main entwickelt (CLAUDE.md, „Arbeitsweise").\n');
    process.exit(2);
  }
  process.exit(0);
});
