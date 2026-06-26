'use strict';
// Liest das "latest"-GitHub-Release des oeffentlichen Client-Repos
// (bedeberger/schreibwerkstatt-focuseditor), damit die Web-App in /me Version +
// Download-Link der nativen macOS-App (Focus-Writer) anzeigen kann. Das .dmg
// liegt NICHT im Repo, sondern als Release-Asset auf dem GitHub-CDN — die UI
// verlinkt direkt darauf (kein Download-Proxy).
//
// Generischer Fetcher + Cache: [lib/github-release.js](./github-release.js).

const { createReleaseFetcher } = require('./github-release');

module.exports = createReleaseFetcher({
  repo: 'bedeberger/schreibwerkstatt-focuseditor',
  assetExt: '.dmg',
  assetKey: 'dmg',
  logName: 'macclient-release',
});
