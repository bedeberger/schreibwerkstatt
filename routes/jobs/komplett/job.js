'use strict';
// Komplettanalyse-Jobs — Facade. Aufgeteilt nach Job-Typ:
//   job-komplett.js     — Kern-Pipeline (P1–P8) + Nacht-Cron (runKomplettAnalyseAll).
//   job-kontinuitaet.js — Standalone-Kontinuitätscheck (runKontinuitaetJob).
//   job-erzaehlprofil.js— Standalone-Erzählprofil (runErzaehlprofilJob).
//   job-faktencheck.js  — Standalone-Weltfakten-Realitätscheck (runFaktencheckJob).
//   job-shared.js       — Verify-Stufe, Anachronismus-Datenbasis, Claude-Overrides.

const { runKomplettAnalyseJob, runKomplettAnalyseAll } = require('./job-komplett');
const { runKontinuitaetJob } = require('./job-kontinuitaet');
const { runErzaehlprofilJob } = require('./job-erzaehlprofil');
const { runFaktencheckJob } = require('./job-faktencheck');

module.exports = { runKomplettAnalyseJob, runKontinuitaetJob, runErzaehlprofilJob, runFaktencheckJob, runKomplettAnalyseAll };
