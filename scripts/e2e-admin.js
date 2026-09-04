'use strict';
/*
 * Operator dashboard: master login (password + emailed 2FA), forgot-password,
 * session tokens as admin auth, and the usage-analytics endpoint.
 *   npm run e2e:admin
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-admin-'));
const PORT = 8600 + (crypto.randomBytes(1)[0] % 90);
const A = `http://127.0.0.1:${PORT}`;

process.env.PQMSG_PORT = String(PORT);
process.env.PQMSG_HOST = '127.0.0.1';
process.env.PQMSG_DATA_DIR = path.join(TMP, 'srv');
process.env.PQMSG_PUBLIC = '1';
process.env.PQMSG_PUBLIC_URL = A;
process.env.PQMSG_ADMIN_TOKEN = 'static-admin-tok';
process.env.PQMSG_MASTER_EMAIL = 'jnero@nd.edu';

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
  const { startServer } = require('../server/src/index.js');
  await startServer({ quiet: true });
  await waitHealth(A);

  console.log('\n── master setup / login / 2FA ───────────────────');
  let sessionToken;
  try {
    let r = await J('GET', A + '/api/admin/master/status');
    assert.deepStrictEqual([r.j.email, r.j.hasPassword], ['jnero@nd.edu', false], 'master starts unset, email defaulted');

    r = await J('POST', A + '/api/admin/master/setup', { password: 'short' });
    assert.strictEqual(r.status, 400, 'password under 8 chars rejected');

    r = await J('POST', A + '/api/admin/master/setup', { password: 'masterpw123' });
    assert.ok(r.j.needs2fa && r.j.devCode, 'setup sends a verification code');
    const setupCode = r.j.devCode;
    const setupChallenge = r.j.challengeId;

    const dupe = await J('POST', A + '/api/admin/master/setup', { password: 'again12345' });
    assert.strictEqual(dupe.status, 409, 'cannot set the password twice');

    const badCode = await J('POST', A + '/api/admin/master/verify', { challengeId: setupChallenge, code: '000000' });
    assert.strictEqual(badCode.status, 401, 'wrong code rejected');

    r = await J('POST', A + '/api/admin/master/verify', { challengeId: setupChallenge, code: setupCode });
    assert.ok(r.j.sessionToken, 'correct code yields a session token');
    sessionToken = r.j.sessionToken;
    ok('setup: password + emailed code -> session token (wrong password length / dupe setup / wrong code all rejected)');
  } catch (e) {
    bad('master setup', e);
  }

  try {
    const noauth = await J('GET', A + '/api/admin/overview');
    assert.notStrictEqual(noauth.status, 200, 'no admin/master auth at all is refused');

    const withSession = await J('GET', A + '/api/admin/overview', null, { 'X-Admin-Token': sessionToken });
    assert.strictEqual(withSession.status, 200, 'a master session token works as admin auth');

    const withStatic = await J('GET', A + '/api/admin/overview', null, { 'X-Admin-Token': 'static-admin-tok' });
    assert.strictEqual(withStatic.status, 200, 'the static PQMSG_ADMIN_TOKEN still works too');

    const withGarbage = await J('GET', A + '/api/admin/overview', null, { 'X-Admin-Token': 'nope' });
    assert.notStrictEqual(withGarbage.status, 200, 'a bogus token is rejected');
    ok('both a master session token and the static admin token authenticate /api/admin/*; garbage does not');
  } catch (e) {
    bad('admin auth via session token', e);
  }

  try {
    const r = await J('POST', A + '/api/admin/master/login', { password: 'masterpw123' });
    assert.ok(r.j.needs2fa && r.j.devCode, 'login sends a fresh code');
    const r2 = await J('POST', A + '/api/admin/master/verify', { challengeId: r.j.challengeId, code: r.j.devCode });
    assert.ok(r2.j.sessionToken, 'login + code yields a new session token');
    const wrongPw = await J('POST', A + '/api/admin/master/login', { password: 'nope' });
    assert.strictEqual(wrongPw.status, 401, 'wrong password rejected');
    ok('subsequent login: password -> code -> session token; wrong password rejected');
  } catch (e) {
    bad('master login', e);
  }

  console.log('\n── forgot master password ───────────────────────');
  try {
    let r = await J('POST', A + '/api/admin/master/reset', {});
    assert.ok(r.j.needs2fa && r.j.devCode, 'reset sends a code to the master email');
    const resetChallenge = r.j.challengeId;
    const resetCode = r.j.devCode;

    const badReset = await J('POST', A + '/api/admin/master/reset/verify', { challengeId: resetChallenge, code: '000000', newPassword: 'brandnew123' });
    assert.strictEqual(badReset.status, 401, 'wrong reset code rejected');

    r = await J('POST', A + '/api/admin/master/reset/verify', { challengeId: resetChallenge, code: resetCode, newPassword: 'brandnew123' });
    assert.ok(r.j.ok, 'reset succeeds with the right code');

    const oldPw = await J('POST', A + '/api/admin/master/login', { password: 'masterpw123' });
    assert.notStrictEqual(oldPw.status, 200, 'the old password no longer works');

    const newPwLogin = await J('POST', A + '/api/admin/master/login', { password: 'brandnew123' });
    assert.ok(newPwLogin.j.needs2fa, 'the new password logs in');
    ok('forgot password: emailed reset code -> new password -> old password dead');
  } catch (e) {
    bad('master password reset', e);
  }

  console.log('\n── usage analytics ───────────────────────────────');
  try {
    await J('POST', A + '/api/auth/register', { username: 'alice', email: 'alice@test.local', password: 'hunter22' });
    const login = await J('POST', A + '/api/auth/login', { username: 'alice', password: 'hunter22' });
    await J('POST', A + '/api/auth/verify', { challengeId: login.j.challengeId, code: login.j.devCode });

    const r = await J('GET', A + '/api/admin/analytics?days=7', null, { 'X-Admin-Token': 'static-admin-tok' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.j.totalUsers, 1, 'one registered account counted');
    assert.strictEqual(r.j.series.length, 7, 'series has the requested number of days');
    const today = r.j.series[r.j.series.length - 1];
    assert.strictEqual(today.date, new Date().toISOString().slice(0, 10), 'last bucket is today');
    assert.strictEqual(today.signups, 1, "today's signup is counted (derived from account.createdAt)");
    assert.strictEqual(today.logins, 1, "today's login is counted");
    assert.ok(today.activeUsers >= 1, 'today has at least one active user');

    const noAuth = await J('GET', A + '/api/admin/analytics');
    assert.notStrictEqual(noAuth.status, 200, 'analytics requires admin auth, same as the rest of the dashboard');
    ok('GET /api/admin/analytics: signups derived from account data, logins/active-users tracked live, auth-gated');
  } catch (e) {
    bad('analytics', e);
  }

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
})();
