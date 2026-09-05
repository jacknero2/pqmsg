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
    // one attachment must fit comfortably inside the server's JSON body
    // limit once base64-expanded (+~33%) alongside the KEM slots.
    this.MAX_ATTACHMENT = Engine.MAX_ATTACHMENT;
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
    // Bumped by logout()/switchAccount() to invalidate any in-flight resume
    // retry — without this, a stale retry timer from a dead-server session
    // can fire after the user has already logged out (or switched to a
    // brand-new account) and clobber needsLogin back to false, which looks
    // like the UI randomly bouncing between the login screen and the app.
    this._resumeGen = 0;
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
    // Trust tokens are stored per-account (see store.js) — peek at this
    // username's own saved config without creating or activating its
    // folder; that only happens once login actually succeeds.
    const trustToken = (this.store.peekAppConfig(username).trust || {})[this._trustKey(serverUrl)] || null;

    const api = new Api(serverUrl);
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

  /**
   * shared tail of both login paths: (re)enroll this device and start syncing.
   *
   * Activating the account here — only once the password + 2FA challenge has
   * actually succeeded — is what gates access to its local folder: there is
   * no other place in the app that points the store at a given username's
   * data. If this exact username has logged in on this device before, its
   * saved identity (device keys, deviceId) is reused rather than minted
   * fresh, so it keeps recognizing this as the same device and keeps the
   * ability to decrypt its own retained message history.
   */
  async _finishLogin({ serverUrl, username, deviceName, token }) {
    const api = new Api(serverUrl, token);
    const returning = this.store.hasLocalAccount(username);
    this.store.setActiveAccount(username);
    let id = this.store.loadIdentity();
    if (!id) {
      const keys = pqc.generateIdentity();
      id = {
        username,
        deviceName: deviceName || `${os.hostname()} (${this.store.profile})`,
        ...keys,
        deviceId: pqc.deviceIdFromSigPub(keys.sigPublicKey),
      };
    }
    id.username = username;
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
    this.event('enroll', { username, deviceId, deviceName: id.deviceName, returning });
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
    const gen = ++this._resumeGen;
    await this._tryResume(0, gen);
  }

  /**
   * A saved session should survive network trouble, not just outlive its own
   * TTL — a DNS blip or a dead tunnel URL is not the same thing as "your login
   * expired," and treating them the same used to force a full password + 2FA
   * relogin on every transient failure. Only a real 401/403 means the token
   * itself is invalid; anything else (fetch failure, 5xx, timeout) keeps the
   * existing session and retries with backoff instead.
   *
   * `gen` guards against a stale retry: if the user logs out or switches
   * accounts while a retry is scheduled (e.g. because this identity points at
   * a server that's gone forever), that old timer must not fire later and
   * silently flip needsLogin back to false out from under a fresh session —
   * which looked exactly like the UI randomly bouncing between screens.
   */
  async _tryResume(attempt, gen) {
    if (gen !== this._resumeGen) return; // superseded by a logout/switch/newer resume
    try {
      await this.api.myDevices(); // validates token
      if (gen !== this._resumeGen) return; // superseded while this call was in flight
      this.needsLogin = false;
      this.offline = false;
      if (this._resumeRetryTimer) clearTimeout(this._resumeRetryTimer);
      this._resumeRetryTimer = null;
      this.startLoops();
      this.connectWs();
      this.syncOnce('resume').catch(() => {});
    } catch (e) {
      if (gen !== this._resumeGen) return; // superseded while this call was in flight
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
      this._resumeRetryTimer = setTimeout(() => this._tryResume(attempt + 1, gen), delay);
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
    this._resumeGen++; // invalidate any pending resume retry for this session
    if (this._resumeRetryTimer) clearTimeout(this._resumeRetryTimer);
    this._resumeRetryTimer = null;
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

  /**
   * Step away from the current account and return to a blank login screen,
   * so a different account can log in on this same install. This does NOT
   * delete anything: the current account's keys and locally cached message
   * history stay exactly where they are, in its own folder, and the only
   * way back into them is that account's own password + 2FA — logging in
   * again as any account that has used this device before reunites it with
   * its own retained device identity and history via _finishLogin.
   */
  switchAccount() {
    this._resumeGen++;
    if (this._resumeRetryTimer) clearTimeout(this._resumeRetryTimer);
    this._resumeRetryTimer = null;
    this.stopLoops();
    if (this.ws) try { this.ws.close(); } catch {}
    this.ws = null;
    this.connected = false;
    this.store.setActiveAccount(null);
    this.identity = null;
    this.api = null;
    this._pending2fa = null;
    this.needsLogin = true;
    this.offline = false;
    this.event('switch-account', {});
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

  /**
   * Every enrolled device of every participant — INCLUDING this sending
   * device. We used to skip our own device ("it already has plaintext"),
   * but that made our own sent messages impossible to recover from the
   * envelope: if the local plaintext record was ever lost, the message
   * showed forever as "sent from another device". Wrapping a copy for
   * ourselves costs one extra KEM slot and makes our history self-healing.
   */
  async gatherRecipients(participants) {
    const out = [];
    for (const h of participants) {
      const ids = await this.refreshContact(h);
      const owner = pqc.normHandle(h);
      for (const d of ids.devices) {
        out.push({ deviceId: d.deviceId, kemPublicKey: d.kemPublicKey, owner });
      }
    }
    // de-dupe (a participant list can repeat our own handle in odd cases)
    const seen = new Set();
    return out.filter((r) => (seen.has(r.deviceId) ? false : seen.add(r.deviceId)));
  }

  // -- send ----------------------------------------------------------
  /**
   * Encrypt one message body, record it locally, queue it, and flush.
   * `body` is the plaintext JSON payload (kind: text | edit | reaction | file).
   * `local` describes how to reflect it in the local store immediately:
   *   - { bubble: {...} }  -> a new visible message record (text / file)
   *   - { apply: fn(conv) } -> mutate existing records (edit / reaction), no new bubble
   */
  async _sendBody(convId, body, local) {
    const conv = this.store.loadConversation(convId);
    if (!conv) throw new Error('unknown conversation');

    const seq = (conv.lamport || 0) + 1;
    conv.lamport = seq;
    const prevId = conv.order.length ? conv.order[conv.order.length - 1] : null;
    const recipients = await this.gatherRecipients(conv.participants);

    const envelope = pqc.encryptEnvelope({
      body,
      sender: this.myHandle,
      senderDevice: this.identity.deviceId,
      convId,
      seq,
      prevId,
      recipients,
      sigSecretKey: this.identity.sigSecretKey,
    });

    const peerDevices = recipients.filter((r) => r.owner !== this.myHandle).map((r) => r.deviceId);
    if (local.bubble) {
      conv.messages[envelope.msgId] = {
        msgId: envelope.msgId,
        sender: this.myHandle,
        senderDevice: this.identity.deviceId,
        sentAt: envelope.sentAt,
        seq,
        prevId,
        direction: 'out',
        state: 'pending',
        outRecipients: peerDevices,
        deliveries: {},
        serverSeq: null,
        ...local.bubble,
      };
      if (!conv.order.includes(envelope.msgId)) conv.order.push(envelope.msgId);
    } else {
      // control message (edit / reaction): still ordered by the server, but
      // never rendered as its own bubble — track it so we can show delivery
      // state on the message it targets.
      conv.meta = conv.meta || {};
      conv.controlMsgs = conv.controlMsgs || {};
      conv.controlMsgs[envelope.msgId] = {
        msgId: envelope.msgId, kind: body.kind, targetId: body.targetId,
        senderDevice: this.identity.deviceId, sentAt: envelope.sentAt,
        outRecipients: peerDevices, deliveries: {}, state: 'pending', serverSeq: null,
      };
      if (!conv.order.includes(envelope.msgId)) conv.order.push(envelope.msgId);
    }
    if (local.apply) local.apply(conv);
    this.store.saveConversation(conv);
    this.event('encrypted', { convId, msgId: envelope.msgId, forDevices: recipients.length, kind: body.kind });
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
      control: !local.bubble,
      targetId: body.targetId || null,
    });
    this.store.saveOutbox(outbox);
    await this.flushOutbox();
    return envelope.msgId;
  }

  async sendMessage(convId, text, opts = {}) {
    text = String(text == null ? '' : text);
    if (!text.trim() && !opts.replyTo) return;
    const body = { v: 1, kind: 'text', text };
    if (opts.replyTo) body.replyTo = this._replyStub(convId, opts.replyTo);
    return this._sendBody(convId, body, {
      bubble: { text, replyTo: body.replyTo || null },
    });
  }

  /** Edit one of your own already-sent messages in place (no "edited" marker shown). */
  async editMessage(convId, targetId, text) {
    const conv = this.store.loadConversation(convId);
    if (!conv) throw new Error('unknown conversation');
    const target = conv.messages[targetId];
    if (!target) throw new Error('no such message');
    if (target.direction !== 'out' || !this.isMe(target.sender)) throw new Error('can only edit your own messages');
    text = String(text == null ? '' : text);
    if (!text.trim()) return;
    return this._sendBody(convId, { v: 1, kind: 'edit', targetId, text }, {
      apply: (c) => {
        const m = c.messages[targetId];
        if (m) {
          m.text = text;
          m.editedLocallyAt = Date.now();
          m.state = 'pending'; // red again until the edit envelope is delivered
          m.editPending = true;
        }
      },
    });
  }

  /**
   * Send a file (image or otherwise) as an attachment. The bytes travel
   * inside the encrypted envelope body — the server never sees them in the
   * clear, same as message text. Capped so one message stays well under
   * the server's JSON body limit.
   */
  async sendAttachment(convId, file, opts = {}) {
    const conv = this.store.loadConversation(convId);
    if (!conv) throw new Error('unknown conversation');
    const name = String(file.name || 'file');
    const dataB64 = String(file.dataB64 || '');
    const size = file.size || Buffer.from(dataB64, 'base64').length;
    if (size > Engine.MAX_ATTACHMENT) {
      throw new Error(`file too large — ${(size / 1048576).toFixed(1)} MB, limit is ${Engine.MAX_ATTACHMENT / 1048576} MB`);
    }
    const isImage = !!file.isImage || /^image\//.test(file.mime || '');
    const caption = String(opts.caption || '');
    const attachment = { name, mime: file.mime || 'application/octet-stream', size, isImage, dataB64 };
    const body = { v: 1, kind: 'file', ...attachment, text: caption };
    if (opts.replyTo) body.replyTo = this._replyStub(convId, opts.replyTo);
    return this._sendBody(convId, body, { bubble: { text: caption, attachment, replyTo: body.replyTo || null } });
  }

  /** Toggle an emoji reaction on any message in the conversation. */
  async reactToMessage(convId, targetId, emoji) {
    const conv = this.store.loadConversation(convId);
    if (!conv) throw new Error('unknown conversation');
    if (!conv.messages[targetId]) throw new Error('no such message');
    emoji = String(emoji || '').trim();
    if (!emoji) return;
    const me = this.myHandle;
    const cur = (conv.messages[targetId].reactions || {})[emoji] || [];
    const op = cur.includes(me) ? 'remove' : 'add';
    return this._sendBody(convId, { v: 1, kind: 'reaction', targetId, emoji, op }, {
      apply: (c) => this._applyReaction(c, { targetId, emoji, op, sender: me }),
    });
  }

  _applyReaction(conv, { targetId, emoji, op, sender }) {
    const m = conv.messages[targetId];
    if (!m) return;
    m.reactions = m.reactions || {};
    const list = new Set(m.reactions[emoji] || []);
    if (op === 'remove') list.delete(sender);
    else list.add(sender);
    if (list.size) m.reactions[emoji] = [...list];
    else delete m.reactions[emoji];
  }

  /** Compact quote of a message, embedded in a reply's body + local record. */
  _replyStub(convId, msgId) {
    const conv = this.store.loadConversation(convId);
    const m = conv && conv.messages[msgId];
    if (!m) return null;
    const t = m.text != null ? String(m.text) : (m.attachment ? `📎 ${m.attachment.name}` : '');
    return { msgId, sender: m.sender, textPreview: t.slice(0, 140) };
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
        const rec = conv && (conv.messages[item.msgId] || (conv.controlMsgs && conv.controlMsgs[item.msgId]));
        if (rec) {
          rec.serverSeq = stored.serverSeq;
          rec.deliveries = stored.deliveries || {};
          rec.state = this._deliveredEnough(rec) ? 'delivered' : 'sent';
          if (item.control && rec.state !== 'pending') this._clearEditPending(conv, item.targetId, rec);
          this.store.saveConversation(conv);
        }
        this.event('sent', { convId: item.convId, msgId: item.msgId, serverSeq: stored.serverSeq, control: !!item.control });
      } catch (e) {
        if (e.status && e.status >= 400 && e.status < 500) {
          const conv = this.store.loadConversation(item.convId);
          const rec = conv && (conv.messages[item.msgId] || (conv.controlMsgs && conv.controlMsgs[item.msgId]));
          if (rec) {
            rec.state = 'failed';
            rec.error = e.message;
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

  /** An edit is only honored if it comes from the same account that sent the original. */
  _senderMayEdit(editSender, targetMsg) {
    try {
      return pqc.normHandle(editSender) === pqc.normHandle(targetMsg.sender);
    } catch {
      return false;
    }
  }

  /** Once an edit's own envelope is delivered, the edited bubble stops being red. */
  _clearEditPending(conv, targetId, controlRec) {
    if (!targetId) return;
    const m = conv.messages[targetId];
    if (!m || !m.editPending) return;
    // only clear if THIS control message is the latest edit we issued for it
    m.editPending = false;
    m.deliveries = controlRec.deliveries || m.deliveries || {};
    m.outRecipients = controlRec.outRecipients || m.outRecipients;
    m.state = this._deliveredEnough(m) ? 'delivered' : 'sent';
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

    conv.controlMsgs = conv.controlMsgs || {};
    for (const env of messages) {
      maxSeq = Math.max(maxSeq, env.serverSeq);
      const fromMyDevice = this.isMe(env.sender) && env.senderDevice === this.identity.deviceId;
      const forMe = env.recipients.some((r) => r.deviceId === this.identity.deviceId);
      const existing = conv.messages[env.msgId];
      const existingCtl = conv.controlMsgs[env.msgId];

      // ---- a control message we've already applied: just refresh its
      //      delivery state, never fall through to bubble materialisation ----
      if (existingCtl && existingCtl.applied) {
        if (fromMyDevice) {
          existingCtl.deliveries = env.deliveries || existingCtl.deliveries || {};
          existingCtl.serverSeq = env.serverSeq;
          existingCtl.state = this._deliveredEnough(existingCtl) ? 'delivered' : 'sent';
          this._clearEditPending(conv, existingCtl.targetId, existingCtl);
        }
        continue;
      }

      // ---- a message we can open (ours, or addressed to us) --------------
      if (forMe) {
        // signature check against the sender device's registered key
        let verified = false;
        try {
          const sids = await this.refreshContact(env.sender);
          const sdev = sids.devices.find((d) => d.deviceId === env.senderDevice);
          verified = sdev ? pqc.verifyEnvelope(env, sdev.sigPublicKey) : false;
        } catch {}

        let body = null, decErr = null;
        // don't re-decrypt something already fully materialised
        const alreadyDone = existing && existing.text != null && !existing.locked;
        if (!alreadyDone) {
          try {
            body = pqc.decryptEnvelope(env, this.identity.deviceId, this.identity.kemSecretKey).body;
          } catch (e) {
            decErr = e;
          }
        }

        if (body && (body.kind === 'edit' || body.kind === 'reaction')) {
          // control message: apply its effect, never render it as a bubble
          if (body.kind === 'edit') {
            const t = conv.messages[body.targetId];
            if (t && this._senderMayEdit(env.sender, t)) {
              t.text = String(body.text == null ? '' : body.text);
              if (fromMyDevice) { t.editPending = false; }
              changed = true;
            }
          } else {
            this._applyReaction(conv, { targetId: body.targetId, emoji: body.emoji, op: body.op, sender: pqc.normHandle(env.sender) });
            changed = true;
          }
          conv.controlMsgs[env.msgId] = {
            ...(existingCtl || {}),
            msgId: env.msgId, kind: body.kind, targetId: body.targetId,
            senderDevice: env.senderDevice, sentAt: env.sentAt, serverSeq: env.serverSeq,
            deliveries: env.deliveries || {}, applied: true,
            outRecipients: existingCtl ? existingCtl.outRecipients : undefined,
            acked: existingCtl ? existingCtl.acked : (fromMyDevice ? undefined : false),
            state: fromMyDevice ? (this._deliveredEnough({ deliveries: env.deliveries || {}, outRecipients: existingCtl && existingCtl.outRecipients }) ? 'delivered' : 'sent') : 'received',
          };
          if (fromMyDevice) this._clearEditPending(conv, body.targetId, conv.controlMsgs[env.msgId]);
          continue;
        }

        if (existing && existing.text != null && !existing.locked) {
          // already have it — just refresh server-assigned + delivery fields
          existing.serverSeq = env.serverSeq;
          if (fromMyDevice) {
            existing.deliveries = env.deliveries || {};
            if (!existing.editPending && existing.state !== 'failed') {
              const ns = this._deliveredEnough(existing) ? 'delivered' : 'sent';
              if (ns !== existing.state) { existing.state = ns; changed = true; }
            }
          }
          continue;
        }

        // materialise a normal (text/file) message
        const b = body || {};
        const rec = {
          msgId: env.msgId, sender: env.sender, senderDevice: env.senderDevice, sentAt: env.sentAt,
          seq: env.seq, prevId: env.prevId,
          direction: fromMyDevice ? 'out' : 'in',
          serverSeq: env.serverSeq,
          verified,
          replyTo: b.replyTo || null,
        };
        if (decErr) {
          rec.text = `[undecryptable: ${decErr.message}]`;
          rec.state = 'suspect';
        } else if (b.kind === 'file') {
          rec.attachment = { name: b.name, mime: b.mime, size: b.size, isImage: !!b.isImage, dataB64: b.dataB64 };
          rec.text = b.text || '';
          rec.state = fromMyDevice ? 'sent' : verified ? 'received' : 'suspect';
        } else {
          rec.text = String(b.text == null ? '' : b.text);
          rec.state = fromMyDevice ? 'sent' : verified ? 'received' : 'suspect';
        }
        if (!fromMyDevice) rec.acked = false;
        if (fromMyDevice) {
          rec.deliveries = env.deliveries || {};
          rec.state = this._deliveredEnough(rec) ? 'delivered' : 'sent';
        }
        conv.messages[env.msgId] = rec;
        changed = true;
        if (!fromMyDevice) this.event('decrypted', { convId: conv.convId, msgId: env.msgId, from: env.sender, verified });
        continue;
      }

      // ---- not addressed to this device -------------------------------
      if (!existing && !existingCtl) {
        conv.messages[env.msgId] = {
          msgId: env.msgId, sender: env.sender, sentAt: env.sentAt, seq: env.seq, prevId: env.prevId,
          direction: this.isMe(env.sender) ? 'out' : 'in', state: 'locked', locked: true,
          text: this.isMe(env.sender) ? '· sent from another of your devices ·' : '🔒 message for another device',
          serverSeq: env.serverSeq,
        };
        changed = true;
      } else if (existing) {
        existing.serverSeq = env.serverSeq;
      }
    }

    // --- delivery acks: retry every cycle until confirmed (server is idempotent) ---
    // normal inbound bubbles, plus inbound control messages (peer edits /
    // reactions) so the peer's own edit/reaction can flip to "delivered".
    const ackTargets = [
      ...Object.values(conv.messages).filter((m) => m.direction === 'in' && m.acked === false && m.text != null && !m.locked),
      ...Object.values(conv.controlMsgs).filter((c) => c.applied && c.state === 'received' && c.acked === false),
    ];
    for (const m of ackTargets) {
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

    // --- reconcile ordering to the server's canonical order -------------
    const known = (id) => conv.messages[id] || (conv.controlMsgs && conv.controlMsgs[id]);
    const tail = conv.order.filter((id) => !order.includes(id) && known(id));
    const nextOrder = [...order.filter(known), ...tail];
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
      if (m.editPending) return 'undelivered'; // edited, edit not yet delivered -> red again
      if (m.state === 'delivered') return 'delivered';
      return 'undelivered'; // pending | sent | otherDevice
    }
    if (m.locked) return 'locked';
    if (m.state === 'suspect') return 'suspect';
    return 'received';
  }
  _reactionsView(m) {
    const r = m.reactions || {};
    return Object.keys(r)
      .filter((e) => (r[e] || []).length)
      .map((emoji) => ({
        emoji,
        count: r[emoji].length,
        mine: r[emoji].some((h) => this.isMe(h)),
        who: r[emoji].map((h) => this.prettyHandle(h)),
      }));
  }
  _replyView(rt) {
    if (!rt) return null;
    return {
      msgId: rt.msgId,
      who: this.isMe(rt.sender) ? 'You' : this.prettyHandle(rt.sender),
      mine: this.isMe(rt.sender),
      textPreview: rt.textPreview || '',
    };
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
        reactions: this._reactionsView(m),
        replyTo: this._replyView(m.replyTo),
        attachment: m.attachment
          ? { name: m.attachment.name, mime: m.attachment.mime, size: m.attachment.size, isImage: !!m.attachment.isImage,
              dataB64: m.attachment.dataB64 || null,
              dataUrl: m.attachment.isImage && m.attachment.dataB64 ? `data:${m.attachment.mime};base64,${m.attachment.dataB64}` : null }
          : null,
        canEdit: m.direction === 'out' && !m.locked && !m.attachment && m.text != null,
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

Engine.MAX_ATTACHMENT = 12 * 1024 * 1024; // 12 MB raw -> ~16 MB base64

module.exports = { Engine };
