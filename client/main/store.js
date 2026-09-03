'use strict';
/*
 * On-disk client state. One "profile" == one device identity == one account.
 * Run several profiles on one machine for testing:
 *     PQMSG_PROFILE=alice npm run client
 *     PQMSG_PROFILE=bob   npm run client
 *
 *   <profileDir>/
 *     identity.json                device keys + account + server + token
 *     contacts.json                cached IDS lookups
 *     conversations/<convId>.json  DECRYPTED conversation (plaintext, local only)
 *     outbox.json                  envelopes awaiting a successful POST
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class ClientStore {
  constructor(profile) {
    this.profile = profile || process.env.PQMSG_PROFILE || 'default';
    this.dir = process.env.PQMSG_DATA_DIR
      ? path.join(process.env.PQMSG_DATA_DIR, this.profile)
      : path.join(os.homedir(), '.pqmsg', this.profile);
    this.convDir = path.join(this.dir, 'conversations');
    fs.mkdirSync(this.convDir, { recursive: true });
  }
  _p(name) {
    return path.join(this.dir, name);
  }
  _readJson(p, dflt) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return dflt;
    }
  }
  _writeJson(p, obj) {
    const tmp = p + '.tmp-' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
  }

  // identity ------------------------------------------------------------
  loadIdentity() {
    return this._readJson(this._p('identity.json'), null);
  }
  saveIdentity(id) {
    this._writeJson(this._p('identity.json'), id);
  }

  // contacts ----------------------------------------------------------
  loadContacts() {
    return this._readJson(this._p('contacts.json'), {});
  }
  saveContact(username, ids) {
    const all = this.loadContacts();
    all[username] = { ...ids, fetchedAt: Date.now() };
    this._writeJson(this._p('contacts.json'), all);
  }
  getContact(username) {
    return this.loadContacts()[username] || null;
  }

  // outbox ----------------------------------------------------------
  loadOutbox() {
    return this._readJson(this._p('outbox.json'), []);
  }
  saveOutbox(list) {
    this._writeJson(this._p('outbox.json'), list);
  }

  // conversations -------------------------------------------------
  _convPath(convId) {
    return path.join(this.convDir, convId + '.json');
  }
  listConversationIds() {
    try {
      return fs.readdirSync(this.convDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }
  loadConversation(convId) {
    return this._readJson(this._convPath(convId), null);
  }
  saveConversation(conv) {
    this._writeJson(this._convPath(conv.convId), conv);
  }
  ensureConversation(convId, participants, kind) {
    let c = this.loadConversation(convId);
    if (!c) {
      c = {
        convId,
        participants,
        kind: kind || (participants.length > 2 ? 'group' : 'dm'),
        messages: {}, // msgId -> message record
        order: [], // canonical order (mirrors server); pending msgs appended
        cursorSeq: 0, // highest serverSeq consumed
        createdAt: Date.now(),
        lastReconciledAt: 0,
      };
      this.saveConversation(c);
    }
    return c;
  }
}

module.exports = { ClientStore };
