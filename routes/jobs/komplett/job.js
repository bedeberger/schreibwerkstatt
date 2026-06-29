'use strict';
// Komplettanalyse-Jobs — Facade. Aufgeteilt nach Job-Typ:
//   job-komplett.js     — Kern-Pipeline (P1–P8) + Nacht-Cron (runKomplettAnalyseAll).
//   job-kontinuitaet.js — Standalone-Kontinuitätscheck (runKontinuitaetJob).
//   job-shared.js       — Verify-Stufe, Anachronismus-Datenbasis, Claude-Overrides.

const { runKomplettAnalyseJob, runKomplettAnalyseAll } = require('./job-komplett');
const { runKontinuitaetJob } = require('./job-kontinuitaet');

module.exports = { runKomplettAnalyseJob, runKontinuitaetJob, runKomplettAnalyseAll };
