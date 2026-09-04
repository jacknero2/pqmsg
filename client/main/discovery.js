'use strict';
/*
 * Client-version gate (there is one fixed server — see engine.js's SERVER_URL —
 * so this is just "how do I know if I'm too old to talk to it").
 */

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

module.exports = { probe, getVersionFloor, versionVerdict, cmpVer, VERSION_URL };
