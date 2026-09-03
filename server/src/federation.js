'use strict';
/*
 * Cross-server federation helpers.
 *
 *  - resolveIds(handle)     : local IDS if the handle's server is us, else a
 *                             cached GET {server}/api/ids/{user}
 *  - selfUrls / isSelf      : which origin URLs mean "this server"
 *  - notifyParticipantServers: tell remote participants' servers about a new
 *                             conversation so it appears in their inbox
 */
const pqc = require('../../shared/crypto');
const { assertPublicUrl, fetchJsonSafe } = require('../../shared/ssrf');

const bool = (v) => /^(1|true|yes)$/i.test(v || '');
const FED = {
  allowInsecure: bool(process.env.PQMSG_FED_ALLOW_INSECURE), // permit http:// peer servers
  trustAll: bool(process.env.PQMSG_FED_TRUST_ALL), // skip the SSRF guard (loopback tests)
  idsTtlMs: 60_000,
  timeoutMs: 4500,
};

const idsCache = new Map(); // handle -> { at, ids|null }

function reqOrigin(req) {
  if (!req) return null;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return null;
  const proto = req.headers['x-forwarded-proto'] || (req.socket && req.socket.encrypted ? 'https' : 'http');
  try {
    return new URL(`${proto}://${host}`).origin.toLowerCase();
  } catch {
    return null;
  }
}

function selfUrls(config, req) {
  const s = new Set();
  const add = (u) => {
    try {
      s.add(new URL(u).origin.toLowerCase());
    } catch {}
  };
  if (config.serverPublicUrl) add(config.serverPublicUrl);
  add(`http://localhost:${config.port}`);
  add(`http://127.0.0.1:${config.port}`);
  const o = reqOrigin(req);
  if (o) s.add(o);
  return s;
}
const isSelf = (url, config, req) => selfUrls(config, req).has(pqc.normServer(url));

/** @returns {Promise<{username,server,devices:[...],safetyNumber}|null>} */
async function resolveIds(handleStr, { config, store, req } = {}) {
  const h = pqc.parseHandle(handleStr);
  if (config && store && isSelf(h.server, config, req)) {
    const ids = await store.getIds(h.username);
    if (!ids) return null;
    return { ...ids, server: h.server, safetyNumber: pqc.safetyNumber((ids.devices || []).map((d) => d.sigPublicKey)) };
  }
  const key = pqc.formatHandle(h);
  const c = idsCache.get(key);
  if (c && Date.now() - c.at < FED.idsTtlMs) return c.ids;
  let ids = null;
  try {
    if (!FED.trustAll) await assertPublicUrl(h.server + '/', { allowInsecure: FED.allowInsecure });
    const j = await fetchJsonSafe(`${h.server}/api/ids/${encodeURIComponent(h.username)}`, {
      timeoutMs: FED.timeoutMs,
      maxBytes: 262144,
    });
    ids = { username: h.username, server: h.server, devices: j.devices || [], safetyNumber: j.safetyNumber || null };
  } catch {
    ids = null;
  }
  idsCache.set(key, { at: Date.now(), ids });
  return ids;
}

async function notifyParticipantServers({ participants, convId, homeServer, kind, name, config, req }) {
  const me = selfUrls(config, req);
  const targets = new Set();
  for (const p of participants) {
    try {
      const srv = pqc.parseHandle(p).server;
      if (!me.has(srv)) targets.add(srv);
    } catch {}
  }
  await Promise.all(
    [...targets].map(async (srv) => {
      try {
        await fetch(`${srv}/api/federated/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ convId, participants, homeServer, kind, name: name || null }),
          signal: AbortSignal.timeout(FED.timeoutMs),
        });
      } catch {}
    })
  );
}

module.exports = { resolveIds, notifyParticipantServers, selfUrls, isSelf, reqOrigin, FED };
