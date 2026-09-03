'use strict';
/*
 * pqmsg server
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
const { RegistryAnnouncer, loadServerIdentity } = require('./registry-client');
const fed = require('./federation');
const proto = require('../../shared/protocol');
const pqc = require('../../shared/crypto');
const crypto2 = require('crypto');
const PKG_VERSION = require('../../package.json').version;

const handleHash = (h) => crypto2.createHash('sha256').update(pqc.normHandle(h)).digest('hex').slice(0, 32);

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Admin-Token');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const presence = new Presence();
let store;
let SECRETS;
let serverIdentity = null; // Ed25519 registry identity (for /api/serverinfo + announcing)
let announcer = null;

// --------------------------------------------------------------------------
// helpers
// --------------------------------------------------------------------------
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
 * Resolve who is calling.
 *  - `X-PQMSG-Auth: <b64 JSON {handle, deviceId, ts, sig}>` — ML-DSA over a
 *    canonical challenge, verified against that handle's IDS (federated). Works
 *    for callers with no account here.
 *  - `Authorization: Bearer <token>` — a local account.
 * Sets req.actor = { handle, deviceId|null, local } or leaves it null.
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
      const ids = await fed.resolveIds(a.handle, { config, store, req });
      const dev = ids && (ids.devices || []).find((d) => d.deviceId === a.deviceId);
      const challenge = { m: 'pqmsg-auth', method: req.method, path: req.path, convId: req.params.convId || null, deviceId: a.deviceId, ts: a.ts };
      if (!dev || !pqc.verifyRequest(challenge, a.sig, dev.sigPublicKey)) return res.status(401).json({ error: 'bad_auth_sig' });
      req.actor = { handle: pqc.normHandle(a.handle), deviceId: a.deviceId, local: fed.isSelf(pqc.parseHandle(a.handle).server, config, req) };
      return next();
    }
    const h = req.get('authorization') || '';
    const tok = h.startsWith('Bearer ') ? h.slice(7) : null;
    const claims = tok && proto.verifyToken(SECRETS.tokenSecret, tok);
    if (claims) {
      const origin = fed.reqOrigin(req) || config.serverPublicUrl || `http://localhost:${config.port}`;
      req.actor = { handle: pqc.formatHandle({ username: claims.username, server: origin }), deviceId: null, local: true };
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
    if (!proto.USERNAME_RE.test(username)) throw Object.assign(new Error('bad username'), { status: 400 });
    if (password.length < 6) throw Object.assign(new Error('password too short'), { status: 400 });
    const { salt, hash } = proto.hashPassword(password);
    await store.createAccount({ username, salt, hash });
    presence.log('register', { username });
    res.json({ ok: true, username });
  })
);

app.post(
  '/api/auth/login',
  wrap(async (req, res) => {
    const username = proto.normUser(req.body.username);
    const password = String(req.body.password || '');
    const acct = await store.getAccount(username);
    if (!acct || !proto.verifyPassword(password, acct.salt, acct.hash)) {
      throw Object.assign(new Error('invalid credentials'), { status: 401 });
    }
    const token = proto.issueToken(SECRETS.tokenSecret, { username });
    res.json({ token, username });
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

// public: the IDS is device *public* keys + a safety number, and federated
// peers/clients must be able to read it without an account here
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
/** wake the WS sockets of participants whose account lives on THIS server */
function wakeLocal(handles, convId, latestSeq) {
  const local = new Set(handles.filter((h) => fed.isSelf(pqc.parseHandle(h).server, config)).map((h) => pqc.parseHandle(h).username));
  for (const { ws, username } of liveClients.values()) {
    if (local.has(username) && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'wake', convId, latestSeq, serverTime: Date.now() }));
    }
  }
}

app.post(
  '/api/conv/:convId/messages',
  wrap(async (req, res) => {
    // Auth here is the envelope signature itself — no local account/token needed,
    // so a client whose home server is elsewhere can post to this conversation.
    const { envelope, participants, kind, name } = req.body;
    if (!envelope || !Array.isArray(participants) || participants.length < 2) {
      throw Object.assign(new Error('need envelope + participants[]'), { status: 400 });
    }
    let parts;
    try {
      parts = participants.map(pqc.normHandle);
    } catch {
      throw Object.assign(new Error('participants must be user@server handles'), { status: 400 });
    }
    const convId = req.params.convId;
    const isGroup = kind === 'group' || parts.length > 2;

    if (!parts.includes(pqc.normHandle(envelope.sender))) {
      throw Object.assign(new Error('sender is not a participant'), { status: 403 });
    }
    if (!convIdOk(convId, kind, parts)) {
      throw Object.assign(new Error('convId does not match the conversation'), { status: 400 });
    }
    const home = pqc.homeServer(parts);
    if (!fed.isSelf(home, config, req)) {
      return res.status(421).json({ error: 'misdirected', homeServer: home });
    }
    // for an existing group, the sender must be a current member (membership is mutable)
    const existing = await store.getConversationMeta(convId);
    if (isGroup && existing && !(existing.participants || []).map(pqc.normHandle).includes(pqc.normHandle(envelope.sender))) {
      throw Object.assign(new Error('not a member of this group'), { status: 403 });
    }

    // authenticate the envelope against the sender device's signing key (resolved
    // from the sender's own server if they are not local)
    const senderIds = await fed.resolveIds(envelope.sender, { config, store, req });
    const dev = senderIds && (senderIds.devices || []).find((d) => d.deviceId === envelope.senderDevice);
    if (!dev) throw Object.assign(new Error('unknown sender device'), { status: 400 });
    if (!pqc.verifyEnvelope(envelope, dev.sigPublicKey)) {
      throw Object.assign(new Error('bad envelope signature'), { status: 400 });
    }

    const meta = await store.ensureConversation(convId, {
      kind: isGroup ? 'group' : 'dm',
      participants: existing ? existing.participants : parts,
      name: name || (existing && existing.name) || null,
      homeServer: home,
    });
    const stored = await store.appendMessage(convId, envelope);
    presence.log('message', { convId, msgId: stored.msgId, sender: stored.sender, serverSeq: stored.serverSeq, recipients: stored.recipients.length });
    wakeLocal(meta.participants || parts, convId, stored.serverSeq);
    if (meta.created || stored.serverSeq <= 2) {
      fed.notifyParticipantServers({ participants: meta.participants || parts, convId, homeServer: home, kind: isGroup ? 'group' : 'dm', name: meta.name, config, req });
    }
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
    if (!fed.isSelf(meta.homeServer || pqc.homeServer(meta.participants), config, req)) {
      return res.status(421).json({ error: 'misdirected', homeServer: meta.homeServer });
    }
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
    fed.notifyParticipantServers({ participants: next, convId: req.params.convId, homeServer: meta.homeServer, kind: 'group', name: updated.name, config, req });
    res.json({ ok: true, participants: next });
  })
);

async function participantGuard(req, res, next) {
  try {
    const meta = await store.getConversationMeta(req.params.convId);
    if (!meta) return res.status(404).json({ error: 'no such conversation' });
    if (!fed.isSelf(meta.homeServer || pqc.homeServer(meta.participants), config, req)) {
      return res.status(421).json({ error: 'misdirected', homeServer: meta.homeServer });
    }
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

/** server-to-server: a remote home server tells us one of our users is in a conversation there */
app.post(
  '/api/federated/notify',
  wrap(async (req, res) => {
    const { convId, participants, homeServer, kind, name } = req.body || {};
    let parts;
    try {
      parts = (participants || []).map(pqc.normHandle);
    } catch {
      throw Object.assign(new Error('bad participants'), { status: 400 });
    }
    if (!convId || !homeServer || parts.length < 2) throw Object.assign(new Error('bad notify'), { status: 400 });
    // the claimed home must actually be the deterministic home for these members
    if (kind !== 'group' && pqc.normServer(homeServer) !== pqc.homeServer(parts)) {
      throw Object.assign(new Error('home server does not match participants'), { status: 400 });
    }
    if (fed.isSelf(homeServer, config, req)) return res.json({ ok: true, ignored: 'self' }); // we are the home
    let added = 0;
    for (const p of parts) {
      if (fed.isSelf(pqc.parseHandle(p).server, config, req)) {
        await store.addPointer(handleHash(p), { convId, homeServer: pqc.normServer(homeServer), participants: parts, kind: kind || 'dm', name: name || null });
        added++;
      }
    }
    res.json({ ok: true, added });
  })
);

app.get(
  '/api/inbox',
  authActor,
  requireActor,
  wrap(async (req, res) => {
    const me = req.actor.handle;
    const local = (await store.listConversations())
      .filter((c) => (c.participants || []).map(pqc.normHandle).includes(me))
      .map((c) => ({ convId: c.convId, participants: c.participants, kind: c.kind, name: c.name || null, homeServer: c.homeServer || fed.reqOrigin(req), local: true }));
    const seen = new Set(local.map((c) => c.convId));
    const pointers = (await store.listPointers(handleHash(me)))
      .filter((p) => !seen.has(p.convId))
      .map((p) => ({ convId: p.convId, participants: p.participants, kind: p.kind, name: p.name || null, homeServer: p.homeServer, local: false }));
    const conversations = await Promise.all(
      local.map(async (c) => ({ ...c, latestSeq: (await store.getOrder(c.convId)).length }))
    );
    res.json({ conversations: [...conversations, ...pointers], serverTime: Date.now() });
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

// public, unauthenticated — used by the registry's callback check, by clients to
// label a server before signing in, and to carry the client-version gate
app.get('/api/serverinfo', (req, res) =>
  res.json({
    name: config.serverName || null,
    description: config.serverDescription || null,
    region: config.serverRegion || null,
    publicId: serverIdentity ? serverIdentity.publicId : null,
    publicUrl: config.serverPublicUrl || null,
    federation: true,
    serverVersion: PKG_VERSION,
    backend: store ? store.kind : null,
    clients: presence.list().length,
    // client update gate — operator sets PQMSG_MIN_CLIENT / PQMSG_LATEST_CLIENT
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

  // Ed25519 registry identity — always loaded so /api/serverinfo can report publicId
  try {
    serverIdentity = loadServerIdentity(config.dataDir);
  } catch (e) {
    console.error('registry identity load failed:', e.message);
  }
  if (config.announce && config.registryUrl && config.serverName && config.serverPublicUrl) {
    startAnnouncing({
      name: config.serverName,
      description: config.serverDescription,
      region: config.serverRegion,
      url: config.serverPublicUrl,
    });
  }

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
    registryIdentity: serverIdentity,
    getAnnouncer: () => announcer,
    startAnnouncing,
    stopAnnouncing,
    setServerInfo,
    close: async () => {
      await stopAnnouncing();
      await new Promise((r) => server.close(r));
    },
  };
}

/** Begin (or update + resume) announcing this server to the configured registry. */
function startAnnouncing(info) {
  const registryUrl = info.registryUrl || config.registryUrl;
  if (!registryUrl) throw new Error('no registry URL (set PQMSG_REGISTRY_URL)');
  config.registryUrl = registryUrl;
  if (!announcer) {
    announcer = new RegistryAnnouncer({ registryUrl, dataDir: config.dataDir, info });
  } else {
    announcer.setInfo(info);
  }
  announcer.start();
  return announcer;
}
function stopAnnouncing() {
  return announcer ? announcer.stop() : Promise.resolve();
}
/** Live-update the name/description/URL reported at /api/serverinfo and (if active) re-announced. */
function setServerInfo(patch = {}) {
  if (patch.name !== undefined) config.serverName = patch.name;
  if (patch.description !== undefined) config.serverDescription = patch.description;
  if (patch.region !== undefined) config.serverRegion = patch.region;
  if (patch.url !== undefined) config.serverPublicUrl = patch.url;
  if (patch.minClient !== undefined) config.minClient = patch.minClient;
  if (patch.latestClient !== undefined) config.latestClient = patch.latestClient;
  if (announcer) {
    announcer.setInfo({
      name: config.serverName,
      description: config.serverDescription,
      region: config.serverRegion,
      url: config.serverPublicUrl,
    });
  }
}

module.exports = { startServer, startAnnouncing, stopAnnouncing, setServerInfo, app, config };

if (require.main === module) {
  startServer().catch((e) => {
    console.error('pqmsg server failed to start:', e.message);
    process.exit(1);
  });
}
