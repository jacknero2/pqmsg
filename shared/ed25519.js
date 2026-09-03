'use strict';
/*
 * Server "registry identity" — a long-lived Ed25519 keypair (separate from the
 * per-device ML-KEM/ML-DSA keys). A server signs its directory announcements
 * with this; `publicId` is the stable handle clients and the registry use.
 * Node's built-in crypto does Ed25519, so no extra dependency.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');

function publicIdFromJwk(jwk) {
  return 'pid_' + sha256hex(Buffer.from(jwk.x, 'base64url')).slice(0, 32);
}

/** Deterministic: same file path -> same identity. */
function loadOrCreateIdentity(filePath) {
  try {
    const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return hydrate(j.privateJwk);
  } catch {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const privateJwk = privateKey.export({ format: 'jwk' });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ privateJwk }, null, 2));
    return hydrate(privateJwk);
  }
}

function hydrate(privateJwk) {
  const priv = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const publicJwk = { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x };
  const pub = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
  return {
    publicJwk,
    publicId: publicIdFromJwk(publicJwk),
    sign: (msg) => crypto.sign(null, Buffer.from(msg), priv).toString('base64'),
  };
}

function verify(msg, sigB64, publicJwk) {
  try {
    const pub = crypto.createPublicKey({ key: publicJwk, format: 'jwk' });
    return crypto.verify(null, Buffer.from(msg), pub, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}

// tiny deterministic JSON (keys sorted) — what gets signed
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

module.exports = { loadOrCreateIdentity, verify, canonical, publicIdFromJwk };
