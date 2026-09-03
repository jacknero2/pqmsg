'use strict';
/*
 * Server discovery + client-version gate (client side).
 *
 *   sources merged, deduped by URL:
 *     - seed:      docs/servers.json on GitHub Pages (always available, curated)
 *     - registry:  live GET {registry}/servers  (auto-announced, has liveness)
 *     - pinned:    servers the user added by URL, stored locally
 *
 *   each server is then probed at /api/serverinfo for online/latency/name and
 *   for its client-version requirements.
 */

const SEED_URL = process.env.PQMSG_SEED_URL || 'https://jacknero2.github.io/pqmsg/servers.json';
const VERSION_URL = process.env.PQMSG_VERSION_URL || 'https://jacknero2.github.io/pqmsg/version.json';

async function fetchJson(url, timeoutMs = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** compare "a.b.c" version strings: -1 | 0 | 1 */
function cmpVer(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}
const maxVer = (a, b) => (cmpVer(a || '0', b || '0') >= 0 ? a || b : b || a);

const trim = (u) => String(u || '').replace(/\/+$/, '');

async function getSeed() {
  try {
    const j = await fetchJson(SEED_URL);
    return { registry: trim(j.registry), servers: Array.isArray(j.servers) ? j.servers : [] };
  } catch {
    return { registry: '', servers: [] };
  }
}

async function getVersionFloor() {
  try {
    return await fetchJson(VERSION_URL);
  } catch {
    return null;
  }
}

/** GET /api/serverinfo — liveness + name + version requirements */
async function probe(url) {
  const t0 = Date.now();
  try {
    const info = await fetchJson(trim(url) + '/api/serverinfo', 4500);
    return {
      online: true,
      latencyMs: Date.now() - t0,
      name: info.name || null,
      description: info.description || null,
      publicId: info.publicId || null,
      clients: info.clients ?? null,
      serverVersion: info.serverVersion || null,
      minClient: info.minClient || null,
      latestClient: info.latestClient || null,
      downloadUrl: info.downloadUrl || null,
    };
  } catch (e) {
    return { online: false, error: e.message };
  }
}

/** the server that hosts the registry (registryUrl minus a trailing /registry path) */
function registryHost(reg) {
  try {
    return new URL(reg).origin.toLowerCase();
  } catch {
    return '';
  }
}

/** Merge seed + registry + pinned into one deduped list (no probing yet). */
async function discover({ registryUrl, pinned }) {
  const seed = await getSeed();
  const reg = trim(registryUrl) || seed.registry || '';
  let dyn = [];
  if (reg) {
    try {
      dyn = (await fetchJson(reg + '/servers')).servers || [];
    } catch {}
  }
  const map = new Map();
  const add = (s, source) => {
    const key = trim(s.url);
    if (!key) return;
    const cur = map.get(key) || {};
    map.set(key, { name: cur.name, description: cur.description, ...s, url: key, source: cur.source || source });
  };
  // the registry host is itself a server clients can use
  if (reg) add({ url: registryHost(reg), name: 'registry host' }, 'registry');
  seed.servers.forEach((s) => add(s, 'seed'));
  dyn.forEach((s) => add(s, 'registry'));
  (pinned || []).forEach((s) => add(s, 'pinned'));
  const servers = [...map.values()];
  // where a new account should live by default: the registry host, else the only server
  const accountServer = registryHost(reg) || (servers.length === 1 ? servers[0].url : '') || '';
  return { registryUrl: reg, registryHost: registryHost(reg), servers, accountServer };
}

/**
 * Find which known server(s) a bare username exists on, by probing each server's
 * public IDS. Returns [{ username, server, deviceCount, safetyNumber }].
 */
async function resolveUser(username, serverUrls) {
  username = String(username || '').trim().toLowerCase();
  const seen = new Set();
  const urls = serverUrls.map(trim).filter((u) => u && !seen.has(u) && seen.add(u));
  const hits = await Promise.all(
    urls.map(async (server) => {
      try {
        const ids = await fetchJson(`${server}/api/ids/${encodeURIComponent(username)}`, 4000);
        if (!ids || !Array.isArray(ids.devices) || !ids.devices.length) return null;
        return { username, server, deviceCount: ids.devices.length, safetyNumber: ids.safetyNumber || null };
      } catch {
        return null;
      }
    })
  );
  return hits.filter(Boolean);
}

/**
 * Decide the version gate given this client's version, the global floor and an
 * optional server's /api/serverinfo.
 * @returns {{ gate: null|{required,current,downloadUrl,source}, update: null|{latest,downloadUrl} }}
 */
function versionVerdict(current, floor, serverInfo) {
  const dl =
    (serverInfo && serverInfo.downloadUrl) || (floor && floor.url) || 'https://jacknero2.github.io/pqmsg/';
  const required = maxVer(floor && floor.minSupported, serverInfo && serverInfo.minClient);
  const latest = maxVer(floor && floor.latest, serverInfo && serverInfo.latestClient);
  const gate =
    required && cmpVer(current, required) < 0
      ? { required, current, downloadUrl: dl, source: serverInfo && serverInfo.minClient === required ? 'server' : 'global' }
      : null;
  const update = !gate && latest && cmpVer(current, latest) < 0 ? { latest, downloadUrl: dl } : null;
  return { gate, update };
}

module.exports = { discover, probe, resolveUser, getVersionFloor, versionVerdict, cmpVer, SEED_URL, VERSION_URL };
