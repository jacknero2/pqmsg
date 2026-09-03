'use strict';
/*
 * LocalStore — filesystem backend.
 *
 * Layout (everything here is safe to open in the server dashboard; message
 * bodies are ciphertext only):
 *
 *   <dataDir>/
 *     server-secret.json
 *     accounts.json
 *     conversations/
 *       <convId>/
 *         meta.json                      { convId, kind, participants[], createdAt }
 *         order.json                     { order: [msgId...], updatedAt }   <- canonical total order
 *         messages/
 *           000000001-msg_ab12...json    envelope + { serverRecvAt, serverSeq, deliveries }
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { KeyedMutex } = require('./mutex');
const { publicDeviceFields } = require('./util');

const pad = (n) => String(n).padStart(9, '0');

class LocalStore {
  constructor({ dataDir }) {
    this.dataDir = dataDir;
    this.convDir = path.join(dataDir, 'conversations');
    this.accountsPath = path.join(dataDir, 'accounts.json');
    this.secretPath = path.join(dataDir, 'server-secret.json');
    this.mutex = new KeyedMutex();
    this.kind = 'local';
  }

  async init() {
    await fsp.mkdir(this.convDir, { recursive: true });
    if (!fs.existsSync(this.accountsPath)) await this._writeJson(this.accountsPath, {});
  }

  // ---- low level ----------------------------------------------------------
  async _readJson(p, dflt) {
    try {
      return JSON.parse(await fsp.readFile(p, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return dflt;
      throw e;
    }
  }
  async _writeJson(p, obj) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + crypto.randomBytes(4).toString('hex');
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fsp.rename(tmp, p); // atomic replace
  }

  // ---- secrets ----------------------------------------------------------
  async getServerSecrets() {
    let s = await this._readJson(this.secretPath, null);
    if (!s) s = {};
    let dirty = false;
    for (const k of ['tokenSecret', 'trustSecret', 'masterSecret']) {
      if (!s[k]) (s[k] = crypto.randomBytes(32).toString('hex')), (dirty = true);
    }
    if (!s.adminToken) (s.adminToken = crypto.randomBytes(24).toString('hex')), (dirty = true);
    if (dirty) await this._writeJson(this.secretPath, s);
    return s;
  }

  // ---- accounts / IDS -------------------------------------------------
  async createAccount({ username, salt, hash, email }) {
    return this.mutex.run('accounts', async () => {
      const all = await this._readJson(this.accountsPath, {});
      if (all[username]) throw Object.assign(new Error('username taken'), { status: 409 });
      all[username] = { username, salt, hash, email: email || null, createdAt: Date.now(), devices: {} };
      await this._writeJson(this.accountsPath, all);
      return all[username];
    });
  }
  async getAccount(username) {
    const all = await this._readJson(this.accountsPath, {});
    return all[username] || null;
  }
  async listAccounts() {
    const all = await this._readJson(this.accountsPath, {});
    return Object.values(all).map((a) => ({
      username: a.username,
      createdAt: a.createdAt,
      deviceCount: Object.keys(a.devices || {}).length,
    }));
  }
  async addDevice(username, device) {
    return this.mutex.run('accounts', async () => {
      const all = await this._readJson(this.accountsPath, {});
      const acct = all[username];
      if (!acct) throw Object.assign(new Error('no such account'), { status: 404 });
      acct.devices = acct.devices || {};
      acct.devices[device.deviceId] = { ...device, addedAt: acct.devices[device.deviceId]?.addedAt || Date.now() };
      await this._writeJson(this.accountsPath, all);
      return acct.devices[device.deviceId];
    });
  }
  async getIds(username) {
    const acct = await this.getAccount(username);
    if (!acct) return null;
    return {
      username,
      devices: Object.values(acct.devices || {}).map(publicDeviceFields),
    };
  }
  async findUserByDevice(deviceId) {
    const all = await this._readJson(this.accountsPath, {});
    for (const a of Object.values(all)) {
      if (a.devices && a.devices[deviceId]) return a.username;
    }
    return null;
  }

  // ---- conversations / messages ------------------------------------
  _cdir(convId) {
    return path.join(this.convDir, convId);
  }
  async ensureConversation(convId, { kind, participants, name, homeServer }) {
    return this.mutex.run(convId, async () => {
      const metaPath = path.join(this._cdir(convId), 'meta.json');
      const existing = await this._readJson(metaPath, null);
      if (existing) {
        existing.created = false;
        return existing;
      }
      const meta = {
        convId,
        kind: kind || 'dm',
        participants: participants || [],
        name: name || null,
        homeServer: homeServer || null,
        createdAt: Date.now(),
      };
      await this._writeJson(metaPath, meta);
      await this._writeJson(path.join(this._cdir(convId), 'order.json'), { order: [], updatedAt: Date.now() });
      await fsp.mkdir(path.join(this._cdir(convId), 'messages'), { recursive: true });
      return { ...meta, created: true };
    });
  }
  /** Replace a group's participant list / name (membership change). */
  async setConversationParticipants(convId, participants, name) {
    return this.mutex.run(convId, async () => {
      const metaPath = path.join(this._cdir(convId), 'meta.json');
      const meta = await this._readJson(metaPath, null);
      if (!meta) return null;
      meta.participants = participants;
      if (name !== undefined) meta.name = name;
      meta.updatedAt = Date.now();
      await this._writeJson(metaPath, meta);
      return meta;
    });
  }
  // ---- federation inbox pointers (conversations hosted on other servers) ----
  _pdir() {
    return path.join(this.dataDir, 'pointers');
  }
  async addPointer(handleHash, pointer) {
    return this.mutex.run('ptr:' + handleHash, async () => {
      const p = path.join(this._pdir(), handleHash + '.json');
      const list = await this._readJson(p, []);
      const i = list.findIndex((x) => x.convId === pointer.convId);
      if (i >= 0) list[i] = { ...list[i], ...pointer, updatedAt: Date.now() };
      else list.push({ ...pointer, addedAt: Date.now() });
      await this._writeJson(p, list);
      return pointer;
    });
  }
  async listPointers(handleHash) {
    return this._readJson(path.join(this._pdir(), handleHash + '.json'), []);
  }
  async appendMessage(convId, envelope) {
    return this.mutex.run(convId, async () => {
      const orderPath = path.join(this._cdir(convId), 'order.json');
      const order = await this._readJson(orderPath, { order: [], updatedAt: 0 });
      if (order.order.includes(envelope.msgId)) {
        return this.getMessage(convId, envelope.msgId); // idempotent re-POST
      }
      const serverSeq = order.order.length + 1;
      const stored = {
        ...envelope,
        serverRecvAt: Date.now(),
        serverSeq,
        deliveries: {},
      };
      await this._writeJson(
        path.join(this._cdir(convId), 'messages', `${pad(serverSeq)}-${envelope.msgId}.json`),
        stored
      );
      order.order.push(envelope.msgId);
      order.updatedAt = Date.now();
      await this._writeJson(orderPath, order);
      return stored;
    });
  }
  async _messageFiles(convId) {
    try {
      const files = await fsp.readdir(path.join(this._cdir(convId), 'messages'));
      return files.filter((f) => f.endsWith('.json')).sort();
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
  async getMessage(convId, msgId) {
    for (const f of await this._messageFiles(convId)) {
      if (f.includes(msgId)) {
        return this._readJson(path.join(this._cdir(convId), 'messages', f), null);
      }
    }
    return null;
  }
  async listMessages(convId, { sinceSeq = 0 } = {}) {
    const out = [];
    for (const f of await this._messageFiles(convId)) {
      const m = await this._readJson(path.join(this._cdir(convId), 'messages', f), null);
      if (m && m.serverSeq > sinceSeq) out.push(m);
    }
    return out;
  }
  async getOrder(convId) {
    const o = await this._readJson(path.join(this._cdir(convId), 'order.json'), { order: [] });
    return o.order;
  }
  async markDelivered(convId, msgId, deviceId, ts) {
    return this.mutex.run(convId, async () => {
      const files = await this._messageFiles(convId);
      const f = files.find((x) => x.includes(msgId));
      if (!f) return null;
      const p = path.join(this._cdir(convId), 'messages', f);
      const m = await this._readJson(p, null);
      if (!m) return null;
      m.deliveries = m.deliveries || {};
      if (!m.deliveries[deviceId]) {
        m.deliveries[deviceId] = ts || Date.now();
        await this._writeJson(p, m);
      }
      return m;
    });
  }
  /** Read just one conversation's meta.json — the hot path for request guards. */
  async getConversationMeta(convId) {
    return this._readJson(path.join(this._cdir(convId), 'meta.json'), null);
  }
  /** @param {{counts?: boolean}} opts  counts=true also does a readdir per conv for messageCount */
  async listConversations({ counts = false } = {}) {
    let dirs = [];
    try {
      dirs = await fsp.readdir(this.convDir);
    } catch {
      return [];
    }
    const out = [];
    for (const d of dirs) {
      const meta = await this._readJson(path.join(this._cdir(d), 'meta.json'), null);
      if (!meta) continue;
      out.push(counts ? { ...meta, messageCount: (await this._messageFiles(d)).length } : meta);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }
  async conversationsForParticipant(username) {
    return (await this.listConversations())
      .filter((c) => (c.participants || []).includes(username))
      .map((c) => c.convId);
  }
  async stats() {
    const accounts = await this.listAccounts();
    const convs = await this.listConversations({ counts: true });
    return {
      backend: 'local',
      accounts: accounts.length,
      devices: accounts.reduce((n, a) => n + a.deviceCount, 0),
      conversations: convs.length,
      messages: convs.reduce((n, c) => n + c.messageCount, 0),
    };
  }
}

module.exports = { LocalStore };
