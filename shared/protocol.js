'use strict';
/* Shared protocol helpers: password hashing, bearer tokens, small utils. */

const crypto = require('crypto');

const MESSAGE_STATES = Object.freeze({
  PENDING: 'pending', // composed locally, not yet accepted by the server
  SENT: 'sent', // stored on the server, no recipient device has fetched it
  DELIVERED: 'delivered', // at least one recipient device has fetched + acked
  FAILED: 'failed', // server rejected it (bad signature, unknown conversation, ...)
});

// ---- password hashing (scrypt, no native deps) -----------------------------
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const dk = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return { salt, hash: dk.toString('hex') };
}
function verifyPassword(password, salt, hash) {
  const dk = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(dk, Buffer.from(hash, 'hex'));
}

// ---- bearer tokens (HMAC-signed, stateless) --------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
function issueToken(secret, payload, ttlMs = 7 * 24 * 3600 * 1000) {
  const body = { ...payload, iat: Date.now(), exp: Date.now() + ttlMs };
  const p = b64url(JSON.stringify(body));
  const mac = b64url(crypto.createHmac('sha256', secret).update(p).digest());
  return `${p}.${mac}`;
}
function verifyToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [p, mac] = token.split('.');
  const expected = b64url(crypto.createHmac('sha256', secret).update(p).digest());
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) {
    return null;
  }
  let body;
  try {
    body = JSON.parse(unb64url(p).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof body.exp !== 'number' || body.exp < Date.now()) return null;
  return body;
}

const USERNAME_RE = /^[a-z0-9_.-]{2,32}$/;
const normUser = (u) => String(u || '').trim().toLowerCase();

module.exports = {
  MESSAGE_STATES,
  hashPassword,
  verifyPassword,
  issueToken,
  verifyToken,
  USERNAME_RE,
  normUser,
};
