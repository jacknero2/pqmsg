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
const proto = require('../../shared/protocol');
const pqc = require('../../shared/crypto');

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

function expectedConvId(kind, participants) {
  const p = participants.map(proto.normUser);
  if (kind === 'group' || p.length > 2) return pqc.groupConvId(p);
  return pqc.dmConvId(p[0], p[1]);
}

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

app.get(
  '/api/ids/:username',
  auth,
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
app.post(
  '/api/conv/:convId/messages',
  auth,
  wrap(async (req, res) => {
    const { envelope, participants, kind } = req.body;
    if (!envelope || !Array.isArray(participants) || participants.length < 2) {
      throw Object.assign(new Error('need envelope + participants[]'), { status: 400 });
    }
    const parts = participants.map(proto.normUser);
    if (!parts.includes(req.user)) throw Object.assign(new Error('not a participant'), { status: 403 });
    if (proto.normUser(envelope.sender) !== req.user) {
      throw Object.assign(new Error('sender/token mismatch'), { status: 403 });
    }
    const convId = req.params.convId;
    if (convId !== expectedConvId(kind, parts)) {
      throw Object.assign(new Error('convId does not match participants'), { status: 400 });
    }
    // authenticate the envelope against the sender device's signing key in the IDS
    const senderIds = await store.getIds(req.user);
    const dev = senderIds && senderIds.devices.find((d) => d.deviceId === envelope.senderDevice);
    if (!dev) throw Object.assign(new Error('unknown sender device'), { status: 400 });
    if (!pqc.verifyEnvelope(envelope, dev.sigPublicKey)) {
      throw Object.assign(new Error('bad envelope signature'), { status: 400 });
    }

    await store.ensureConversation(convId, { kind: kind || (parts.length > 2 ? 'group' : 'dm'), participants: parts });
    const stored = await store.appendMessage(convId, envelope);
    presence.log('message', {
      convId,
      msgId: stored.msgId,
      sender: stored.sender,
      serverSeq: stored.serverSeq,
      recipients: stored.recipients.length,
    });
    // wake other participants' live sockets
    wake(parts, convId, stored.serverSeq);
    res.json({ stored });
  })
);

async function participantGuard(req, res, next) {
  try {
    // hot path (hit on every client poll) — read one meta.json, not the whole tree
    const meta = await store.getConversationMeta(req.params.convId);
    if (!meta) return res.status(404).json({ error: 'no such conversation' });
    if (!(meta.participants || []).includes(req.user)) return res.status(403).json({ error: 'not a participant' });
    req.convMeta = meta;
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get(
  '/api/conv/:convId/messages',
  auth,
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
  auth,
  participantGuard,
  wrap(async (req, res) => {
    res.json({ convId: req.params.convId, order: await store.getOrder(req.params.convId) });
  })
);

app.post(
  '/api/conv/:convId/messages/:msgId/delivered',
  auth,
  participantGuard,
  wrap(async (req, res) => {
    const deviceId = String(req.body.deviceId || '');
    const owner = await store.findUserByDevice(deviceId);
    if (owner !== req.user) throw Object.assign(new Error('device does not belong to you'), { status: 403 });
    const msg = await store.getMessage(req.params.convId, req.params.msgId);
    if (!msg) throw Object.assign(new Error('no such message'), { status: 404 });
    if (!msg.recipients.some((r) => r.deviceId === deviceId)) {
      throw Object.assign(new Error('not a recipient device'), { status: 400 });
    }
    const updated = await store.markDelivered(req.params.convId, req.params.msgId, deviceId, Date.now());
    presence.log('delivered', { convId: req.params.convId, msgId: req.params.msgId, deviceId });
    wake([msg.sender], req.params.convId, updated.serverSeq);
    res.json({ ok: true, deliveries: updated.deliveries });
  })
);

app.get(
  '/api/inbox',
  auth,
  wrap(async (req, res) => {
    // one directory scan, then fan out the per-conversation order reads in parallel
    const mine = (await store.listConversations()).filter((c) => (c.participants || []).includes(req.user));
    const conversations = await Promise.all(
      mine.map(async (c) => ({
        convId: c.convId,
        participants: c.participants,
        kind: c.kind,
        latestSeq: (await store.getOrder(c.convId)).length,
      }))
    );
    res.json({ conversations, serverTime: Date.now() });
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

function wake(usernames, convId, latestSeq) {
  const set = new Set(usernames.map(proto.normUser));
  for (const { ws, username } of liveClients.values()) {
    if (set.has(username) && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'wake', convId, latestSeq, serverTime: Date.now() }));
    }
  }
}

// ws heartbeat
setInterval(() => {
  for (const { ws } of liveClients.values()) {
    if (ws.readyState === 1) ws.ping();
  }
}, 15000).unref();

// --------------------------------------------------------------------------
// boot
// --------------------------------------------------------------------------
(async () => {
  store = createStore(config);
  await store.init();
  SECRETS = await store.getServerSecrets();
  const shownAdmin = config.adminToken || SECRETS.adminToken;

  server.listen(config.port, config.host, () => {
    const url = `http://localhost:${config.port}`;
    console.log('┌───────────────────────────────────────────────');
    console.log('│  pqmsg server');
    console.log(`│  backend    : ${store.kind}${store.kind === 'github' ? ' (' + config.githubRepo + ')' : ' (' + config.dataDir + ')'}`);
    console.log(`│  listening  : ${config.host}:${config.port}`);
    console.log(`│  mode       : ${config.public ? 'PUBLIC (loopback admin bypass OFF)' : 'local (loopback may skip admin token)'}`);
    console.log(`│  dashboard  : ${url}/?admin=${shownAdmin}`);
    console.log(`│  admin token: ${shownAdmin}${config.adminToken ? ' (from PQMSG_ADMIN_TOKEN)' : ' (auto — set PQMSG_ADMIN_TOKEN to pin it)'}`);
    if (config.public && !config.adminToken)
      console.log('│  ⚠ PUBLIC with an auto admin token — set PQMSG_ADMIN_TOKEN so it survives restarts');
    console.log('└───────────────────────────────────────────────');
  });
})();
