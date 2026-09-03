'use strict';
/*
 * GitHubStore — the same interface as LocalStore, but every file lives in a
 * GitHub repository. Enables the "the database IS a git repo, ordering follows
 * commit order" model from the design.
 *
 * Config (server .env): STORE_BACKEND=github  GITHUB_TOKEN=ghp_...  GITHUB_REPO=owner/name  [GITHUB_BRANCH=main]
 *
 * Notes / trade-offs (documented in README):
 *   - Authenticated contents API: 5000 req/hr. Every poll cycle costs requests;
 *     keep sync intervals >= 3s and few conversations while testing.
 *   - Writes are create-or-update-by-sha; concurrent writers get a 409 and we
 *     retry after refetching. Fine for a handful of clients.
 *   - order.json (commit order == canonical total order) is updated on every
 *     appendMessage, serialized per-conversation by an in-process mutex.
 */

const path = require('path').posix;
const crypto = require('crypto');
const { KeyedMutex } = require('./mutex');
const { publicDeviceFields } = require('./util');

const pad = (n) => String(n).padStart(9, '0');
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const fromb64 = (s) => Buffer.from(s, 'base64').toString('utf8');

class GitHubStore {
  constructor({ githubToken, githubRepo, githubBranch = 'main' }) {
    if (!githubToken || !githubRepo) throw new Error('GitHubStore needs githubToken + githubRepo');
    const [owner, repo] = githubRepo.split('/');
    this.owner = owner;
    this.repo = repo;
    this.branch = githubBranch;
    this.token = githubToken;
    this.mutex = new KeyedMutex();
    this.kind = 'github';
    this._shaCache = new Map();
  }

  async init() {
    const { Octokit } = await import('@octokit/rest');
    this.gh = new Octokit({ auth: this.token });
    // touch repo + ensure accounts.json exists
    await this.gh.repos.get({ owner: this.owner, repo: this.repo });
    if ((await this._getJson('accounts.json')) === null) {
      await this._putJson('accounts.json', {}, 'pqmsg: init accounts');
    }
  }

  // ---- low level ---------------------------------------------------------
  async _getRaw(p) {
    try {
      const res = await this.gh.repos.getContent({
        owner: this.owner,
        repo: this.repo,
        path: p,
        ref: this.branch,
      });
      if (Array.isArray(res.data)) return { dir: res.data };
      this._shaCache.set(p, res.data.sha);
      return { content: fromb64(res.data.content.replace(/\n/g, '')), sha: res.data.sha };
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  }
  async _getJson(p, dflt = null) {
    const r = await this._getRaw(p);
    if (!r || r.content == null) return dflt;
    try {
      return JSON.parse(r.content);
    } catch {
      return dflt;
    }
  }
  async _putJson(p, obj, message, { retries = 4 } = {}) {
    let sha = this._shaCache.get(p);
    for (let attempt = 0; ; attempt++) {
      if (sha === undefined) {
        const cur = await this._getRaw(p);
        sha = cur ? cur.sha : null;
      }
      try {
        const res = await this.gh.repos.createOrUpdateFileContents({
          owner: this.owner,
          repo: this.repo,
          path: p,
          message: message || `pqmsg: update ${p}`,
          content: b64(JSON.stringify(obj, null, 2)),
          branch: this.branch,
          ...(sha ? { sha } : {}),
        });
        this._shaCache.set(p, res.data.content.sha);
        return obj;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < retries) {
          this._shaCache.delete(p);
          sha = undefined;
          await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
  }
  async _listDir(p) {
    const r = await this._getRaw(p);
    if (!r || !r.dir) return [];
    return r.dir;
  }

  // ---- secrets (kept local to the server, NOT in the repo) --------------
  async getServerSecrets() {
    // Secrets must never be committed. Derive/store them on the server host.
    const fs = require('fs');
    const os = require('os');
    const p = path.join(os.homedir(), '.pqmsg-server-secret.json');
    let s = {};
    try {
      s = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {}
    let dirty = false;
    for (const k of ['tokenSecret', 'trustSecret', 'masterSecret']) {
      if (!s[k]) (s[k] = crypto.randomBytes(32).toString('hex')), (dirty = true);
    }
    if (!s.adminToken) (s.adminToken = crypto.randomBytes(24).toString('hex')), (dirty = true);
    if (dirty) fs.writeFileSync(p, JSON.stringify(s, null, 2));
    return s;
  }

  // ---- accounts / IDS -------------------------------------------------
  async createAccount({ username, salt, hash, email }) {
    return this.mutex.run('accounts', async () => {
      const all = (await this._getJson('accounts.json')) || {};
      if (all[username]) throw Object.assign(new Error('username taken'), { status: 409 });
      all[username] = { username, salt, hash, email: email || null, createdAt: Date.now(), devices: {} };
      await this._putJson('accounts.json', all, `pqmsg: register ${username}`);
      return all[username];
    });
  }
  async getAccount(username) {
    const all = (await this._getJson('accounts.json')) || {};
    return all[username] || null;
  }
  async listAccounts() {
    const all = (await this._getJson('accounts.json')) || {};
    return Object.values(all).map((a) => ({
      username: a.username,
      createdAt: a.createdAt,
      deviceCount: Object.keys(a.devices || {}).length,
    }));
  }
  async addDevice(username, device) {
    return this.mutex.run('accounts', async () => {
      const all = (await this._getJson('accounts.json')) || {};
      const acct = all[username];
      if (!acct) throw Object.assign(new Error('no such account'), { status: 404 });
      acct.devices = acct.devices || {};
      acct.devices[device.deviceId] = {
        ...device,
        addedAt: acct.devices[device.deviceId]?.addedAt || Date.now(),
      };
      await this._putJson('accounts.json', all, `pqmsg: enroll device for ${username}`);
      return acct.devices[device.deviceId];
    });
  }
  async getIds(username) {
    const acct = await this.getAccount(username);
    if (!acct) return null;
    return { username, devices: Object.values(acct.devices || {}).map(publicDeviceFields) };
  }
  async findUserByDevice(deviceId) {
    const all = (await this._getJson('accounts.json')) || {};
    for (const a of Object.values(all)) if (a.devices && a.devices[deviceId]) return a.username;
    return null;
  }

  // ---- conversations / messages ------------------------------------
  _cdir(c) {
    return `conversations/${c}`;
  }
  async ensureConversation(convId, { kind, participants, name, homeServer }) {
    return this.mutex.run(convId, async () => {
      const metaPath = `${this._cdir(convId)}/meta.json`;
      const existing = await this._getJson(metaPath);
      if (existing) return { ...existing, created: false };
      const meta = {
        convId,
        kind: kind || 'dm',
        participants: participants || [],
        name: name || null,
        homeServer: homeServer || null,
        createdAt: Date.now(),
      };
      await this._putJson(metaPath, meta, `pqmsg: open conversation ${convId}`);
      await this._putJson(`${this._cdir(convId)}/order.json`, { order: [], updatedAt: Date.now() }, 'pqmsg: init order');
      return { ...meta, created: true };
    });
  }
  async setConversationParticipants(convId, participants, name) {
    return this.mutex.run(convId, async () => {
      const metaPath = `${this._cdir(convId)}/meta.json`;
      const meta = await this._getJson(metaPath);
      if (!meta) return null;
      meta.participants = participants;
      if (name !== undefined) meta.name = name;
      meta.updatedAt = Date.now();
      await this._putJson(metaPath, meta, `pqmsg: members ${convId}`);
      return meta;
    });
  }
  async addPointer(handleHash, pointer) {
    return this.mutex.run('ptr:' + handleHash, async () => {
      const p = `pointers/${handleHash}.json`;
      const list = (await this._getJson(p)) || [];
      const i = list.findIndex((x) => x.convId === pointer.convId);
      if (i >= 0) list[i] = { ...list[i], ...pointer, updatedAt: Date.now() };
      else list.push({ ...pointer, addedAt: Date.now() });
      await this._putJson(p, list, `pqmsg: pointer ${pointer.convId}`);
      return pointer;
    });
  }
  async listPointers(handleHash) {
    return (await this._getJson(`pointers/${handleHash}.json`)) || [];
  }
  async appendMessage(convId, envelope) {
    return this.mutex.run(convId, async () => {
      const orderPath = `${this._cdir(convId)}/order.json`;
      const order = (await this._getJson(orderPath)) || { order: [], updatedAt: 0 };
      if (order.order.includes(envelope.msgId)) return this.getMessage(convId, envelope.msgId);
      const serverSeq = order.order.length + 1;
      const stored = { ...envelope, serverRecvAt: Date.now(), serverSeq, deliveries: {} };
      await this._putJson(
        `${this._cdir(convId)}/messages/${pad(serverSeq)}-${envelope.msgId}.json`,
        stored,
        `pqmsg: msg ${serverSeq} in ${convId}`
      );
      order.order.push(envelope.msgId);
      order.updatedAt = Date.now();
      await this._putJson(orderPath, order, `pqmsg: order +${envelope.msgId}`);
      return stored;
    });
  }
  async _messageFiles(convId) {
    const entries = await this._listDir(`${this._cdir(convId)}/messages`);
    return entries
      .filter((e) => e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort();
  }
  async getMessage(convId, msgId) {
    for (const f of await this._messageFiles(convId)) {
      if (f.includes(msgId)) return this._getJson(`${this._cdir(convId)}/messages/${f}`);
    }
    return null;
  }
  async listMessages(convId, { sinceSeq = 0 } = {}) {
    const out = [];
    for (const f of await this._messageFiles(convId)) {
      const seq = parseInt(f.slice(0, 9), 10);
      if (seq > sinceSeq) {
        const m = await this._getJson(`${this._cdir(convId)}/messages/${f}`);
        if (m) out.push(m);
      }
    }
    return out;
  }
  async getOrder(convId) {
    const o = (await this._getJson(`${this._cdir(convId)}/order.json`)) || { order: [] };
    return o.order;
  }
  async markDelivered(convId, msgId, deviceId, ts) {
    return this.mutex.run(convId, async () => {
      const f = (await this._messageFiles(convId)).find((x) => x.includes(msgId));
      if (!f) return null;
      const p = `${this._cdir(convId)}/messages/${f}`;
      const m = await this._getJson(p);
      if (!m) return null;
      m.deliveries = m.deliveries || {};
      if (!m.deliveries[deviceId]) {
        m.deliveries[deviceId] = ts || Date.now();
        await this._putJson(p, m, `pqmsg: delivered ${msgId} -> ${deviceId}`);
      }
      return m;
    });
  }
  async getConversationMeta(convId) {
    return this._getJson(`${this._cdir(convId)}/meta.json`);
  }
  async listConversations({ counts = false } = {}) {
    const dirs = await this._listDir('conversations');
    const out = [];
    for (const d of dirs) {
      if (d.type !== 'dir') continue;
      const meta = await this._getJson(`conversations/${d.name}/meta.json`);
      if (!meta) continue;
      out.push(counts ? { ...meta, messageCount: (await this._messageFiles(d.name)).length } : meta);
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
      backend: 'github',
      repo: `${this.owner}/${this.repo}`,
      accounts: accounts.length,
      devices: accounts.reduce((n, a) => n + a.deviceCount, 0),
      conversations: convs.length,
      messages: convs.reduce((n, c) => n + c.messageCount, 0),
    };
  }
}

module.exports = { GitHubStore };
