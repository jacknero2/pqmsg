'use strict';
/*
 * The "master" credential for the operator's dashboard — a single admin
 * account (password + emailed 2FA), separate from normal user accounts and
 * from the static PQMSG_ADMIN_TOKEN (which still works, for scripts/automation
 * and for the loopback bypass in local dev).
 * Stored in <dataDir>/master.json.
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
      this.data = { email: this.configuredEmail, salt: null, hash: null, createdAt: null };
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
  status() {
    return { email: this.email, hasPassword: this.hasPassword };
  }
}

module.exports = { Master };
