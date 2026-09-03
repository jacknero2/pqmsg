'use strict';
/*
 * Registry end-to-end: registry service + an announcing server + client-side
 * discovery + the client-version gate logic. No Electron.
 *   npm run e2e:registry
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-reg-'));
const REG_PORT = 8600 + (crypto.randomBytes(1)[0] % 300);
const SRV_PORT = 8300 + (crypto.randomBytes(1)[0] % 300);
const REG_URL = `http://127.0.0.1:${REG_PORT}`;
const SRV_URL = `http://127.0.0.1:${SRV_PORT}`;

let pass = 0,
  fail = 0;
const ok = (n) => (pass++, console.log('  \x1b[32m✓\x1b[0m ' + n));
const bad = (n, e) => (fail++, console.log('  \x1b[31m✗\x1b[0m ' + n + '  — ' + (e && e.message ? e.message : e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(120);
  }
};

(async () => {
  console.log('\n── registry service ──────────────────────────────');
  const { createRegistry } = require('../registry');
  const reg = createRegistry({
    port: REG_PORT,
    host: '127.0.0.1',
    dataDir: path.join(TMP, 'registry'),
    trustAllUrls: true, // loopback server URL
    quiet: true,
    staleSec: 300,
  });
  await reg.start();
  ok(`registry up on :${REG_PORT}`);

  console.log('\n── announcing server ─────────────────────────────');
  const { startServer } = require('../server/src/index.js');
  process.env.PQMSG_PORT = String(SRV_PORT);
  const srv = await startServer({
    port: SRV_PORT,
    host: '127.0.0.1',
    dataDir: path.join(TMP, 'server'),
    quiet: true,
    public: true,
    announce: true,
    registryUrl: REG_URL,
    serverName: 'Test Server',
    serverDescription: 'e2e registry check',
    serverPublicUrl: SRV_URL,
  });
  ok('server started with announce=true');

  try {
    const info = await (await fetch(SRV_URL + '/api/serverinfo')).json();
    assert.ok(info.publicId && info.publicId.startsWith('pid_'), '/api/serverinfo exposes publicId');
    assert.strictEqual(info.name, 'Test Server');
    ok('server /api/serverinfo advertises name + publicId (' + info.publicId.slice(0, 12) + '…)');
  } catch (e) {
    bad('serverinfo', e);
  }

  let listed;
  try {
    listed = await until(async () => {
      const j = await (await fetch(REG_URL + '/servers')).json();
      return j.servers.find((s) => s.url.replace(/\/$/, '') === SRV_URL && s.verified) || null;
    });
    assert.ok(listed, 'server appears in GET /servers as verified');
    assert.strictEqual(listed.name, 'Test Server');
    ok('registry lists the server as verified after callback check');
  } catch (e) {
    bad('registry listing', e);
  }

  console.log('\n── client-side discovery ─────────────────────────');
  try {
    const disc = require('../client/main/discovery');
    const { servers } = await disc.discover({ registryUrl: REG_URL, pinned: [] });
    const mine = servers.find((s) => s.url === SRV_URL);
    assert.ok(mine, 'discover() merges the registry entry');
    const probed = await disc.probe(SRV_URL);
    assert.ok(probed.online && probed.name === 'Test Server', 'probe() reports online + name');
    ok('client discovers + probes the server (' + probed.latencyMs + 'ms)');
  } catch (e) {
    bad('client discovery', e);
  }

  console.log('\n── client version gate ───────────────────────────');
  try {
    const { versionVerdict } = require('../client/main/discovery');
    assert.deepStrictEqual(versionVerdict('0.1.0', { latest: '0.1.0', minSupported: '0.0.0' }, null), { gate: null, update: null });
    assert.ok(versionVerdict('0.1.0', { minSupported: '0.2.0' }, null).gate, 'global floor 0.2.0 hard-blocks 0.1.0');
    const sg = versionVerdict('0.1.0', {}, { minClient: '0.5.0', downloadUrl: 'x' }).gate;
    assert.ok(sg && sg.source === 'server', 'server floor hard-blocks + is attributed to the server');
    const up = versionVerdict('0.1.0', { latest: '0.3.0', minSupported: '0.0.0' }, null).update;
    assert.ok(up && up.latest === '0.3.0', 'newer latest -> soft update prompt, no gate');
    ok('versionVerdict: floors block, newer-latest nags, matching version passes');
  } catch (e) {
    bad('version gate', e);
  }

  console.log('\n── anti-abuse ────────────────────────────────────');
  try {
    const { loadOrCreateIdentity, canonical } = require('../shared/ed25519');
    const other = loadOrCreateIdentity(path.join(TMP, 'squatter.json'));
    const body = {
      name: 'Test Server', // already owned by the real server's key
      url: 'https://evil.example.com',
      description: '',
      region: '',
      publicJwk: other.publicJwk,
      ts: Date.now(),
    };
    body.sig = other.sign(canonical({ name: body.name, url: body.url, description: '', region: '', publicJwk: body.publicJwk, ts: body.ts }));
    const res = await fetch(REG_URL + '/announce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.strictEqual(res.status, 409, 'second key claiming an owned name is rejected 409');
    ok('name squatting blocked (first-come TOFU ownership)');

    const badsig = { ...body, url: 'https://evil2.example.com', publicJwk: other.publicJwk, ts: Date.now(), sig: 'AAAA' };
    const r2 = await fetch(REG_URL + '/announce', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...badsig, name: 'Evil' }) });
    assert.strictEqual(r2.status, 401, 'bad signature rejected 401');
    ok('unsigned / bad-signature announce rejected');
  } catch (e) {
    bad('anti-abuse', e);
  }

  console.log('\n── graceful deregister ───────────────────────────');
  try {
    await srv.stopAnnouncing();
    const gone = await until(async () => {
      const j = await (await fetch(REG_URL + '/servers')).json();
      return j.servers.every((s) => s.url.replace(/\/$/, '') !== SRV_URL);
    }, 3000);
    assert.ok(gone, 'server removed from /servers after DELETE /announce');
    ok('graceful deregister on shutdown');
  } catch (e) {
    bad('deregister', e);
  }

  await srv.close();
  await reg.stop();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
