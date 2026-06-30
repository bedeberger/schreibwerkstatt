---
description: Versionsnummer erhöhen + Git-Tag + GitHub-Release erstellen
argument-hint: "[patch|minor|major|x.y.z]  (Default: patch)"
allowed-tools: Bash(cat:*), Bash(git:*), Bash(gh:*), Bash(npm run version:sync), Read
---

Du führst einen Release der App durch. SSoT der Version ist die Datei `VERSION` im Projektroot; `package.json#version` folgt via `npm run version:sync`.

Bump-Argument: `$ARGUMENTS` (leer = `patch`).

## Vorprüfung

1. `git status --porcelain` lesen. Es darf **kein** uncommitteter Stand an `VERSION` oder `package.json` vorliegen. Andere uncommittete Änderungen sind erlaubt, werden aber **nicht** mit-committet — der Release-Commit enthält ausschliesslich `VERSION` + `package.json`.
2. Aktuelle Version aus `VERSION` lesen.
3. Neue Version berechnen:
   - `patch` → letzte Stelle +1 (1.2.3 → 1.2.4)
   - `minor` → mittlere +1, Patch auf 0 (1.2.3 → 1.3.0)
   - `major` → erste +1, Rest auf 0 (1.2.3 → 2.0.0)
   - Explizites `x.y.z` → genau dieser Wert (Semver-Format validieren).
4. Sicherstellen, dass der Tag `v<neueVersion>` noch nicht existiert (`git tag -l`). Falls doch: abbrechen und melden.

## Durchführung

5. Neue Version in `VERSION` schreiben (nur die Zahl + Newline).
6. `npm run version:sync` ausführen (schreibt `package.json#version`).
7. **Nur** die beiden Dateien stagen: `git add VERSION package.json`.
8. Committen mit Message `release: v<neueVersion>`. Commit-Trailer wie üblich (`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`).
9. Annotated Tag setzen: `git tag -a v<neueVersion> -m "v<neueVersion>"`.
10. Pushen: `git push origin HEAD` und `git push origin v<neueVersion>`.
11. GitHub-Release erstellen:
    `gh release create v<neueVersion> --title "v<neueVersion>" --generate-notes`
    (Bei existierenden Vorgänger-Tags generiert `--generate-notes` automatisch die Changelog-Notizen seit dem letzten Tag.)

## Abschluss

Melde knapp: alte → neue Version, Commit-Hash, Tag, und die URL des erstellten GitHub-Releases.

Bei jedem Fehlschlag eines Schritts **stoppen** und den Stand berichten (insb. wenn der Push fehlschlägt, vor dem Release-Create abbrechen — kein Release ohne gepushten Tag).
