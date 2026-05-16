'use strict';
// Facade-Re-Export: alle bisherigen `module.exports`-Keys von `shared.js`
// stehen weiterhin als `require('./shared')` zur Verfügung.
const express = require('express');
const { getPrompts, getPromptConfig } = require('../../../lib/prompts-loader');

const state    = require('./state');
const queue    = require('./queue');
const jobsMod  = require('./jobs');
const model    = require('./model');
const ai       = require('./ai');
const bs       = require('./bookstack');
const loader   = require('./loader');
const queries  = require('./queries');
const router   = require('./router');

// Rückwärtskompatibler Export – einige Module lesen _promptConfig direkt.
const _promptConfig = getPromptConfig();

const jsonBody = express.json();
const jsonBodyLarge = express.json({ limit: '5mb' });

module.exports = {
  _promptConfig,
  jobs: state.jobs,
  runningJobs: state.runningJobs,
  jobAbortControllers: state.jobAbortControllers,
  jobQueue: state.jobQueue,
  jobKey: state.jobKey,

  makeJobLogger: jobsMod.makeJobLogger,
  enqueueJob: queue.enqueueJob,
  createJob: jobsMod.createJob,
  updateJob: jobsMod.updateJob,
  tps: jobsMod.tps,
  completeJob: jobsMod.completeJob,
  failJob: jobsMod.failJob,
  cancelJob: jobsMod.cancelJob,
  findActiveJobId: jobsMod.findActiveJobId,
  fmtTok: jobsMod.fmtTok,
  i18nError: jobsMod.i18nError,
  bsHttpError: jobsMod.bsHttpError,

  _modelName: model._modelName,
  settledAll: ai.settledAll,

  htmlToText: ai.htmlToText,
  cleanPageTextForClaude: ai.cleanPageTextForClaude,

  loadPageContents: loader.loadPageContents,
  groupByChapter: loader.groupByChapter,
  buildSinglePassBookText: loader.buildSinglePassBookText,
  splitGroupsIntoChunks: loader.splitGroupsIntoChunks,

  aiCall: ai.aiCall,
  toSystemBlocks: ai.toSystemBlocks,

  getPrompts,
  getBookPrompts: bs.getBookPrompts,

  getFiguren: queries.getFiguren,
  getLatestReview: queries.getLatestReview,
  getLatestPageCheck: queries.getLatestPageCheck,
  getOpenIdeen: queries.getOpenIdeen,
  buildChatMessageHistory: queries.buildChatMessageHistory,

  SINGLE_PASS_LIMIT: loader.SINGLE_PASS_LIMIT,
  PER_CHUNK_LIMIT: loader.PER_CHUNK_LIMIT,
  BATCH_SIZE: loader.BATCH_SIZE,

  jsonBody, jsonBodyLarge,
  sharedRouter: router.sharedRouter,
};
