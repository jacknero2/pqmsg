'use strict';
/* Short-lived email 2FA challenges + a stateless "trusted device" token. */
const crypto = require('crypto');
const { issueToken, verifyToken } = require('./protocol');

const genCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');
const hashCode = (code, salt) => crypto.createHash('sha256').update(salt + ':' + code).digest('hex');

class ChallengeStore {
  constructor({ ttlMs = 10 * 60 * 1000, maxAttempts = 5 } = {}) {
    this.ttlMs = ttlMs;
    this.maxAttempts = maxAttempts;
    this.map = new Map(); // id -> { kind, subject, codeHash, salt, exp, attempts, meta }
    setInterval(() => {
      const now = Date.now();
      for (const [id, c] of this.map) if (c.exp < now) this.map.delete(id);
    }, 60_000).unref();
  }
  /** create a challenge, returns { id, code } (code is emailed / dev-surfaced) */
  create(kind, subject, meta = {}) {
    const id = 'ch_' + crypto.randomUUID().replace(/-/g, '');
    const code = genCode();
    const salt = crypto.randomBytes(8).toString('hex');
    this.map.set(id, { kind, subject, codeHash: hashCode(code, salt), salt, exp: Date.now() + this.ttlMs, attempts: 0, meta });
    return { id, code };
  }
  /** @returns {{ok:true, meta}|{ok:false, error, attemptsLeft?}} */
  verify(id, code) {
    const c = this.map.get(id);
    if (!c || c.exp < Date.now()) return { ok: false, error: 'expired_or_unknown' };
    if (c.attempts >= this.maxAttempts) {
      this.map.delete(id);
      return { ok: false, error: 'too_many_attempts' };
    }
    c.attempts++;
    const given = hashCode(String(code || ''), c.salt);
    if (given.length !== c.codeHash.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(c.codeHash))) {
      return { ok: false, error: 'bad_code', attemptsLeft: this.maxAttempts - c.attempts };
    }
    this.map.delete(id);
    return { ok: true, meta: c.meta };
  }
}

// trusted-device token — stateless, HMAC-signed, ~30 days
function issueTrust(secret, username, days = 30) {
  return issueToken(secret, { t: 'trust', username }, days * 24 * 3600 * 1000);
}
function checkTrust(secret, token, username) {
  const b = verifyToken(secret, token);
  return !!(b && b.t === 'trust' && b.username === username);
}

module.exports = { ChallengeStore, issueTrust, checkTrust, genCode };
