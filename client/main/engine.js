'use strict';
/*
 * pqmsg client engine (Electron main process).
 *
 * Owns: device identity + secret keys, the server API client, the background
 * sync loop, and the local *decrypted* conversation store. The renderer never
 * sees key material — it talks to this over IPC.
 *
 * Robustness / eventual consistency:
 *   - Sends are optimistic; failures land in a disk outbox and retry every cycle.
 *   - Every sync cycle re-pulls a trailing window of each conversation and snaps
 *     local message order to the server's canonical `order` array. Local-only
 *     (not-yet-acked) messages are pinned to the tail until the server has them.
 *   - Outgoing message colour: pending/sent => light red, delivered => gold.
 */

const os = require('os');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { Api } = require('./api');
const { ClientStore } = require('./store');
const disc = require('./discovery');
const pqc = require('../../shared/crypto');

const norm = (u) => String(u || '').trim().toLowerCase();
const TRAILING_WINDOW = 30; // messages re-checked each cycle for order + delivery
// The one pqmsg server. Overridable via env for local dev/testing only — there
// is no server picker in the UI, and no other server is ever contacted.
const SERVER_URL = process.env.PQMSG_SERVER_URL || 'https://chat.jacknero.com';

class Engine extends EventEmitter {
  constructor(profile, baseDir, appVersion) {
    super();
    this.store = new ClientStore(profile, baseDir);
    this.identity = this.store.loadIdentity();
    this.appVersion = appVersion || require('../../package.json').version;
    this.api = null;
    this.ws = null;
    this.connected = false;
    this.needsLogin = !this.identity;
    this.syncing = false;
    this.syncIntervalMs = parseInt(process.env.PQMSG_SYNC_MS || '3000', 10);
    this._timer = null;
    this._wsRetry = 0;
    this._forced = new Set();
    this.lastSyncAt = 0;
    this.lastSyncError = null;
    this.log = [];
    // version gate
    this.updateGate = null; // { required, current, downloadUrl, source } -> hard block
    this.updateInfo = null; // { latest, downloadUrl }                   -> soft banner
    this._versionFloor = null;
  }

  event(kind, detail) {
    const e = { at: Date.now(), kind, ...detail };
    this.log.push(e);
    if (this.log.length > 200) this.log.shift();
    this.emit('engine-event', e);
    this.emit('update');
  }

  get me() {
    return this.identity ? norm(this.identity.username) : null;
  }
  /** this account's global handle: username@<canonical origin of its home server> */
  get myHandle() {
    return this.identity ? pqc.formatHandle({ username: this.me, server: pqc.normServer(this.identity.serverUrl) }) : null;
  }
  isMe(handle) {
    try {
      return pqc.normHandle(handle) === this.myHandle;
    } catch {
      return norm(handle) === this.me; // legacy bare-username records
    }
  }

  // -- federated HTTP: talk to a conversation's home server, proving identity
  //    with a short ML-DSA-signed X-PQMSG-Auth header when needed -----------
  _authHeader({ method, path, convId }) {
    const ts = Date.now();
    const sig = pqc.signRequest(this.identity.sigSecretKey, {
      m: 'pqmsg-auth',
      method,
      path,
      convId: convId || null,
      deviceId: this.identity.deviceId,
      ts,
    });
    return Buffer.from(JSON.stringify({ handle: this.myHandle, deviceId: this.identity.deviceId, ts, sig })).toString('base64');
  }
  async _fed(method, serverUrl, path, { query, body, auth, convId } = {}) {
    const qs = query ? '?' + new URLSearchParams(query).toString() : '';
    const headers = { 'content-type': 'application/json' };
    if (auth) headers['x-pqmsg-auth'] = this._authHeader({ method, path, convId });
    const res = await fetch(pqc.normServer(serverUrl) + path + qs, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  snapshot() {
    return {
      profile: this.store.profile,
      dir: this.store.dir,
      enrolled: !!this.identity,
      needsLogin: this.needsLogin,
      username: this.identity?.username || null,
      deviceName: this.identity?.deviceName || null,
      deviceId: this.identity?.deviceId || null,
      serverUrl: this.identity?.serverUrl || SERVER_URL,
      safetyNumber: this.identity ? pqc.safetyNumber([this.identity.sigPublicKey]) : null,
      connected: this.connected,
      syncing: this.syncing,
      syncIntervalMs: this.syncIntervalMs,
      lastSyncAt: this.lastSyncAt,
      lastSyncError: this.lastSyncError,
      conversations: this.listConversationsView(),
      log: this.log.slice(-60),
      appVersion: this.appVersion,
      updateGate: this.updateGate,
      updateInfo: this.updateInfo,
    };
  }

  /** Recompute the update gate from the global floor + this server's serverinfo. */
  async checkVersion(serverInfo) {
    if (!this._versionFloor) this._versionFloor = (await disc.getVersionFloor()) || {};
    if (!serverInfo) {
      serverInfo = await disc.probe(this.identity?.serverUrl || SERVER_URL).catch(() => null);
    }
    const { gate, update } = disc.versionVerdict(this.appVersion, this._versionFloor, serverInfo);
    const changed = JSON.stringify([gate, update]) !== JSON.stringify([this.updateGate, this.updateInfo]);
    this.updateGate = gate;
    this.updateInfo = update;
    if (gate) this.event('update-required', { required: gate.required, current: gate.current });
    if (changed) this.emit('update');
    return gate;
  }

  // -- account lifecycle -------------------------------------------------
  async register({ username, password, email }) {
    const api = new Api(SERVER_URL);
    await api.register(norm(username), password, String(email || '').trim().toLowerCase());
    this.event('register', { username: norm(username) });
    return { ok: true };
  }

  _trustKey(serverUrl) {
    return pqc.normServer(serverUrl);
  }

  /**
   * Login step 1: password. Returns either
   *   { needs2fa: true, challengeId, email, dev, devCode? }  -> call completeLogin
   *   { ok: true, deviceId }                                  -> trusted device, done
   */
  async login({ username, password, deviceName }) {
    const serverUrl = SERVER_URL;
    username = norm(username);
    const info = await disc.probe(serverUrl).catch(() => null);
    const gate = await this.checkVersion(info || undefined);
    if (gate) {
      const err = new Error(`this server needs pqmsg ≥ ${gate.required} (you have ${gate.current})`);
      err.code = 'UPDATE_REQUIRED';
      throw err;
    }
    if (this.identity && norm(this.identity.username) !== username) {
      throw new Error(`profile "${this.store.profile}" is already bound to @${this.identity.username}; use a different PQMSG_PROFILE`);
    }

    const api = new Api(serverUrl);
    const trustToken = (this.store.loadAppConfig().trust || {})[this._trustKey(serverUrl)] || null;
    const r = await api.login(username, password, trustToken);

    if (r.token) {
      // trusted device (or legacy no-email account) — straight through
      return this._finishLogin({ serverUrl, username, deviceName, token: r.token });
    }
    // needs a code
    this._pending2fa = { serverUrl, username, deviceName, challengeId: r.challengeId };
    return { needs2fa: true, challengeId: r.challengeId, email: r.email, dev: !!r.dev, devCode: r.devCode || null };
  }

  /** Login step 2: the emailed code (+ optional 30-day remember-this-device). */
  async completeLogin({ code, rememberDevice }) {
    const p = this._pending2fa;
    if (!p) throw new Error('no login in progress');
    const api = new Api(p.serverUrl);
    const r = await api.verify(p.challengeId, code, !!rememberDevice);
    if (rememberDevice && r.trustToken) {
      const cfg = this.store.loadAppConfig();
      const trust = { ...(cfg.trust || {}), [this._trustKey(p.serverUrl)]: r.trustToken };
      this.store.saveAppConfig({ trust });
    }
    this._pending2fa = null;
    return this._finishLogin({ serverUrl: p.serverUrl, username: p.username, deviceName: p.deviceName, token: r.token });
  }

  /** shared tail of both login paths: (re)enroll this device and start syncing */
  async _finishLogin({ serverUrl, username, deviceName, token }) {
    const api = new Api(serverUrl, token);
    let id = this.identity;
    if (!id) {
      const keys = pqc.generateIdentity();
      id = {
        username,
        deviceName: deviceName || `${os.hostname()} (${this.store.profile})`,
        ...keys,
        deviceId: pqc.deviceIdFromSigPub(keys.sigPublicKey),
      };
    }
    id.serverUrl = serverUrl;
    id.token = token;

    const attestation = pqc.signEnrollment(id, { username, deviceName: id.deviceName });
    const { deviceId } = await api.enrollDevice({
      deviceName: id.deviceName,
      kemPublicKey: id.kemPublicKey,
      sigPublicKey: id.sigPublicKey,
      attestation,
    });
    id.deviceId = deviceId;

    this.identity = id;
    this.store.saveIdentity(id);
    this.api = api;
    this.needsLogin = false;
    this.event('enroll', { username, deviceId, deviceName: id.deviceName });
    this.startLoops();
    this.connectWs();
    this.syncOnce('post-login').catch(() => {});
    return { ok: true, deviceId };
  }

  async resume() {
    this.checkVersion().catch(() => {}); // global floor, even before login
    this._verTimer = setInterval(() => this.checkVersion().catch(() => {}), 6 * 3600 * 1000);
    this._verTimer.unref && this._verTimer.unref();
    if (!this.identity) return;
    this.api = new Api(this.identity.serverUrl, this.identity.token);
    this.offline = false;
    await this._tryResume(0);
  }

  /**
   * A saved session should survive network trouble, not just outlive its own
   * TTL — a DNS blip or a dead tunnel URL is not the same thing as "your login
   * expired," and treating them the same used to force a full password + 2FA
   * relogin on every transient failure. Only a real 401/403 means the token
   * itself is invalid; anything else (fetch failure, 5xx, timeout) keeps the
   * existing session and retries with backoff instead.
   */
  async _tryResume(attempt) {
    try {
      await this.api.myDevices(); // validates token
      this.needsLogin = false;
      this.offline = false;
      if (this._resumeRetryTimer) clearTimeout(this._resumeRetryTimer);
      this._resumeRetryTimer = null;
      this.startLoops();
      this.connectWs();
      this.syncOnce('resume').catch(() => {});
    } catch (e) {
      const authFailure = e.status === 401 || e.status === 403;
      if (authFailure) {
        this.needsLogin = true;
        this.offline = false;
        this.event('token-expired', { error: e.message });
        return;
      }
      this.needsLogin = false;
      this.offline = true;
      this.reportDiagnostic('resume-offline', e.message, { attempt, status: e.status ?? null });
      this.event('offline', { error: e.message, attempt });
      const delay = Math.min(30_000, 1000 * 2 ** attempt) + Math.random() * 500;
      this._resumeRetryTimer = setTimeout(() => this._tryResume(attempt + 1), delay);
      this._resumeRetryTimer.unref && this._resumeRetryTimer.unref();
    }
  }

  /** Best-effort error report to our own server (never blocks, never throws). */
  reportDiagnostic(kind, message, context) {
    if (!this.api || !this.api.base) return;
    fetch(this.api.base + '/api/diagnostics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind,
        message: String(message || '').slice(0, 500),
        context: { appVersion: this.appVersion, platform: process.platform, ...(context || {}) },
      }),
    }).catch(() => {});
  }

  logout() {
    this.stopLoops();
    if (this.ws) try { this.ws.close(); } catch {}
    this.ws = null;
    this.connected = false;
    if (this.identity) {
      delete this.identity.token;
      this.store.saveIdentity(this.identity);
    }
    this.needsLogin = true;
    this.emit('update');
  }

  // -- loops / websocket ----------------------------------------------
  startLoops() {
    this.stopLoops();
    this._timer = setInterval(() => this.syncOnce('interval').catch(() => {}), this.syncIntervalMs);
  }
  stopLoops() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
  setSyncInterval(ms) {
    this.syncIntervalMs = Math.max(1000, ms | 0);
    if (this._timer) this.startLoops();
    this.emit('update');
  }

  connectWs() {
    if (!this.identity) return;
    if (this.ws) try { this.ws.close(); } catch {}
    const wsBase = this.identity.serverUrl.replace(/^http/, 'ws');
    const url =
      `${wsBase}/ws?token=${encodeURIComponent(this.identity.token)}` +
      `&deviceId=${encodeURIComponent(this.identity.deviceId)}` +
      `&deviceName=${encodeURIComponent(this.identity.deviceName)}`;
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.on('open', () => {
      this.connected = true;
      this._wsRetry = 0;
      this.event('ws-open', {});
    });
    ws.on('message', (raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      if (m.type === 'wake' && m.convId) {
        this._forced.add(m.convId);
        this.syncOnce('wake').catch(() => {});
      }
    });
    ws.on('close', () => {
      this.connected = false;
      this.emit('update');
      if (this.identity && !this.needsLogin) {
        this._wsRetry = Math.min(this._wsRetry + 1, 6);
        setTimeout(() => this.connectWs(), 500 * 2 ** this._wsRetry);
      }
    });
    ws.on('error', () => {}); // 'close' handles retry
  }

  // -- contacts / IDS --------------------------------------------------
  /**
   * Normalize any input to username@<our one server>. There is only one
   * server, so any "@..." the caller typed is ignored rather than trusted —
   * this account never contacts anywhere else.
   */
  _asHandle(handleInput) {
    const s = String(handleInput || '').trim();
    const username = s.includes('@') ? s.slice(0, s.indexOf('@')) : s;
    return pqc.normHandle(`${username}@${this.identity ? this.identity.serverUrl : SERVER_URL}`);
  }
  async refreshContact(handleInput, force = false) {
    const handle = this._asHandle(handleInput);
    const { username, server } = pqc.parseHandle(handle);
    const cached = this.store.getContact(handle);
    if (!force && cached && Date.now() - cached.fetchedAt < 60000) return cached;
    let ids;
    if (server === pqc.parseHandle(this.myHandle).server && this.api) {
      ids = await this.api.ids(username); // our own server — use the authed client
    } else {
      ids = await this._fed('GET', server, `/api/ids/${encodeURIComponent(username)}`);
    }
    ids.handle = handle;
    if (cached && cached.safetyNumber && ids.safetyNumber !== cached.safetyNumber) {
      this.event('safety-number-changed', { handle, from: cached.safetyNumber, to: ids.safetyNumber });
    }
    this.store.saveContact(handle, ids);
    return this.store.getContact(handle);
  }

  /** @param {string} input  a username — the server is always this account's own */
  async startConversation(input) {
    const other = this._asHandle(input);
    if (this.isMe(other)) throw new Error('cannot message yourself');
    const ids = await this.refreshContact(other, true);
    if (!ids.devices.length) throw new Error(`${other} has no enrolled devices yet`);
    const parts = [this.myHandle, other];
    const convId = pqc.dmConvId(parts[0], parts[1]);
    const home = pqc.homeServer(parts);
    this.store.ensureConversation(convId, parts, 'dm', home, null, 'active');
    this.event('conversation-open', { handle: other, convId, home, devices: ids.devices.length, safetyNumber: ids.safetyNumber });
    this.emit('update');
    return convId;
  }

  async startGroup({ name, members }) {
    const parts = [this.myHandle, ...(members || []).map((m) => this._asHandle(m))].filter((v, i, a) => a.indexOf(v) === i);
    if (parts.length < 3) throw new Error('a group needs at least 2 other people');
    for (const p of parts) if (!this.isMe(p)) await this.refreshContact(p, true); // pre-resolve keys
    const convId = 'grp_' + require('crypto').randomBytes(16).toString('hex');
    const home = pqc.homeServer(parts);
    this.store.ensureConversation(convId, parts, 'group', home, name || 'group', 'active');
    this.event('group-created', { convId, home, members: parts.length, name });
    this.emit('update');
    return convId;
  }

  async _setMembers(convId, parts, name) {
    const conv = this.store.loadConversation(convId);
    if (!conv || conv.kind !== 'group') throw new Error('not a group');
    await this._fed('POST', conv.homeServer, `/api/conv/${convId}/members`, {
      body: { participants: parts, name: name ?? conv.name },
      auth: true,
      convId,
    });
    conv.participants = parts;
    if (name !== undefined) conv.name = name;
    this.store.saveConversation(conv);
    this.emit('update');
  }
  async addGroupMember(convId, handleInput) {
    const conv = this.store.loadConversation(convId);
    const h = this._asHandle(handleInput);
    if (!conv.participants.includes(h)) {
      await this.refreshContact(h, true);
      await this._setMembers(convId, [...conv.participants, h]);
      this.event('group-add', { convId, handle: h });
    }
  }
  async removeGroupMember(convId, handleInput) {
    const conv = this.store.loadConversation(convId);
    const h = this._asHandle(handleInput);
    await this._setMembers(convId, conv.participants.filter((p) => p !== h));
    this.event('group-remove', { convId, handle: h });
  }

  // -- conversation acceptance (incoming requests) -------------------
  acceptConversation(convId) {
    const conv = this.store.loadConversation(convId);
    if (!conv) throw new Error('unknown conversation');
    conv.status = 'active';
    this.store.saveConversation(conv);
    this.event('conversation-accepted', { convId });
    this.syncOnce('accept').catch(() => {});
    this.emit('update');
  }
  declineConversation(convId) {
    const conv = this.store.loadConversation(convId);
    if (!conv) return;
    conv.status = 'declined';
    this.store.saveConversation(conv);
    this.event('conversation-declined', { convId });
    this.emit('update');
  }

  async gatherRecipients(participants) {
    const out = [];
    for (const h of participants) {
      const ids = await this.refreshContact(h);
      const owner = pqc.normHandle(h);
      for (const d of ids.devices) {
        if (d.deviceId === this.identity.deviceId) continue; // our own sending device already has plaintext
        out.push({ deviceId: d.deviceId, kemPublicKey: d.kemPublicKey, owner });
      }
    }
    return out;
  }

  // -- send ----------------------------------------------------------
  async sendMessage(convId, text) {
    const conv = this.store.loadConversation(convId);
    if (!conv) throw new Error('unknown conversation');
    text = String(text);
    if (!text.trim()) return;

    const seq = (conv.lamport || 0) + 1;
    conv.lamport = seq;
    const prevId = conv.order.length ? conv.order[conv.order.length - 1] : null;
    const recipients = await this.gatherRecipients(conv.participants);

    const envelope = pqc.encryptEnvelope({
      body: { v: 1, kind: 'text', text },
      sender: this.myHandle,
      senderDevice: this.identity.deviceId,
      convId,
      seq,
      prevId,
      recipients,
      sigSecretKey: this.identity.sigSecretKey,
    });

    conv.messages[envelope.msgId] = {
      msgId: envelope.msgId,
      sender: this.myHandle,
      senderDevice: this.identity.deviceId,
      sentAt: envelope.sentAt,
      seq,
      prevId,
      text,
      direction: 'out',
      state: 'pending',
      outRecipients: recipients.filter((r) => r.owner !== this.myHandle).map((r) => r.deviceId),
      deliveries: {},
      serverSeq: null,
    };
    if (!conv.order.includes(envelope.msgId)) conv.order.push(envelope.msgId);
    this.store.saveConversation(conv);
    this.event('encrypted', { convId, msgId: envelope.msgId, forDevices: recipients.length });
    this.emit('update');

    const outbox = this.store.loadOutbox();
    outbox.push({
      convId,
      envelope,
      participants: conv.participants,
      kind: conv.kind,
      name: conv.name || null,
      homeServer: conv.homeServer,
      msgId: envelope.msgId,
    });
    this.store.saveOutbox(outbox);
    await this.flushOutbox();
  }

  async flushOutbox() {
    let outbox = this.store.loadOutbox();
    if (!outbox.length) return;
    const keep = [];
    for (const item of outbox) {
      try {
        const home = item.homeServer || pqc.homeServer(item.participants);
        const { stored } = await this._fed('POST', home, `/api/conv/${item.convId}/messages`, {
          body: { envelope: item.envelope, participants: item.participants, kind: item.kind, name: item.name },
        });
        const conv = this.store.loadConversation(item.convId);
        const rec = conv && conv.messages[item.msgId];
        if (rec) {
          rec.serverSeq = stored.serverSeq;
          rec.deliveries = stored.deliveries || {};
          rec.state = this._deliveredEnough(rec) ? 'delivered' : 'sent';
          this.store.saveConversation(conv);
        }
        this.event('sent', { convId: item.convId, msgId: item.msgId, serverSeq: stored.serverSeq });
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500) {
          const conv = this.store.loadConversation(item.convId);
          if (conv && conv.messages[item.msgId]) {
            conv.messages[item.msgId].state = 'failed';
            conv.messages[item.msgId].error = e.message;
            this.store.saveConversation(conv);
          }
          this.event('send-failed', { convId: item.convId, msgId: item.msgId, error: e.message });
        } else {
          keep.push(item); // transient — retry next cycle
        }
      }
    }
    this.store.saveOutbox(keep);
    this.emit('update');
  }

  _deliveredEnough(rec) {
    const d = rec.deliveries || {};
    if (rec.outRecipients && rec.outRecipients.length) return rec.outRecipients.some((id) => d[id]);
    return Object.keys(d).length > 0;
  }

  // -- sync --------------------------------------------------------
  /**
   * Coalescing scheduler: at most one sync running + one queued. Extra calls
   * (interval tick, WS wake, manual button) fold into the queued run so a wake
   * during a sync is never dropped and never stacks up.
   */
  syncOnce(reason = 'manual') {
    if (this._queued) return this._queued;
    const start = this._running || Promise.resolve();
    this._queued = start
      .catch(() => {})
      .then(() => {
        this._queued = null;
        this._running = this._doSync(reason).finally(() => {
          this._running = null;
        });
        return this._running;
      });
    return this._queued;
  }

  async _doSync(reason) {
    if (!this.api || !this.identity || this.needsLogin) return;
    this.syncing = true;
    this.emit('update');
    try {
      await this.flushOutbox();
      const { conversations } = await this._fed('GET', this.identity.serverUrl, '/api/inbox', { auth: true });
      for (const c of conversations) {
        const existed = !!this.store.loadConversation(c.convId);
        const conv = this.store.ensureConversation(
          c.convId,
          (c.participants || []).map((p) => this._asHandle(p)),
          c.kind,
          this.identity.serverUrl, // there is only one server
          c.name,
          existed ? undefined : 'pending' // someone else started it -> needs accept/decline
        );
        if (conv.status === 'declined') continue;
        if (conv.status === 'pending') {
          this.emit('update');
          continue;
        }
        await this.pullConversation(conv);
      }
      this._forced.clear();
      this.lastSyncAt = Date.now();
      this.lastSyncError = null;
    } catch (e) {
      this.lastSyncError = e.message;
      this.event('sync-error', { reason, error: e.message });
    } finally {
      this.syncing = false;
      this.emit('update');
    }
  }

  _fedConvGet(conv, path, query) {
    return this._fed('GET', conv.homeServer, path, { query, auth: true, convId: conv.convId });
  }

  async pullConversation(conv) {
    const from = Math.max(0, conv.cursorSeq - TRAILING_WINDOW);
    const { messages, order } = await this._fedConvGet(conv, `/api/conv/${conv.convId}/messages`, { sinceSeq: from });
    let maxSeq = conv.cursorSeq;
    let changed = false;

    for (const env of messages) {
      maxSeq = Math.max(maxSeq, env.serverSeq);
      const mine = this.isMe(env.sender) && env.senderDevice === this.identity.deviceId;
      const existing = conv.messages[env.msgId];

      if (mine) {
        if (existing) {
          existing.serverSeq = env.serverSeq;
          existing.deliveries = env.deliveries || {};
          const ns = this._deliveredEnough(existing) ? 'delivered' : 'sent';
          if (ns !== existing.state && existing.state !== 'failed') {
            existing.state = ns;
            changed = true;
          }
        } else {
          conv.messages[env.msgId] = {
            msgId: env.msgId, sender: env.sender, senderDevice: env.senderDevice, sentAt: env.sentAt,
            seq: env.seq, prevId: env.prevId, direction: 'out', state: 'sent', otherDevice: true,
            text: '· sent from another of your devices ·', serverSeq: env.serverSeq, deliveries: env.deliveries || {},
          };
          changed = true;
        }
        continue;
      }

      const forMe = env.recipients.some((r) => r.deviceId === this.identity.deviceId);
      if (!forMe) {
        if (!existing) {
          conv.messages[env.msgId] = {
            msgId: env.msgId, sender: env.sender, sentAt: env.sentAt, seq: env.seq, prevId: env.prevId,
            direction: 'in', state: 'locked', locked: true, text: '🔒 message for another device', serverSeq: env.serverSeq,
          };
          changed = true;
        }
        continue;
      }
      if (existing && existing.text != null && !existing.locked) {
        existing.serverSeq = env.serverSeq;
        continue; // already decrypted
      }

      let verified = false;
      try {
        const sids = await this.refreshContact(env.sender);
        const sdev = sids.devices.find((d) => d.deviceId === env.senderDevice);
        verified = sdev ? pqc.verifyEnvelope(env, sdev.sigPublicKey) : false;
      } catch {}
      let text, ok = true;
      try {
        text = pqc.decryptEnvelope(env, this.identity.deviceId, this.identity.kemSecretKey).body.text;
      } catch (e) {
        text = `[undecryptable: ${e.message}]`;
        ok = false;
      }
      conv.messages[env.msgId] = {
        msgId: env.msgId, sender: env.sender, senderDevice: env.senderDevice, sentAt: env.sentAt,
        seq: env.seq, prevId: env.prevId, direction: 'in',
        state: verified && ok ? 'received' : 'suspect', verified, text, serverSeq: env.serverSeq,
        acked: false,
      };
      changed = true;
      this.event('decrypted', { convId: conv.convId, msgId: env.msgId, from: env.sender, verified });
    }

    // --- delivery acks: retry every cycle until confirmed (server is idempotent) ---
    for (const m of Object.values(conv.messages)) {
      if (m.direction === 'in' && m.acked === false && m.text != null && !m.locked) {
        try {
          await this._fed('POST', conv.homeServer, `/api/conv/${conv.convId}/messages/${m.msgId}/delivered`, {
            body: { deviceId: this.identity.deviceId },
            auth: true,
            convId: conv.convId,
          });
          m.acked = true;
          changed = true;
          this.event('delivered', { convId: conv.convId, msgId: m.msgId });
        } catch {
          /* keep acked:false, retry next sync */
        }
      }
    }

    // --- reconcile ordering to the server's canonical order -------------
    const tail = conv.order.filter((id) => !order.includes(id) && conv.messages[id]);
    const nextOrder = [...order.filter((id) => conv.messages[id]), ...tail];
    if (nextOrder.join('|') !== conv.order.join('|')) {
      conv.order = nextOrder;
      changed = true;
      this.event('reordered', { convId: conv.convId, length: nextOrder.length });
    }
    conv.cursorSeq = maxSeq;
    conv.lastReconciledAt = Date.now();
    this.store.saveConversation(conv);
    if (changed) this.emit('update');
  }

  // -- views for the renderer --------------------------------------
  _displayState(m) {
    if (m.direction === 'out') {
      if (m.state === 'failed') return 'failed';
      if (m.state === 'delivered') return 'delivered';
      return 'undelivered'; // pending | sent | otherDevice
    }
    if (m.locked) return 'locked';
    if (m.state === 'suspect') return 'suspect';
    return 'received';
  }
  /** "@alice" if same server as me, else "alice@host" (scheme stripped) */
  prettyHandle(h) {
    try {
      const { username, server } = pqc.parseHandle(this._asHandle(h));
      return server === pqc.parseHandle(this.myHandle).server
        ? '@' + username
        : username + '@' + server.replace(/^https?:\/\//, '');
    } catch {
      return String(h);
    }
  }
  getConversationView(convId) {
    const conv = this.store.loadConversation(convId);
    if (!conv) return null;
    const seen = new Set();
    const messages = conv.order
      .filter((id) => (seen.has(id) ? false : seen.add(id)))
      .map((id) => conv.messages[id])
      .filter(Boolean)
      .map((m) => ({
        msgId: m.msgId,
        mine: m.direction === 'out',
        sender: this.prettyHandle(m.sender),
        text: m.text,
        sentAt: m.sentAt,
        serverSeq: m.serverSeq,
        seq: m.seq,
        state: m.state,
        display: this._displayState(m),
        verified: m.verified,
        deliveries: m.deliveries ? Object.keys(m.deliveries).length : 0,
        error: m.error,
      }));
    return {
      convId,
      participants: conv.participants.map((p) => this.prettyHandle(p)),
      participantHandles: conv.participants,
      kind: conv.kind,
      name: conv.name || null,
      status: conv.status || 'active',
      homeServer: conv.homeServer || null,
      homeIsMine: conv.homeServer ? pqc.normServer(conv.homeServer) === pqc.parseHandle(this.myHandle).server : true,
      lastReconciledAt: conv.lastReconciledAt,
      cursorSeq: conv.cursorSeq,
      messages,
    };
  }
  listConversationsView() {
    return this.store
      .listConversationIds()
      .map((id) => this.store.loadConversation(id))
      .filter(Boolean)
      .map((conv) => {
        const v = this.getConversationView(conv.convId);
        const last = v.messages[v.messages.length - 1];
        const others = conv.participants.filter((p) => !this.isMe(p)).map((p) => this.prettyHandle(p));
        return {
          convId: conv.convId,
          kind: conv.kind,
          status: conv.status || 'active',
          name: conv.name || null,
          title: conv.kind === 'group' ? conv.name || others.join(', ') : others.join(', ') || 'you',
          subtitle: conv.kind === 'group' ? `${conv.participants.length} people` : others.join(', '),
          requestFrom: (conv.status || 'active') === 'pending' ? (others[0] || 'someone') : null,
          participants: v.participants,
          homeServer: conv.homeServer || null,
          messageCount: v.messages.length,
          lastText: last ? last.text : '',
          lastAt: last ? last.sentAt : conv.lastReconciledAt || conv.createdAt,
          lastMine: last ? last.mine : false,
          lastDisplay: last ? last.display : null,
        };
      })
      .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  }
}

module.exports = { Engine };
