'use strict';
const express = require('express');
const router = express.Router();

const { enforceBudget } = require('../lib/budget');
const { sharedRouter } = require('./jobs/shared');
const { lektoratRouter } = require('./jobs/lektorat');
const { reviewRouter } = require('./jobs/review');
const { kapitelRouter } = require('./jobs/kapitel');
const { komplettRouter, runKomplettAnalyseAll } = require('./jobs/komplett');
const { chatRouter } = require('./jobs/chat');
const { synonymeRouter } = require('./jobs/synonyme');
const { finetuneExportRouter } = require('./jobs/finetune-export');
const { pdfExportRouter } = require('./jobs/pdf-export');
const { figurWerkstattRouter } = require('./jobs/figur-werkstatt');
const { folderImportRouter } = require('./jobs/folder-import');
const { blogSyncRouter } = require('./jobs/blog-sync');
const { hubspotSyncRouter } = require('./jobs/hubspot-sync');

// Budget-Enforcement greift VOR allen Sub-Routern, sonst lassen sich
// die Job-POSTs unter /jobs/* nicht mit einer einzigen Middleware kapseln.
// enforceBudget skipped non-POST und non-Claude-Provider intern.
router.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  return enforceBudget(req, res, next);
});

// Feature-Router zuerst mounten – sharedRouter zuletzt, weil GET /:id und DELETE /:id
// als Catch-All wirken und sonst spezifischere Routen (z.B. DELETE /book-chat-cache,
// GET /kontinuitaet/:book_id) abfangen würden.
router.use('/', lektoratRouter);
router.use('/', reviewRouter);
router.use('/', kapitelRouter);
router.use('/', komplettRouter);
router.use('/', chatRouter);
router.use('/', synonymeRouter);
router.use('/', finetuneExportRouter);
router.use('/', pdfExportRouter);
router.use('/', figurWerkstattRouter);
router.use('/', folderImportRouter);
router.use('/', blogSyncRouter);
router.use('/', hubspotSyncRouter);
router.use('/', sharedRouter);

module.exports = { router, runKomplettAnalyseAll };
