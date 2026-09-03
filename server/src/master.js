'use strict';
/*
 * The "master" credential for a server that also hosts the registry.
 * One password, bound to a fixed email (PQMSG_MASTER_EMAIL, default
 * jnero@nd.edu), verified once by an emailed code. Stored in
 * <dataDir>/master.json — separate from normal user accounts.
 */
const fs = require('fs');
const path = require('path');
const proto = require('../../shared/protocol');

class Master {
  constructor(dataDir, configuredEmail) {
    this.file = path.join(dataDir, 'master.json');
    this.configuredEmail = String(configuredEmail || '').toLowerCase();
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.data = { email: this.configuredEmail, salt: null, hash: null, registryEnabled: false, createdAt: null };
    }
    if (!this.data.email) this.data.email = this.configuredEmail;
  }
  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  get email() {
    return this.data.email || this.configuredEmail;
  }
  get hasPassword() {
    return !!this.data.hash;
  }
  get registryEnabled() {
    return !!this.data.registryEnabled;
  }
  setPassword(pw) {
    const { salt, hash } = proto.hashPassword(pw);
    this.data.salt = salt;
    this.data.hash = hash;
    this.data.email = this.configuredEmail;
    this.data.createdAt = this.data.createdAt || Date.now();
    this._save();
  }
  verifyPassword(pw) {
    return this.hasPassword && proto.verifyPassword(pw, this.data.salt, this.data.hash);
  }
  setRegistryEnabled(on) {
    this.data.registryEnabled = !!on;
    this._save();
  }
  status() {
    return { email: this.email, hasPassword: this.hasPassword, registryEnabled: this.registryEnabled };
  }
}

module.exports = { Master };
