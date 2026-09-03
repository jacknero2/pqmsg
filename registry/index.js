'use strict';
/*
 * pqmsg server registry
 * ---------------------
 * A tiny always-on directory. pqmsg servers sign an announcement with their
 * Ed25519 "registry identity" and POST it here; clients GET the live list on
 * startup and show a server picker.
 *
 *   POST   /announce    { name, url, description, region, publicJwk, ts, sig }
 *   POST   /heartbeat   { publicId, ts, sig }        -> bump lastSeen
 *   DELETE /announce    { publicId, ts, sig }        -> graceful removal
 *   GET    /servers      -> { servers: [ ...verified & fresh... ], now, staleAfter }
 *   GET    /health
 *
 * Anti-abuse: signature required; first server to claim a name owns it (TOFU);
 * the registry fetches <url>/api/serverinfo and checks publicId before listing
 * (SSRF-guarded); per-IP rate limit; stale entries drop off automatically.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { verify, canonical, publicIdFromJwk } = require('../shared/ed25519');
const { assertPublicUrl, fetchJsonSafe } = require('../shared/ssrf');

const bool = (v) => /^(1|true|yes)$/i.test(v || '');

const cfg = {
  port: parseInt(process.env.PQMSG_REGISTRY_PORT || '8788', 10),
  host: process.env.PQMSG_REGISTRY_HOST || '0.0.0.0',
  dataDir: process.env.PQMSG_REGISTRY_DATA_DIR || path.join(__dirname, '..', 'registry-data'),
  staleSec: parseInt(process.env.PQMSG_REGISTRY_STALE_SEC || '300', 10),
  maxEntries: parseInt(process.env.PQMSG_REGISTRY_MAX || '1000', 10),
  allowInsecure: bool(process.env.PQMSG_REGISTRY_ALLOW_INSECURE), // permit http:// server URLs
  trustAllUrls: bool(process.env.PQMSG_REGISTRY_TRUST_ALL_URLS), // skip SSRF guard (tests only)
  quiet: bool(process.env.PQMSG_REGISTRY_QUIET),
};

const NAME_RE = /^[\w][\w '.,!&()\-]{0,47}$/; // letters/digits + common punctuation, 2–48 chars
const REVERIFY_MS = 10 * 60 * 1000;

/** Build the registry Express app + state without listening (mountable into another server). */
function buildRegistryApp(overrides = {}) {
  Object.assign(cfg, overrides);
  const dataFile = path.join(cfg.dataDir, 'registry-data.json');
  fs.mkdirSync(cfg.dataDir, { recursive: true });

  /** publicId -> entry */
  const entries = new Map();
  /** nameLower -> publicId (ownership) */
  const owners = new Map();

  // load
  try {
    for (const e of JSON.parse(fs.readFileSync(dataFile, 'utf8'))) {
      entries.set(e.publicId, e);
      owners.set(e.name.toLowerCase(), e.publicId);
    }
  } catch {}

  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const tmp = dataFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...entries.values()], null, 2));
      fs.renameSync(tmp, dataFile);
    }, 250);
  };

  // per-IP rate limit: 20 writes / minute
  const buckets = new Map();
  const rateLimited = (ip) => {
    const now = Date.now();
    const b = buckets.get(ip) || { n: 0, reset: now + 60000 };
    if (now > b.reset) {
      b.n = 0;
      b.reset = now + 60000;
    }
    b.n++;
    buckets.set(ip, b);
    return b.n > 20;
  };

  async function verifyEntry(pid) {
    const e = entries.get(pid);
    if (!e) return;
    if (e.verifiedAt && Date.now() - e.verifiedAt < REVERIFY_MS && e.verified) return;
    try {
      if (!cfg.trustAllUrls) await assertPublicUrl(e.url, { allowInsecure: cfg.allowInsecure });
      const info = await fetchJsonSafe(e.url.replace(/\/$/, '') + '/api/serverinfo');
      const okId = info && info.publicId === e.publicId;
      e.verified = !!okId;
      e.lastVerifyErr = okId ? null : 'publicId mismatch at /api/serverinfo';
      if (okId && info.name) e.reportedName = info.name;
    } catch (err) {
      e.verified = false;
      e.lastVerifyErr = err.message;
    }
    e.verifiedAt = Date.now();
    save();
  }

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    res.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const freshMs = () => cfg.staleSec * 1000;

  app.get('/health', (req, res) => {
    let live = 0;
    for (const e of entries.values()) if (e.verified && Date.now() - e.lastSeen < freshMs()) live++;
    res.json({ ok: true, servers: live, total: entries.size });
  });

  app.get('/servers', (req, res) => {
    const now = Date.now();
    const includeUnverified = req.query.includeUnverified === '1';
    const includeStale = req.query.includeStale === '1';
    const out = [];
    for (const e of entries.values()) {
      const fresh = now - e.lastSeen < freshMs();
      if (!fresh && !includeStale) continue;
      if (!e.verified && !includeUnverified) continue;
      out.push({
        name: e.name,
        url: e.url,
        description: e.description || '',
        region: e.region || '',
        publicId: e.publicId,
        verified: !!e.verified,
        lastSeen: e.lastSeen,
        ageSeconds: Math.round((now - e.lastSeen) / 1000),
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ now, staleAfter: cfg.staleSec, servers: out });
  });

  app.post('/announce', async (req, res) => {
    const ip = ipOf(req);
    if (rateLimited(ip)) return res.status(429).json({ error: 'rate_limited' });

    const { name, url, description = '', region = '', publicJwk, ts, sig } = req.body || {};
    if (typeof name !== 'string' || !NAME_RE.test(name)) return res.status(400).json({ error: 'bad_name' });
    if (typeof url !== 'string' || url.length > 300) return res.status(400).json({ error: 'bad_url' });
    if (!publicJwk || publicJwk.kty !== 'OKP' || publicJwk.crv !== 'Ed25519' || typeof publicJwk.x !== 'string') {
      return res.status(400).json({ error: 'bad_key' });
    }
    if (typeof ts !== 'number' || Math.abs(Date.now() - ts) > 300000) return res.status(400).json({ error: 'bad_ts' });
    if (String(description).length > 200 || String(region).length > 40) return res.status(400).json({ error: 'too_long' });

    const msg = canonical({ name, url, description, region, publicJwk, ts });
    if (!verify(msg, sig, publicJwk)) return res.status(401).json({ error: 'bad_sig' });

    const publicId = publicIdFromJwk(publicJwk);
    const owner = owners.get(name.toLowerCase());
    if (owner && owner !== publicId) return res.status(409).json({ error: 'name_taken' });

    if (!entries.has(publicId) && entries.size >= cfg.maxEntries) {
      return res.status(507).json({ error: 'registry_full' });
    }

    const prev = entries.get(publicId);
    // a server may rename itself; release the old name if it changes
    if (prev && prev.name.toLowerCase() !== name.toLowerCase()) owners.delete(prev.name.toLowerCase());
    owners.set(name.toLowerCase(), publicId);
    entries.set(publicId, {
      name,
      url,
      description,
      region,
      publicId,
      publicJwk,
      firstSeen: prev ? prev.firstSeen : Date.now(),
      lastSeen: Date.now(),
      verified: prev ? prev.verified : false,
      verifiedAt: prev ? prev.verifiedAt : 0,
      lastVerifyErr: prev ? prev.lastVerifyErr : null,
    });
    save();
    verifyEntry(publicId); // async, don't block the response
    res.json({ ok: true, publicId, verified: !!entries.get(publicId).verified });
  });

  const signedControl = (req, res, next) => {
    const { publicId, ts, sig } = req.body || {};
    const e = publicId && entries.get(publicId);
    if (!e) return res.status(404).json({ error: 'unknown' });
    if (typeof ts !== 'number' || Math.abs(Date.now() - ts) > 300000) return res.status(400).json({ error: 'bad_ts' });
    if (!verify(canonical({ publicId, ts }), sig, e.publicJwk)) return res.status(401).json({ error: 'bad_sig' });
    req.entry = e;
    next();
  };

  app.post('/heartbeat', signedControl, (req, res) => {
    req.entry.lastSeen = Date.now();
    save();
    verifyEntry(req.entry.publicId); // cheap: no-ops unless the 10-min window elapsed
    res.json({ ok: true });
  });

  app.delete('/announce', signedControl, (req, res) => {
    entries.delete(req.entry.publicId);
    owners.delete(req.entry.name.toLowerCase());
    save();
    res.json({ ok: true });
  });

  // drop long-dead entries entirely (2x grace past stale)
  const gc = setInterval(() => {
    const cut = Date.now() - freshMs() * 2;
    let changed = false;
    for (const [pid, e] of entries) {
      if (e.lastSeen < cut) {
        entries.delete(pid);
        owners.delete(e.name.toLowerCase());
        changed = true;
      }
    }
    if (changed) save();
  }, 60000);
  gc.unref();

  return { app, entries, owners, save, stopGc: () => clearInterval(gc) };
}

/** Standalone registry service (listens on its own port). */
function createRegistry(overrides = {}) {
  const built = buildRegistryApp(overrides);
  let server;
  return {
    ...built,
    start: () =>
      new Promise((resolve, reject) => {
        server = built.app
          .listen(cfg.port, cfg.host, () => {
            if (!cfg.quiet) {
              console.log(`pqmsg registry  ·  ${cfg.host}:${cfg.port}  ·  data ${cfg.dataDir}  ·  ${built.entries.size} known`);
            }
            resolve({ port: cfg.port, host: cfg.host, url: `http://localhost:${cfg.port}` });
          })
          .on('error', reject);
      }),
    stop: () => new Promise((r) => (server ? server.close(r) : r())),
  };
}

module.exports = { createRegistry, buildRegistryApp, cfg };

if (require.main === module) {
  createRegistry()
    .start()
    .catch((e) => {
      console.error('registry failed to start:', e.message);
      process.exit(1);
    });
}
