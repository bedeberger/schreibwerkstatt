'use strict';
// Liest das "latest"-GitHub-Release des oeffentlichen Android-Repos
// (bedeberger/schreibwerkstatt-mobile), damit die Web-App in /me Version +
// Download-Link der nativen Android-App anzeigen kann. Das .apk liegt NICHT im
// Repo, sondern als Release-Asset auf dem GitHub-CDN — die UI verlinkt direkt
// darauf (kein Download-Proxy, Sideload).
//
// Generischer Fetcher + Cache: [lib/github-release.js](./github-release.js).

const { createReleaseFetcher } = require('./github-release');

module.exports = createReleaseFetcher({
  repo: 'bedeberger/schreibwerkstatt-mobile',
  assetExt: '.apk',
  assetKey: 'apk',
  logName: 'androidclient-release',
});
