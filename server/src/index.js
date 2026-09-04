'use strict';
/*
 * pqmsg server — a single, self-contained chat server (no federation, no
 * registry: every account lives here).
 * ------------
 *  - IDS  : per-account device public keys (ML-KEM-1024 + ML-DSA-87)
 *  - Store : encrypted conversation folders, one per conversation, messages
 *            numbered in canonical (ingest / commit) order
 *  - Accounts + enrollment
 *  - WebSocket presence + "wake" pushes (a latency hint; clients still poll)
 *  - Dashboard (server/public) with a read-only, ciphertext-only view
 */

const http = require('http');
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const { config } = require('./config');
const { Presence } = require('./presence');
const { createStore } = require('../../shared/store');
const proto = require('../../shared/protocol');
const pqc = require('../../shared/crypto');
const { createMailer, maskEmail } = require('../../shared/email');
const { ChallengeStore, issueTrust, checkTrust } = require('../../shared/twofa');
const diagnostics = require('../../shared/diagnostics');
const PKG_VERSION = require('../../package.json').version;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token, X-PQMSG-Auth');
  res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const presence = new Presence();
let store;
let SECRETS;
let mailer = createMailer({}); // replaced with configured transport at boot
const challenges = new ChallengeStore();
/** surfaced 2FA codes when email isn't configured (dev mode) — id -> {code, at} */
const devCodes = new Map();
function recordDevCode(id, code) {
  devCodes.set(id, { code, at: Date.now() });
  if (devCodes.size > 50) devCodes.delete(devCodes.keys().next().value);
}

async function sendCode({ id, code, to, subject }) {
  if (mailer.mode === 'smtp') {
    await mailer.send({ to, subject, text: `Your pqmsg verification code is ${code}\n\nIt expires in 10 minutes. If you did not request this, ignore this email.` });
    return { dev: false };
  }
  recordDevCode(id, code);
  console.log(`\n  [2FA · email not configured] code for ${to}: \x1b[1m${code}\x1b[0m\n`);
  presence.log('twofa-dev', { to: maskEmail(to), code });
  return { dev: true, devCode: code };
}

/** Best-effort error report — never throws, no-ops unless the operator opted in. */
function reportDiag({ component, kind, message, stack, context }) {
  if (!config.sendDiagnostics || !config.diagToken || !config.diagRepo) return;
  diagnostics
    .reportIssue({ token: config.diagToken, repo: config.diagRepo, component, kind, message, stack, context })
    .catch(() => {});
}
const _diagBucket = new Map(); // ip -> { count, resetAt }
function diagRateLimited(ip) {
  const now = Date.now();
  const b = _diagBucket.get(ip);
  if (!b || now > b.resetAt) {
    _diagBucket.set(ip, { count: 1, resetAt: now + 60_000 });
    if (_diagBucket.size > 5000) _diagBucket.delete(_diagBucket.keys().next().value);
    return false;
  }
  b.count++;
  return b.count > 10; // max 10 reports/min per source IP
}

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
/** Every account's handle is username@<this server> — there is only one server. */
function myHandle(username) {
  return pqc.formatHandle({ username, server: config.serverPublicUrl });
}
/** Local-only IDS lookup (no other servers exist to ask). */
async function resolveIds(handleStr) {
  const { username } = pqc.parseHandle(handleStr);
  const ids = await store.getIds(username);
  if (!ids) return null;
  return { ...ids, safetyNumber: pqc.safetyNumber((ids.devices || []).map((d) => d.sigPublicKey)) };
}

function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
  const claims = tok && proto.verifyToken(SECRETS.tokenSecret, tok);
  if (!claims) return res.status(401).json({ error: 'unauthorized' });
  req.user = claims.username;
  next();
}
function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
// effective admin token: the env one if given, else the auto one in server secrets
const adminTokenValue = () => config.adminToken || (SECRETS && SECRETS.adminToken) || '';
function adminOk(given, req) {
  if (given && given === adminTokenValue()) return true;
  // loopback bypass — UNSAFE behind a proxy/tunnel (every req looks like 127.0.0.1),
  // so it is disabled when PQMSG_PUBLIC is set.
  return !config.public && isLoopback(req);
}
function admin(req, res, next) {
  if (adminOk(req.get('x-admin-token') || req.query.admin, req)) return next();
  return res.status(403).json({ error: 'admin auth required — append ?admin=<token> (see server startup log)' });
}
const wrap = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((e) => {
    res.status(e.status || 500).json({ error: e.message || 'server error' });
  });

const GROUP_ID_RE = /^grp_[0-9a-f]{32}$/;
/** DMs have a deterministic id from the two handles; groups get any grp_<hex> minted at creation. */
function convIdOk(convId, kind, handles) {
  if (kind === 'group' || handles.length > 2) return GROUP_ID_RE.test(convId);
  return convId === pqc.dmConvId(handles[0], handles[1]);
}

/**
 * Resolve who is calling, by ML-DSA device signature — proves possession of a
 * specific enrolled device's secret key, which a bearer token alone does not.
 *   `X-PQMSG-Auth: <b64 JSON {handle, deviceId, ts, sig}>`
 *   `Authorization: Bearer <token>` — falls back to account-level auth (no
 *   device binding) if no signed header is present.
 * Sets req.actor = { handle, deviceId|null } or leaves it null.
 */
async function authActor(req, res, next) {
  try {
    const hdr = req.get('x-pqmsg-auth');
    if (hdr) {
      let a;
      try {
        a = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8'));
      } catch {
        return res.status(400).json({ error: 'bad_auth_header' });
      }
      if (!a.handle || !a.deviceId || typeof a.ts !== 'number' || !a.sig) return res.status(400).json({ error: 'bad_auth_header' });
      if (Math.abs(Date.now() - a.ts) > 300000) return res.status(401).json({ error: 'stale_auth' });
      const ids = await resolveIds(a.handle);
      const dev = ids && (ids.devices || []).find((d) => d.deviceId === a.deviceId);
      const challenge = { m: 'pqmsg-auth', method: req.method, path: req.path, convId: req.params.convId || null, deviceId: a.deviceId, ts: a.ts };
      if (!dev || !pqc.verifyRequest(challenge, a.sig, dev.sigPublicKey)) return res.status(401).json({ error: 'bad_auth_sig' });
      req.actor = { handle: pqc.normHandle(a.handle), deviceId: a.deviceId };
      return next();
    }
    const h = req.get('authorization') || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    const claims = tok && proto.verifyToken(SECRETS.tokenSecret, tok);
    if (claims) {
      req.actor = { handle: myHandle(claims.username), deviceId: null };
      return next();
    }
    req.actor = null;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
const requireActor = (req, res, next) => (req.actor ? next() : res.status(401).json({ error: 'unauthorized' }));

// --------------------------------------------------------------------------
// auth + enrollment
// --------------------------------------------------------------------------
app.post(
  '/api/auth/register',
  wrap(async (req, res) => {
    const username = proto.normUser(req.body.username);
    const password = String(req.body.password || '');
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!proto.USERNAME_RE.test(username)) throw Object.assign(new Error('bad username'), { status: 400 });
    if (password.length < 6) throw Object.assign(new Error('password too short'), { status: 400 });
    if (!EMAIL_RE.test(email)) throw Object.assign(new Error('a valid email is required (used for login codes)'), { status: 400 });
    const { salt, hash } = proto.hashPassword(password);
    await store.createAccount({ username, salt, hash, email });
    presence.log('register', { username, email: maskEmail(email) });
    res.json({ ok: true, username });
  })
);

// step 1: password -> emailed code (or straight to a token if this device is trusted)
app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    const username = proto.normUser(req.body.username);
    const password = String(req.body.password || '');
    const acct = await store.getAccount(username);
    if (!acct || !proto.verifyPassword(password, acct.salt, acct.hash)) {
      throw Object.assign(new Error('invalid credentials'), { status: 401 });
    }
    if (req.body.trustToken && checkTrust(SECRETS.trustSecret, req.body.trustToken, username)) {
      const token = proto.issueToken(SECRETS.tokenSecret, { username });
      presence.log('login', { username, via: 'trusted-device' });
      return res.json({ token, username });
    }
    if (!acct.email) {
      // legacy account with no email on file — allow through, no 2FA possible
      const token = proto.issueToken(SECRETS.tokenSecret, { username });
      return res.json({ token, username, note: 'no email on file — 2FA skipped' });
    }
    const { id, code } = challenges.create('login', username, { username });
    const surf = await sendCode({ id, code, to: acct.email, subject: 'pqmsg login code' });
    presence.log('login-code', { username, email: maskEmail(acct.email), dev: surf.dev });
    res.json({ needs2fa: true, challengeId: id, email: maskEmail(acct.email), ...surf });
  })
);

// step 2: code -> session token (+ optional 30-day trusted-device token)
app.post(
  '/api/auth/verify',
  wrap(async (req, res) => {
    const r = challenges.verify(String(req.body.challengeId || ''), String(req.body.code || ''));
    if (!r.ok) {
      const status = r.error === 'bad_code' ? 401 : r.error === 'too_many_attempts' ? 429 : 400;
      throw Object.assign(new Error(r.error), { status, attemptsLeft: r.attemptsLeft });
    }
    const username = r.meta.username;
    const token = proto.issueToken(SECRETS.tokenSecret, { username });
    const out = { token, username };
    if (req.body.rememberDevice) out.trustToken = issueTrust(SECRETS.trustSecret, username, config.trustedDeviceDays);
    presence.log('login', { username, via: '2fa' });
    res.json(out);
  })
);

app.post(
  '/api/devices',
  auth,
  wrap(async (req, res) => {
    const { deviceName, kemPublicKey, sigPublicKey, attestation } = req.body;
    if (!deviceName || !kemPublicKey || !sigPublicKey || !attestation) {
      throw Object.assign(new Error('missing device fields'), { status: 400 });
    }
    const device = { deviceId: pqc.deviceIdFromSigPub(sigPublicKey), deviceName, kemPublicKey, sigPublicKey, attestation };
    // prove possession of the signing secret + bind keys to this username
    const ok = pqc.verifyEnrollment({ username: req.user, deviceName, kemPublicKey, sigPublicKey, attestation });
    if (!ok) throw Object.assign(new Error('enrollment attestation invalid'), { status: 400 });
    const saved = await store.addDevice(req.user, device);
    presence.log('enroll', { username: req.user, deviceName, deviceId: saved.deviceId });
    res.json({ deviceId: saved.deviceId, addedAt: saved.addedAt });
  })
);

app.get(
  '/api/devices',
  auth,
  wrap(async (req, res) => {
    const ids = await store.getIds(req.user);
    res.json(ids || { username: req.user, devices: [] });
  })
);

// public: the IDS is device *public* keys + a safety number
app.get(
  '/api/ids/:username',
  wrap(async (req, res) => {
    const ids = await store.getIds(proto.normUser(req.params.username));
    if (!ids) throw Object.assign(new Error('no such user'), { status: 404 });
    ids.safetyNumber = pqc.safetyNumber(ids.devices.map((d) => d.sigPublicKey));
    res.json(ids);
  })
);

// --------------------------------------------------------------------------
// messaging
// --------------------------------------------------------------------------
function wakeLocal(handles, convId, latestSeq) {
  const usernames = new Set(handles.map((h) => pqc.parseHandle(h).username));
  for (const { ws, username } of liveClients.values()) {
    if (usernames.has(username) && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'wake', convId, latestSeq, serverTime: Date.now() }));
    }
  }
}

app.post(
  '/api/conv/:convId/messages',
  wrap(async (req, res) => {
    // No bearer token here on purpose: the ML-DSA envelope signature IS the
    // authentication, verified below against the sender device's registered
    // key — stronger than a bearer token (non-repudiable, per-device, per-message).
    const { envelope, participants, kind, name } = req.body;
    if (!envelope || !Array.isArray(participants) || participants.length < 2) {
      throw Object.assign(new Error('need envelope + participants[]'), { status: 400 });
    }
    let parts;
    try {
      parts = participants.map(pqc.normHandle);
    } catch {
      throw Object.assign(new Error('bad participants'), { status: 400 });
    }
    const convId = req.params.convId;
    const isGroup = kind === 'group' || parts.length > 2;

    if (!parts.includes(pqc.normHandle(envelope.sender))) {
      throw Object.assign(new Error('sender is not a participant'), { status: 403 });
    }
    if (!convIdOk(convId, kind, parts)) {
      throw Object.assign(new Error('convId does not match the conversation'), { status: 400 });
    }
    // for an existing group, the sender must be a current member (membership is mutable)
    const existing = await store.getConversationMeta(convId);
    if (isGroup && existing && !(existing.participants || []).map(pqc.normHandle).includes(pqc.normHandle(envelope.sender))) {
      throw Object.assign(new Error('not a member of this group'), { status: 403 });
    }

    const senderIds = await resolveIds(envelope.sender);
    const dev = senderIds && (senderIds.devices || []).find((d) => d.deviceId === envelope.senderDevice);
    if (!dev) throw Object.assign(new Error('unknown sender device'), { status: 400 });
    if (!pqc.verifyEnvelope(envelope, dev.sigPublicKey)) {
      throw Object.assign(new Error('bad envelope signature'), { status: 400 });
    }

    const meta = await store.ensureConversation(convId, {
      kind: isGroup ? 'group' : 'dm',
      participants: existing ? existing.participants : parts,
      name: name || (existing && existing.name) || null,
    });
    const stored = await store.appendMessage(convId, envelope);
    presence.log('message', { convId, msgId: stored.msgId, sender: stored.sender, serverSeq: stored.serverSeq, recipients: stored.recipients.length });
    wakeLocal(meta.participants || parts, convId, stored.serverSeq);
    res.json({ stored });
  })
);

/** set/replace a group's member list — only an existing member may call it */
app.post(
  '/api/conv/:convId/members',
  authActor,
  requireActor,
  wrap(async (req, res) => {
    const meta = await store.getConversationMeta(req.params.convId);
    if (!meta) throw Object.assign(new Error('no such conversation'), { status: 404 });
    if (meta.kind !== 'group') throw Object.assign(new Error('not a group'), { status: 400 });
    if (!(meta.participants || []).map(pqc.normHandle).includes(req.actor.handle)) {
      throw Object.assign(new Error('only a member can change membership'), { status: 403 });
    }
    let next;
    try {
      next = (req.body.participants || []).map(pqc.normHandle);
    } catch {
      throw Object.assign(new Error('bad participants'), { status: 400 });
    }
    if (next.length < 2) throw Object.assign(new Error('a group needs >= 2 members'), { status: 400 });
    const updated = await store.setConversationParticipants(req.params.convId, next, req.body.name);
    presence.log('members', { convId: req.params.convId, by: req.actor.handle, count: next.length });
    wakeLocal(next, req.params.convId, (await store.getOrder(req.params.convId)).length);
    res.json({ ok: true, participants: next });
  })
);

async function participantGuard(req, res, next) {
  try {
    const meta = await store.getConversationMeta(req.params.convId);
    if (!meta) return res.status(404).json({ error: 'no such conversation' });
    if (!req.actor || !(meta.participants || []).map(pqc.normHandle).includes(req.actor.handle)) {
      return res.status(403).json({ error: 'not a participant' });
    }
    req.convMeta = meta;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get(
  '/api/conv/:convId/messages',
  authActor,
  participantGuard,
  wrap(async (req, res) => {
    const sinceSeq = parseInt(req.query.sinceSeq || '0', 10);
    const [messages, order] = await Promise.all([
      store.listMessages(req.params.convId, { sinceSeq }),
      store.getOrder(req.params.convId),
    ]);
    res.json({ convId: req.params.convId, meta: req.convMeta, messages, order, serverTime: Date.now() });
  })
);

app.get(
  '/api/conv/:convId/order',
  authActor,
  participantGuard,
  wrap(async (req, res) => {
    res.json({ convId: req.params.convId, order: await store.getOrder(req.params.convId) });
  })
);

app.post(
  '/api/conv/:convId/messages/:msgId/delivered',
  authActor,
  participantGuard,
  wrap(async (req, res) => {
    const deviceId = String(req.body.deviceId || '');
    if (!req.actor.deviceId || req.actor.deviceId !== deviceId) {
      throw Object.assign(new Error('ack must be signed by the acking device'), { status: 403 });
    }
    const msg = await store.getMessage(req.params.convId, req.params.msgId);
    if (!msg) throw Object.assign(new Error('no such message'), { status: 404 });
    if (!msg.recipients.some((r) => r.deviceId === deviceId)) {
      throw Object.assign(new Error('not a recipient device'), { status: 400 });
    }
    const updated = await store.markDelivered(req.params.convId, req.params.msgId, deviceId, Date.now());
    presence.log('delivered', { convId: req.params.convId, msgId: req.params.msgId, deviceId });
    wakeLocal([msg.sender], req.params.convId, updated.serverSeq);
    res.json({ ok: true, deliveries: updated.deliveries });
  })
);

app.get(
  '/api/inbox',
  authActor,
  requireActor,
  wrap(async (req, res) => {
    const me = req.actor.handle;
    const conversations = (await store.listConversations())
      .filter((c) => (c.participants || []).map(pqc.normHandle).includes(me))
      .map((c) => ({ convId: c.convId, participants: c.participants, kind: c.kind, name: c.name || null }));
    const withCounts = await Promise.all(
      conversations.map(async (c) => ({ ...c, latestSeq: (await store.getOrder(c.convId)).length }))
    );
    res.json({ conversations: withCounts, serverTime: Date.now() });
  })
);

// --------------------------------------------------------------------------
// dashboard / admin (ciphertext only)
// --------------------------------------------------------------------------
app.get('/api/admin/overview', admin, wrap(async (req, res) => {
  res.json({ stats: await store.stats(), peers: presence.list().length, adminAuth: config.public ? 'token-only (public)' : 'token or loopback' });
}));
app.get('/api/admin/presence', admin, wrap(async (req, res) => res.json({ peers: presence.list() })));
app.get('/api/admin/events', admin, wrap(async (req, res) =>
  res.json({ events: presence.eventsSince(parseInt(req.query.since || '0', 10)) })
));
app.get('/api/admin/accounts', admin, wrap(async (req, res) => {
  const list = await store.listAccounts();
  const out = [];
  for (const a of list) {
    const ids = await store.getIds(a.username);
    out.push({
      ...a,
      safetyNumber: pqc.safetyNumber((ids?.devices || []).map((d) => d.sigPublicKey)),
      devices: (ids?.devices || []).map((d) => ({
        deviceId: d.deviceId,
        deviceName: d.deviceName,
        addedAt: d.addedAt,
        online: presence.isOnline(d.deviceId),
        kemPublicKeyHead: d.kemPublicKey.slice(0, 44),
        sigPublicKeyHead: d.sigPublicKey.slice(0, 44),
      })),
    });
  }
  res.json({ accounts: out });
}));
app.get('/api/admin/conversations', admin, wrap(async (req, res) =>
  res.json({ conversations: await store.listConversations({ counts: true }) })
));
app.get('/api/admin/conv/:convId', admin, wrap(async (req, res) => {
  const meta = await store.getConversationMeta(req.params.convId);
  if (!meta) throw Object.assign(new Error('no such conversation'), { status: 404 });
  const [messages, order] = await Promise.all([
    store.listMessages(req.params.convId, { sinceSeq: 0 }),
    store.getOrder(req.params.convId),
  ]);
  // strip nothing: it is all ciphertext, but trim huge blobs for the list view
  const view = messages.map((m) => ({
    msgId: m.msgId,
    serverSeq: m.serverSeq,
    sender: m.sender,
    senderDevice: m.senderDevice,
    sentAt: m.sentAt,
    serverRecvAt: m.serverRecvAt,
    seq: m.seq,
    prevId: m.prevId,
    alg: m.alg,
    ctBytes: Buffer.from(m.ct, 'base64').length,
    ctPreview: m.ct.slice(0, 64),
    sigPreview: m.sig.slice(0, 48),
    recipients: m.recipients.map((r) => ({
      deviceId: r.deviceId,
      kemCtBytes: Buffer.from(r.kemCt, 'base64').length,
      delivered: !!(m.deliveries && m.deliveries[r.deviceId]),
      deliveredAt: m.deliveries ? m.deliveries[r.deviceId] : undefined,
    })),
  }));
  res.json({ meta, order, messages: view });
}));
app.get('/api/admin/conv/:convId/raw/:msgId', admin, wrap(async (req, res) => {
  const m = await store.getMessage(req.params.convId, req.params.msgId);
  if (!m) throw Object.assign(new Error('no such message'), { status: 404 });
  res.json(m); // full ciphertext envelope
}));

app.get('/api/health', (req, res) => res.json({ ok: true, backend: store.kind, time: Date.now() }));

// Public, unauthenticated: clients best-effort report their own errors here so
// the operator can see field problems without asking every user for logs. Size-
// capped and rate-limited per IP; relayed to GitHub only if the operator opted in
// (see reportDiag / config.sendDiagnostics) — otherwise it's just an activity-log line.
app.post('/api/diagnostics', (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  if (diagRateLimited(ip)) return res.status(429).json({ error: 'rate limited' });
  const b = req.body || {};
  const kind = String(b.kind || 'error').slice(0, 60);
  const message = String(b.message || '').slice(0, 500);
  if (!message && !b.kind) return res.status(400).json({ error: 'kind or message required' });
  const stack = typeof b.stack === 'string' ? b.stack.slice(0, 3000) : undefined;
  const context = b.context && typeof b.context === 'object' ? b.context : undefined;
  presence.log('diagnostic', { kind, message: message.slice(0, 200) });
  reportDiag({ component: 'client', kind, message, stack, context });
  res.json({ ok: true });
});

// public, unauthenticated — clients use this to label the server before signing
// in, and to carry the client-version gate
app.get('/api/serverinfo', (req, res) =>
  res.json({
    name: config.serverName || null,
    description: config.serverDescription || null,
    publicUrl: config.serverPublicUrl || null,
    serverVersion: PKG_VERSION,
    backend: store ? store.kind : null,
    clients: presence.list().length,
    minClient: config.minClient || null,
    latestClient: config.latestClient || null,
    downloadUrl: config.clientDownloadUrl,
    time: Date.now(),
  })
);

app.use('/', express.static(path.join(__dirname, '..', 'public')));

// --------------------------------------------------------------------------
// websockets
// --------------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const wssAdmin = new WebSocketServer({ noServer: true });
const liveClients = new Map(); // wsId -> { ws, username, deviceId }
const liveAdmins = new Set();

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/ws') {
    const claims = proto.verifyToken(SECRETS.tokenSecret, url.searchParams.get('token') || '');
    if (!claims) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._ctx = {
        username: claims.username,
        deviceId: url.searchParams.get('deviceId') || '',
        deviceName: url.searchParams.get('deviceName') || 'device',
        ip: (req.socket.remoteAddress || '').replace('::ffff:', ''),
      };
      wss.emit('connection', ws, req);
    });
  } else if (url.pathname === '/ws-admin') {
    if (!adminOk(url.searchParams.get('admin') || '', req)) return socket.destroy();
    wssAdmin.handleUpgrade(req, socket, head, (ws) => wssAdmin.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const wsId = crypto.randomUUID();
  const { username, deviceId, deviceName, ip } = ws._ctx;
  liveClients.set(wsId, { ws, username, deviceId });
  presence.add(wsId, { username, deviceId, deviceName, ip });
  ws.send(JSON.stringify({ type: 'hello', serverTime: Date.now() }));
  ws.on('pong', () => presence.touch(wsId));
  ws.on('message', (raw) => {
    presence.touch(wsId);
    try {
      const m = JSON.parse(raw);
      if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', serverTime: Date.now() }));
    } catch {}
  });
  ws.on('close', () => {
    liveClients.delete(wsId);
    presence.remove(wsId);
  });
});

wssAdmin.on('connection', (ws) => {
  liveAdmins.add(ws);
  ws.send(JSON.stringify({ type: 'hello', peers: presence.list() }));
  ws.on('close', () => liveAdmins.delete(ws));
});
presence.onBroadcast((kind, payload) => {
  const frame = JSON.stringify({ type: kind, payload });
  for (const ws of liveAdmins) if (ws.readyState === 1) ws.send(frame);
});

// ws heartbeat
setInterval(() => {
  for (const { ws } of liveClients.values()) {
    if (ws.readyState === 1) ws.ping();
  }
}, 15000).unref();

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------
let started = false;

/**
 * Start the pqmsg server. Safe to call once per process.
 * @param {object} overrides  merged into config before boot: { port, host,
 *        dataDir, backend, adminToken, public, quiet }
 * @returns {Promise<{server,presence,port,host,url,adminToken,dataDir,backend,close}>}
 */
async function startServer(overrides = {}) {
  if (started) {
    return { server, presence, port: config.port, host: config.host, url: `http://localhost:${config.port}` };
  }
  Object.assign(config, overrides);
  store = createStore(config);
  await store.init();
  SECRETS = await store.getServerSecrets();
  const adminToken = config.adminToken || SECRETS.adminToken;

  mailer = createMailer(config);

  await new Promise((resolve, reject) => {
    const onErr = (e) => reject(e);
    server.once('error', onErr);
    server.listen(config.port, config.host, () => {
      server.off('error', onErr);
      resolve();
    });
  });
  started = true;
  const url = `http://localhost:${config.port}`;

  if (!config.quiet) {
    console.log('┌───────────────────────────────────────────────');
    console.log('│  pqmsg server');
    console.log(`│  backend    : ${store.kind}${store.kind === 'github' ? ' (' + config.githubRepo + ')' : ' (' + config.dataDir + ')'}`);
    console.log(`│  listening  : ${config.host}:${config.port}`);
    console.log(`│  mode       : ${config.public ? 'PUBLIC (loopback admin bypass OFF)' : 'local (loopback may skip admin token)'}`);
    console.log(`│  dashboard  : ${url}/?admin=${adminToken}`);
    console.log(`│  admin token: ${adminToken}${config.adminToken ? ' (pinned)' : ' (auto — set PQMSG_ADMIN_TOKEN to pin it)'}`);
    if (config.public && !config.adminToken)
      console.log('│  ⚠ PUBLIC with an auto admin token — set PQMSG_ADMIN_TOKEN so it survives restarts');
    console.log('└───────────────────────────────────────────────');
  }

  return {
    server,
    presence,
    port: config.port,
    host: config.host,
    url,
    adminToken,
    dataDir: config.dataDir,
    backend: store.kind,
    mailerMode: () => mailer.mode,
    setServerInfo,
    close: async () => {
      await new Promise((r) => server.close(r));
    },
  };
}

/** Live-update the name/description/URL reported at /api/serverinfo. */
function setServerInfo(patch = {}) {
  if (patch.name !== undefined) config.serverName = patch.name;
  if (patch.description !== undefined) config.serverDescription = patch.description;
  if (patch.url !== undefined) config.serverPublicUrl = patch.url;
  if (patch.minClient !== undefined) config.minClient = patch.minClient;
  if (patch.latestClient !== undefined) config.latestClient = patch.latestClient;
  if (patch.sendDiagnostics !== undefined) config.sendDiagnostics = patch.sendDiagnostics;
  if (patch.diagToken !== undefined) config.diagToken = patch.diagToken;
  if (patch.diagRepo !== undefined) config.diagRepo = patch.diagRepo;
  if (['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpFrom', 'smtpSecure'].some((k) => patch[k] !== undefined)) {
    for (const k of ['smtpHost', 'smtpPort', 'smtpUser', 'smtpPass', 'smtpFrom', 'smtpSecure']) {
      if (patch[k] !== undefined) config[k] = patch[k];
    }
    mailer = createMailer(config);
  }
}

// Surface crashes (locally, and to GitHub if the operator opted in) instead of
// failing silently. uncaughtException still exits afterward — same fatal
// semantics as Node's default, just with a report on the way out.
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
  reportDiag({ component: 'server', kind: 'uncaughtException', message: err.message, stack: err.stack });
  setTimeout(() => process.exit(1), 250);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[unhandledRejection]', err);
  reportDiag({ component: 'server', kind: 'unhandledRejection', message: err.message, stack: err.stack });
});

module.exports = { startServer, setServerInfo, app, config, reportDiag };

if (require.main === module) {
  startServer().catch((e) => {
    console.error('pqmsg server failed to start:', e.message);
    process.exit(1);
  });
}
