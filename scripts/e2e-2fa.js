'use strict';
/*
 * Email 2FA on login + trusted-device tokens. No Electron, no real email (dev
 * mode surfaces the code instead of sending it).
 *   npm run e2e:2fa
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-2fa-'));
const PA = 8700 + (crypto.randomBytes(1)[0] % 120);
const A = `http://127.0.0.1:${PA}`;

process.env.PQMSG_VERSION_URL = 'http://127.0.0.1:1/x';

let pass = 0,
  fail = 0;
const ok = (n) => (pass++, console.log('  \x1b[32m✓\x1b[0m ' + n));
const bad = (n, e) => (fail++, console.log('  \x1b[31m✗\x1b[0m ' + n + '  — ' + (e && e.message ? e.message : e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = async (method, url, body, headers) => {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
};
async function waitHealth(url) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url + '/api/health')).ok) return;
    } catch {}
    await sleep(80);
  }
  throw new Error('no health at ' + url);
}

(async () => {
  console.log('\n── email 2FA on login ───────────────────────────');
  process.env.PQMSG_PORT = String(PA);
  process.env.PQMSG_HOST = '127.0.0.1';
  process.env.PQMSG_DATA_DIR = path.join(TMP, 'srvA');
  process.env.PQMSG_PUBLIC = '1';
  process.env.PQMSG_PUBLIC_URL = A;
  const { startServer } = require('../server/src/index.js');
  await startServer({ quiet: true });
  await waitHealth(A);

  let trustToken;
  try {
    let r = await J('POST', A + '/api/auth/register', { username: 'alice', email: 'alice@example.com', password: 'hunter2' });
    assert.strictEqual(r.status, 200, 'register with email ok');

    r = await J('POST', A + '/api/auth/register', { username: 'bob', password: 'hunter2' });
    assert.strictEqual(r.status, 400, 'register without email is rejected');
    ok('registration now requires a valid email');

    r = await J('POST', A + '/api/auth/login', { username: 'alice', password: 'hunter2' });
    assert.ok(r.j.needs2fa && r.j.challengeId, 'password alone does not yield a token');
    assert.ok(r.j.dev && r.j.devCode, 'dev mode surfaces the code (email not configured)');
    const chId = r.j.challengeId;

    let bad1 = await J('POST', A + '/api/auth/verify', { challengeId: chId, code: '000000' });
    assert.strictEqual(bad1.status, 401, 'wrong code rejected');

    r = await J('POST', A + '/api/auth/verify', { challengeId: chId, code: r.j.devCode, rememberDevice: true });
    assert.ok(r.j.token, 'correct code yields a session token');
    assert.ok(r.j.trustToken, 'rememberDevice yields a 30-day trust token');
    trustToken = r.j.trustToken;
    ok('login = password → emailed code → token (wrong codes rejected)');
  } catch (e) {
    bad('2FA login', e);
  }

  try {
    const r = await J('POST', A + '/api/auth/login', { username: 'alice', password: 'hunter2', trustToken });
    assert.ok(r.j.token && !r.j.needs2fa, 'trusted device skips the code and gets a token directly');
    const r2 = await J('POST', A + '/api/auth/login', { username: 'alice', password: 'hunter2', trustToken: 'garbage' });
    assert.ok(r2.j.needs2fa, 'a bad trust token falls back to 2FA');
    ok('a remembered device skips 2FA for 30 days; a forged trust token does not');
  } catch (e) {
    bad('trusted device', e);
  }

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
})();
