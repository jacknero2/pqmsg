'use strict';
/*
 * Network-failure and race-condition resilience.
 *   npm run e2e:network
 *
 *   - Client resume(): a network failure (DNS down, fetch throws) must NOT be
 *     treated the same as an expired/invalid session — only a real 401/403
 *     should force a relogin. Network failures retry with backoff instead.
 *   - Concurrent account registration for the same username must not corrupt
 *     accounts.json, and exactly one attempt must win.
 *   - Concurrent message appends into one conversation must not corrupt
 *     order.json (no dropped / duplicated / reordered entries).
 *   - Diagnostics reporter: dedupes repeated identical errors (cooldown) and
 *     never leaks secret-shaped fields into the reported context.
 *   - The public /api/diagnostics endpoint rate-limits per source IP.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-net-'));
const PORT = 8900 + (crypto.randomBytes(1)[0] % 90);
const BASE = `http://127.0.0.1:${PORT}`;

process.env.PQMSG_FED_TRUST_ALL = '1';
process.env.PQMSG_FED_ALLOW_INSECURE = '1';
process.env.PQMSG_SEED_URL = 'http://127.0.0.1:1/x'; // unroutable on purpose — no real network in this suite
process.env.PQMSG_VERSION_URL = 'http://127.0.0.1:1/x';

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
    await sleep(80);
  }
};

async function section(name, fn) {
  console.log(`\n── ${name} ─────────────────────────────`);
  try {
    await fn();
  } catch (e) {
    bad(name + ' (threw)', e);
  }
}

(async () => {
  // ========================================================================
  await section('Client resume(): network failure vs. real auth failure', async () => {
    process.env.PQMSG_DATA_DIR = path.join(TMP, 'clients');
    delete require.cache[require.resolve('../client/main/engine')];
    delete require.cache[require.resolve('../client/main/api')];
    const { Engine } = require('../client/main/engine');
    const { Api } = require('../client/main/api');

    // --- network failure: session must be KEPT, retry scheduled ---
    {
      const e = new Engine('resume-net', undefined, '0.1.0');
      e.identity = { serverUrl: 'https://dead.example.com', token: 'tok', username: 'x', deviceId: 'd1' };
      const realReq = Api.prototype._req;
      Api.prototype._req = async () => {
        throw new TypeError('fetch failed'); // exactly what a DNS failure looks like — no .status
      };
      try {
        await e.resume();
        await sleep(20);
        assert.strictEqual(e.needsLogin, false, 'network failure does NOT force a relogin');
        assert.strictEqual(e.offline, true, 'engine reports offline instead');
        assert.ok(e._resumeRetryTimer, 'a retry is scheduled');
        if (e._resumeRetryTimer) clearTimeout(e._resumeRetryTimer);
        ok('a fetch failure keeps the existing session and schedules a retry (not a forced relogin)');
      } finally {
        Api.prototype._req = realReq;
      }
    }

    // --- real 401: session must be invalidated ---
    {
      const e = new Engine('resume-401', undefined, '0.1.0');
      e.identity = { serverUrl: 'https://server.example.com', token: 'bad-tok', username: 'x', deviceId: 'd1' };
      const realReq = Api.prototype._req;
      Api.prototype._req = async () => {
        const err = new Error('unauthorized');
        err.status = 401;
        throw err;
      };
      try {
        await e.resume();
        assert.strictEqual(e.needsLogin, true, 'a real 401 DOES force a relogin');
        assert.strictEqual(e.offline, false);
        assert.ok(!e._resumeRetryTimer, 'no retry scheduled for an auth failure');
        ok('a genuine 401 forces relogin, distinct from a network failure');
      } finally {
        Api.prototype._req = realReq;
      }
    }
  });

  // ========================================================================
  // Regression test for a real bug caught live: a profile whose saved
  // identity points at a server that's gone forever (e.g. leftover from
  // local dev testing) would retry resume() forever with backoff. If the
  // user logged out or switched accounts while a retry was still pending,
  // that stale timer would eventually fire, "succeed" at failing again, and
  // silently flip needsLogin back to false — which looked like the app
  // randomly bouncing between the login screen and the dashboard.
  await section('switchAccount(): wipes local state and cannot be clobbered by a stale resume retry', async () => {
    delete require.cache[require.resolve('../client/main/engine')];
    const { Engine } = require('../client/main/engine');
    const fs = require('fs');

    const e = new Engine('switch-test', path.join(TMP, 'switch'), '0.1.0');
    e.identity = { username: 'old', serverUrl: 'http://localhost:1', token: 'tok', deviceId: 'd1' };
    e.store.saveIdentity(e.identity);
    e.store.saveContact('somebody', { devices: [] });
    assert.ok(fs.existsSync(path.join(e.store.dir, 'identity.json')));
    assert.ok(fs.existsSync(path.join(e.store.dir, 'contacts.json')));

    e.switchAccount();
    assert.strictEqual(e.identity, null, 'identity cleared in memory');
    assert.strictEqual(e.needsLogin, true);
    assert.ok(!fs.existsSync(path.join(e.store.dir, 'identity.json')), 'identity.json removed from disk');
    assert.ok(!fs.existsSync(path.join(e.store.dir, 'contacts.json')), 'cached contacts removed too — nothing leaks to the next account');
    ok('switchAccount() fully resets identity + cached local data for this profile');

    // the race: a resume() retry already in flight when switchAccount() is called
    const e2 = new Engine('switch-test-2', path.join(TMP, 'switch2'), '0.1.0');
    e2.identity = { username: 'old2', serverUrl: 'http://localhost:1', token: 'tok', deviceId: 'd1' };
    e2.api = { myDevices: () => Promise.reject(new TypeError('fetch failed')) };
    const gen = ++e2._resumeGen;
    const pending = e2._tryResume(0, gen); // starts, will land in the offline/retry branch
    e2.switchAccount(); // user switches accounts before that call resolves
    await pending;
    assert.strictEqual(e2.needsLogin, true, 'a resume attempt already in flight cannot override a switchAccount that happened after it started');
    assert.strictEqual(e2._resumeRetryTimer, null, 'switchAccount cancels the pending retry timer outright');
    ok('a stale in-flight resume() cannot clobber needsLogin after switchAccount/logout — the login/dashboard bounce is fixed');
  });

  // ========================================================================
  console.log('\n── starting a real server for HTTP-level races ─────');
  process.env.PQMSG_PORT = String(PORT);
  process.env.PQMSG_HOST = '127.0.0.1';
  process.env.PQMSG_DATA_DIR = path.join(TMP, 'server');
  process.env.PQMSG_PUBLIC = '1';
  process.env.PQMSG_PUBLIC_URL = BASE;
  delete require.cache[require.resolve('../server/src/index.js')];
  const { startServer } = require('../server/src/index.js');
  await startServer({ quiet: true });
  await until(async () => (await fetch(BASE + '/api/health').catch(() => null))?.ok, 5000);
  ok(`server up on ${BASE}`);

  await section('switchAccount(): repeated back-and-forth against a real server', async () => {
    process.env.PQMSG_SERVER_URL = BASE;
    process.env.PQMSG_DATA_DIR = path.join(TMP, 'roundtrip');
    delete require.cache[require.resolve('../client/main/engine')];
    const { Engine } = require('../client/main/engine');

    const e = new Engine('roundtrip', undefined, '0.1.0');
    e.on('update', () => {});

    const enroll = async (username) => {
      await e.register({ username, email: `${username}@test.local`, password: 'hunter2222' });
      const r = await e.login({ username, password: 'hunter2222', deviceName: username + '-dev' });
      if (r.needs2fa) await e.completeLogin({ code: r.devCode, rememberDevice: false });
      return e.identity.deviceId;
    };
    const login = async (username) => {
      const r = await e.login({ username, password: 'hunter2222', deviceName: username + '-dev-again' });
      if (r.needs2fa) await e.completeLogin({ code: r.devCode, rememberDevice: false });
      return e.identity.deviceId;
    };
    const assertBlank = (label) => {
      assert.strictEqual(e.identity, null, `${label}: identity cleared`);
      assert.strictEqual(e.needsLogin, true, `${label}: needsLogin true`);
      assert.deepStrictEqual(e.store.loadContacts(), {}, `${label}: no leftover cached contacts`);
      assert.deepStrictEqual(e.store.listConversationIds(), [], `${label}: no leftover cached conversations`);
    };

    // round 1: alice
    const aliceDevice1 = await enroll('rtalice');
    assert.strictEqual(e.identity.username, 'rtalice');
    e.switchAccount();
    assertBlank('after switch #1');

    // round 2: a different account on the same now-blank profile
    const bobDevice = await enroll('rtbob');
    assert.strictEqual(e.identity.username, 'rtbob', 'switching does not leave the old username bound');
    assert.notStrictEqual(bobDevice, aliceDevice1, 'a fresh identity means a fresh device keypair');
    e.switchAccount();
    assertBlank('after switch #2');

    // round 3: log back into the FIRST account by password — its server-side
    // account still exists (only local state was wiped), so this should
    // enroll a brand-new device for it rather than fail
    const aliceDevice2 = await login('rtalice');
    assert.strictEqual(e.identity.username, 'rtalice', 'can log back into a previously-used account after switching away from it');
    assert.notStrictEqual(aliceDevice2, aliceDevice1, 'logging back in after a wipe enrolls a new device, not a resurrected old one');
    e.switchAccount();
    assertBlank('after switch #3');

    // round 4: a third, never-before-seen account — repeated cycling doesn't degrade
    await enroll('rtcarol');
    assert.strictEqual(e.identity.username, 'rtcarol');
    assert.strictEqual(e._resumeGen >= 3, true, 'generation counter keeps advancing across repeated switches');
    e.switchAccount();
    assertBlank('after switch #4');

    ok('switchAccount() can be exercised back and forth repeatedly — different new accounts, and returning to a previously-used one — with no leftover state and no failures');
  });
  process.env.PQMSG_DATA_DIR = path.join(TMP, 'server'); // restore — later sections assume this points at the server's own data dir

  await section('Concurrent registration of the same username', async () => {
    const register = () =>
      fetch(BASE + '/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'racer', password: 'pw123456', email: 'racer@test.local' }),
      }).then((r) => r.status);
    const results = await Promise.all([register(), register(), register(), register()]);
    const winners = results.filter((s) => s === 200 || s === 201);
    const losers = results.filter((s) => s === 409);
    assert.strictEqual(winners.length, 1, `exactly one registration wins (got ${JSON.stringify(results)})`);
    assert.strictEqual(losers.length, 3, 'the rest are cleanly rejected as taken, not corrupted/crashed');
    const acctPath = path.join(process.env.PQMSG_DATA_DIR, 'accounts.json');
    const raw = fs.readFileSync(acctPath, 'utf8');
    const parsed = JSON.parse(raw); // throws if the concurrent writes corrupted the file
    assert.strictEqual(Object.keys(parsed).filter((u) => u === 'racer').length, 1);
    ok('concurrent registrations for one username: exactly one winner, accounts.json stays valid JSON');
  });

  await section('Concurrent message appends into one conversation', async () => {
    const { createStore } = require('../shared/store');
    const store = createStore({ backend: 'local', dataDir: process.env.PQMSG_DATA_DIR });
    await store.init();
    const convId = 'dm_race_test';
    await store.ensureConversation(convId, { kind: 'dm', participants: ['a@x', 'b@y'] });
    const N = 40;
    const ids = Array.from({ length: N }, (_, i) => `msg_race_${i}`);
    await Promise.all(
      ids.map((msgId) =>
        store.appendMessage(convId, { msgId, sender: 'a@x', ciphertext: 'xx', ts: Date.now() })
      )
    );
    const order = JSON.parse(
      fs.readFileSync(path.join(process.env.PQMSG_DATA_DIR, 'conversations', convId, 'order.json'), 'utf8')
    );
    assert.strictEqual(order.order.length, N, `all ${N} messages landed in order.json (got ${order.order.length})`);
    assert.strictEqual(new Set(order.order).size, N, 'no duplicate entries');
    const seqs = new Set();
    for (const msgId of ids) {
      const msg = await store.getMessage(convId, msgId);
      assert.ok(msg, `message ${msgId} readable back`);
      assert.ok(!seqs.has(msg.serverSeq), `serverSeq ${msg.serverSeq} not reused`);
      seqs.add(msg.serverSeq);
    }
    assert.strictEqual(seqs.size, N, 'every message got a unique, contiguous serverSeq');
    ok(`${N} concurrent appends into the same conversation: no drops, dupes, or corrupted order.json`);
  });

  await section('Diagnostics endpoint: per-IP rate limit', async () => {
    const hit = () =>
      fetch(BASE + '/api/diagnostics', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'test', message: 'hammer' }),
      }).then((r) => r.status);
    const results = [];
    for (let i = 0; i < 15; i++) results.push(await hit());
    assert.ok(results.slice(0, 10).every((s) => s === 200), 'first 10 reports/min are accepted');
    assert.ok(results.slice(10).some((s) => s === 429), 'requests past the limit get 429, not silently dropped or crashed');
    ok('POST /api/diagnostics rate-limits a spammy source IP instead of relaying everything');
  });

  await section('Diagnostics reporter: cooldown dedupe + secret scrubbing', async () => {
    const { reportIssue } = require('../shared/diagnostics');
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, opts) => {
      calls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
      if (String(url).includes('/search/issues')) return { ok: true, json: async () => ({ items: [] }) };
      return { ok: true, json: async () => ({ number: 42 }) };
    };
    try {
      const args = {
        token: 'tok',
        repo: 'you/pqmsg',
        component: 'server',
        kind: 'test-error',
        message: 'boom',
        context: { smtpPass: 'sh0uldNeverAppear', adminToken: 'sh0uldNeverAppear', ok: 'fine' },
      };
      const r1 = await reportIssue(args);
      const r2 = await reportIssue(args); // identical fingerprint, immediately after
      assert.ok(r1.ok, 'first report succeeds');
      assert.strictEqual(r2.ok, false, 'second identical report is suppressed by the cooldown');
      assert.strictEqual(r2.reason, 'cooldown');
      const createCall = calls.find((c) => c.body && c.body.body);
      assert.ok(createCall, 'issue body was sent');
      assert.ok(!createCall.body.body.includes('sh0uldNeverAppear'), 'secret-shaped context keys never reach GitHub');
      assert.ok(createCall.body.body.includes('"ok": "fine"'), 'non-secret context keys are preserved');
      ok('repeated identical errors are deduped, and secret-shaped fields are scrubbed before reporting');
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
