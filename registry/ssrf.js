'use strict';
/*
 * The registry fetches an announced server's /api/serverinfo to confirm it is
 * live and its key matches, before listing it. That means an outbound request
 * to an attacker-chosen URL, so guard against SSRF: https/http only, no
 * private / loopback / link-local / metadata targets, no redirects, small cap.
 */
const dns = require('dns').promises;
const net = require('net');

function isPrivateV4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
  const [a, b] = p;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) || // link-local + AWS/GCP metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    a >= 224 // multicast / reserved
  );
}
function isPrivateV6(ip) {
  const s = ip.toLowerCase();
  return s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80') || s.startsWith('::ffff:');
}
const isBlockedIp = (ip) => (net.isIPv4(ip) ? isPrivateV4(ip) : isPrivateV6(ip));

/** Resolve `url`'s host and reject if it points anywhere private. Returns the URL string if OK. */
async function assertPublicUrl(url, { allowInsecure = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('invalid url');
  }
  if (u.protocol !== 'https:' && !(allowInsecure && u.protocol === 'http:')) {
    throw new Error('url must be https');
  }
  if (net.isIP(u.hostname)) {
    if (isBlockedIp(u.hostname)) throw new Error('url resolves to a private address');
    return url;
  }
  if (u.hostname === 'localhost') throw new Error('url resolves to a private address');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isBlockedIp(a.address))) {
    throw new Error('url resolves to a private address');
  }
  return url;
}

/** Fetch JSON with timeout, size cap, no redirects. */
async function fetchJsonSafe(url, { timeoutMs = 4000, maxBytes = 65536 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'error', signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('response too large');
    return JSON.parse(buf.toString('utf8'));
  } finally {
    clearTimeout(t);
  }
}

module.exports = { assertPublicUrl, fetchJsonSafe };
