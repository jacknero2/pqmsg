'use strict';
const path = require('path');
const { LocalStore } = require('./local');
const { GitHubStore } = require('./github');
const { publicDeviceFields } = require('./util');

/**
 * @param {object} cfg
 * @param {'local'|'github'} cfg.backend
 * @param {string} [cfg.dataDir]
 * @param {string} [cfg.githubToken]
 * @param {string} [cfg.githubRepo]
 * @param {string} [cfg.githubBranch]
 */
function createStore(cfg) {
  if (cfg.backend === 'github') return new GitHubStore(cfg);
  return new LocalStore({ dataDir: cfg.dataDir || path.join(process.cwd(), 'server-data') });
}

module.exports = { createStore, LocalStore, GitHubStore, publicDeviceFields };
