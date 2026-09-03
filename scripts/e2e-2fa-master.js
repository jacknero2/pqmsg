'use strict';
/*
 * Email 2FA on login + trusted-device tokens + master-registry mode (a server
 * that hosts the directory itself). No Electron, no real email (dev mode).
 *   npm run e2e:2fa
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-2fa-'));
const PA = 8700 + (crypto.randomBytes(1)[0] % 120);
const PB = PA + 143;
const A = `http://127.0.0.1:${PA}`;
const B = `http://127.0.0.1:${PB}`;

process.env.PQMSG_FED_TRUST_ALL = '1';
process.env.PQMSG_FED_ALLOW_INSECURE = '1';
process.env.PQMSG_SEED_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_VERSION_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_MASTER_EMAIL = 'jnero@nd.edu';

const pqc = require('../shared/crypto');
const { spawn } = require('child_process');

let pass = 0,
  fail = 0;
const ok = (n) => (pass++, console.log('  \x1b[32m✓\x1b[0m ' + n));
const bad = (n, e) => (fail++, console.log('  \x1b[31m✗\x1b[0m ' + n + '  — ' + (e && e.message ? e.message : e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(120);
  }
};
const J = async (method, url, body, headers) => {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json', ...(headers || {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  return { status: res.status, j };
};

function childServer(port, pub, dir) {
  const code = `
    process.env.PQMSG_PORT='${port}'; process.env.PQMSG_HOST='127.0.0.1';
    process.env.PQMSG_DATA_DIR=${JSON.stringify(dir)};
    process.env.PQMSG_PUBLIC='1'; process.env.PQMSG_PUBLIC_URL='${pub}';
    process.env.PQMSG_FED_TRUST_ALL='1'; process.env.PQMSG_FED_ALLOW_INSECURE='1';
    process.env.PQMSG_MASTER_EMAIL='jnero@nd.edu';
    require(${JSON.stringify(path.join(__dirname, '..', 'server', 'src', 'index.js'))})
      .startServer({ quiet: true }).then(()=>console.log('UP')).catch(e=>{console.error(e);process.exit(1)});
  `;
  const p = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => p.stdout.on('data', (d) => String(d).includes('UP') && resolve(p)));
}
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

  console.log('\n── master registry mode ─────────────────────────');
  let masterToken;
  try {
    let r = await J('GET', A + '/api/master/status');
    assert.deepStrictEqual([r.j.email, r.j.hasPassword, r.j.registryEnabled], ['jnero@nd.edu', false, false], 'master starts unset, email defaulted');

    r = await J('POST', A + '/api/master/setup', { password: 'masterpw123' });
    assert.ok(r.j.needs2fa && r.j.devCode, 'master setup sends a verification code to jnero@nd.edu');
    const code = r.j.devCode;

    r = await J('POST', A + '/api/master/setup', { password: 'again' });
    assert.strictEqual(r.status, 409, 'cannot set the master password twice');

    r = await J('POST', A + '/api/master/verify', { challengeId: (await J('POST', A + '/api/master/login', { password: 'masterpw123' })).j.challengeId, code: 'nope' });
    assert.notStrictEqual(r.status, 200, 'wrong master code rejected');

    // real flow: login -> verify
    r = await J('POST', A + '/api/master/login', { password: 'masterpw123' });
    r = await J('POST', A + '/api/master/verify', { challengeId: r.j.challengeId, code: r.j.devCode });
    assert.ok(r.j.masterToken && r.j.registryEnabled, 'master verify enables the registry + returns a master token');
    masterToken = r.j.masterToken;
    ok('master (jnero@nd.edu) sets a password, verifies by code, registry turns on');
  } catch (e) {
    bad('master setup', e);
  }

  try {
    const h = await J('GET', A + '/registry/health');
    assert.ok(h.j && h.j.ok, 'the registry is now mounted at /registry on server A');
    const info = await (await fetch(A + '/api/serverinfo')).json();
    assert.ok(info.isRegistry && info.registryPath === '/registry', '/api/serverinfo advertises the registry');
    ok('server A now doubles as a registry at /registry — no separate service');
  } catch (e) {
    bad('registry mounted', e);
  }

  try {
    // server B announces itself to A's registry
    const childB = await childServer(PB, B, path.join(TMP, 'srvB'));
    await waitHealth(B);
    const { RegistryAnnouncer } = require('../server/src/registry-client');
    const ann = new RegistryAnnouncer({
      registryUrl: A + '/registry',
      dataDir: path.join(TMP, 'srvB'),
      info: { name: 'Server B', description: 'announcer', url: B },
    });
    ann.start();
    const listed = await until(async () => {
      const r = await J('GET', A + '/registry/servers');
      return (r.j.servers || []).find((s) => s.url.replace(/\/$/, '') === B && s.verified) || null;
    });
    assert.ok(listed, 'server B is listed + verified in A’s registry');

    const disc = require('../client/main/discovery');
    const found = (await disc.discover({ registryUrl: A + '/registry', pinned: [] })).servers.find((s) => s.url === B);
    assert.ok(found, 'a client pointed at A/registry discovers server B');

    const ent = await J('GET', A + '/api/master/registry/entries', null, { 'x-master-token': masterToken });
    assert.ok(ent.j.entries.some((e) => e.url.replace(/\/$/, '') === B), 'master can list registry entries');
    const noauth = await J('GET', A + '/api/master/registry/entries');
    assert.strictEqual(noauth.status, 403, 'registry management needs the master token');

    await J('POST', A + '/api/master/registry/remove', { publicId: listed.publicId }, { 'x-master-token': masterToken });
    const after = await J('GET', A + '/registry/servers');
    assert.ok(!(after.j.servers || []).some((s) => s.url.replace(/\/$/, '') === B), 'master removed the entry');
    ann.stop();
    childB.kill();
    ok('another server announces to A/registry, a client discovers it, master can curate the list');
  } catch (e) {
    bad('announce + discover via master registry', e);
  }

  try {
    const m = JSON.parse(fs.readFileSync(path.join(TMP, 'srvA', 'master.json'), 'utf8'));
    assert.strictEqual(m.registryEnabled, true, 'registryEnabled persisted to master.json (survives restart)');
    ok('registry-enabled flag is persisted for restart');
  } catch (e) {
    bad('persistence', e);
  }

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
})();
