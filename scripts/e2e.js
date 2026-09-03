'use strict';
/*
 * End-to-end check with NO Electron: boots the real server in-process, drives
 * two client engines (alice, bob), and verifies:
 *   - enrollment into the IDS
 *   - post-quantum encrypt -> server -> decrypt round trip
 *   - signature verification
 *   - delivery acks flipping a message from "undelivered" (red) to "delivered" (gold)
 *   - eventual-consistency ordering: both replicas converge to the server order
 *
 * Run:  npm run e2e
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const PORT = 8000 + (crypto.randomBytes(1)[0] % 800);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-e2e-'));

process.env.PQMSG_PORT = String(PORT);
process.env.PQMSG_HOST = '127.0.0.1';
process.env.STORE_BACKEND = 'local';
process.env.PQMSG_DATA_DIR = path.join(TMP, 'server');
// keep the client's discovery/version checks off the network during the test
process.env.PQMSG_SEED_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_VERSION_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_ADMIN_TOKEN = 'e2e-admin';

const pqc = require('../shared/crypto');

let pass = 0;
let fail = 0;
const ok = (name) => {
  pass++;
  console.log('  \x1b[32m✓\x1b[0m ' + name);
};
const bad = (name, e) => {
  fail++;
  console.log('  \x1b[31m✗\x1b[0m ' + name + '  — ' + (e && e.message ? e.message : e));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns truthy or the deadline passes (for fire-and-forget
 *  paths like delivery acks, which the sync loop reconciles asynchronously). */
async function until(fn, { timeout = 4000, step = 100 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
}

async function waitHealth() {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return;
    } catch {}
    await sleep(100);
  }
  throw new Error('server did not come up');
}

(async () => {
  console.log('\n── crypto primitives ─────────────────────────────');
  try {
    const A = pqc.generateIdentity();
    const B = pqc.generateIdentity();
    const env = pqc.encryptEnvelope({
      body: { text: 'unit test payload ✦' },
      sender: 'a',
      senderDevice: pqc.deviceIdFromSigPub(A.sigPublicKey),
      convId: 'dm_test',
      seq: 1,
      prevId: null,
      recipients: [{ deviceId: pqc.deviceIdFromSigPub(B.sigPublicKey), kemPublicKey: B.kemPublicKey }],
      sigSecretKey: A.sigSecretKey,
    });
    assert.ok(pqc.verifyEnvelope(env, A.sigPublicKey), 'sig verifies');
    assert.ok(!pqc.verifyEnvelope(env, B.sigPublicKey), 'sig fails for wrong key');
    const dec = pqc.decryptEnvelope(env, pqc.deviceIdFromSigPub(B.sigPublicKey), B.kemSecretKey);
    assert.strictEqual(dec.body.text, 'unit test payload ✦');
    ok('ML-KEM/ML-DSA/AES-GCM envelope round trip + signature checks');
  } catch (e) {
    bad('crypto round trip', e);
  }
  try {
    const A = pqc.generateIdentity();
    const att = pqc.signEnrollment(A, { username: 'alice', deviceName: 'lap' });
    assert.ok(pqc.verifyEnrollment({ username: 'alice', deviceName: 'lap', kemPublicKey: A.kemPublicKey, sigPublicKey: A.sigPublicKey, attestation: att }));
    assert.ok(!pqc.verifyEnrollment({ username: 'mallory', deviceName: 'lap', kemPublicKey: A.kemPublicKey, sigPublicKey: A.sigPublicKey, attestation: att }));
    ok('enrollment attestation binds keys to the username');
  } catch (e) {
    bad('enrollment attestation', e);
  }

  console.log('\n── server + two client engines ───────────────────');
  const { startServer } = require('../server/src/index.js');
  await startServer({ quiet: false });
  await waitHealth();
  ok(`server up on :${PORT} (data ${process.env.PQMSG_DATA_DIR})`);

  // clients get their own data root
  process.env.PQMSG_DATA_DIR = path.join(TMP, 'clients');
  const { Engine } = require('../client/main/engine');
  const S = `http://127.0.0.1:${PORT}`;
  const alice = new Engine('alice');
  const bob = new Engine('bob');
  const quiet = (e) => e; // engines emit 'update' a lot; ignore
  alice.on('update', quiet);
  bob.on('update', quiet);

  const enroll = async (e, name, dev) => {
    await e.register({ serverUrl: S, username: name, email: `${name}@test.local`, password: 'hunter2' });
    const r = await e.login({ serverUrl: S, username: name, password: 'hunter2', deviceName: dev });
    if (r.needs2fa) await e.completeLogin({ code: r.devCode, rememberDevice: true }); // dev mode returns the code
    e.stopLoops();
  };
  try {
    await enroll(alice, 'alice', 'alice-laptop');
    await enroll(bob, 'bob', 'bob-phone');
    ok('both accounts registered (with email) + 2FA + devices enrolled in IDS');
  } catch (e) {
    bad('register/login/enroll', e);
  }

  let convId;
  try {
    convId = await alice.startConversation('bob');
    assert.strictEqual(convId, pqc.dmConvId(alice.myHandle, bob.myHandle));
    ok('alice resolved bob via IDS, conversation id = ' + convId);
  } catch (e) {
    bad('startConversation', e);
  }

  try {
    await alice.sendMessage(convId, 'hello bob — post-quantum secured');
    // bob must accept the incoming conversation before messages flow
    await until(async () => {
      await bob.syncOnce('test');
      const v = bob.listConversationsView().find((c) => c.convId === convId);
      return v && v.status === 'pending';
    });
    bob.acceptConversation(convId);
    const m = await until(async () => {
      await bob.syncOnce('test');
      return bob.getConversationView(convId).messages.find((x) => x.text === 'hello bob — post-quantum secured') || null;
    });
    assert.ok(m, 'bob decrypted the message');
    assert.strictEqual(m.verified, true, 'bob verified the signature');
    assert.strictEqual(m.display, 'received');
    ok('bob received + decrypted + verified alice’s message');
  } catch (e) {
    bad('a->b message', e);
  }

  try {
    // bob's delivery ack is fire-and-forget; poll until alice's sync reconciles it
    const m = await until(async () => {
      await bob.syncOnce('test');
      await alice.syncOnce('test');
      const v = alice.getConversationView(convId);
      const msg = v.messages.find((x) => x.text === 'hello bob — post-quantum secured');
      return msg && msg.display === 'delivered' ? msg : null;
    });
    assert.ok(m, 'alice sees gold/delivered after bob’s ack');
    ok('delivery ack: alice’s message flipped undelivered(red) -> delivered(gold)');
  } catch (e) {
    bad('delivery ack', e);
  }

  try {
    await bob.sendMessage(convId, 'got it — is it gold now?');
    const got = await until(async () => {
      await alice.syncOnce('test');
      return alice.getConversationView(convId).messages.some((x) => x.text === 'got it — is it gold now?' && x.verified);
    });
    assert.ok(got, 'alice decrypts + verifies the reply');
    ok('reply path b->a decrypts + verifies');
  } catch (e) {
    bad('b->a message', e);
  }

  try {
    // rapid burst, then confirm both replicas converge to identical server order
    for (let i = 1; i <= 6; i++) {
      await (i % 2 ? alice : bob).sendMessage(convId, 'burst ' + i);
    }
    for (let r = 0; r < 4; r++) {
      await alice.syncOnce('test');
      await bob.syncOnce('test');
      await sleep(30);
    }
    const oa = alice.getConversationView(convId).messages.map((m) => m.serverSeq);
    const ob = bob.getConversationView(convId).messages.map((m) => m.serverSeq);
    const monotone = oa.filter((x) => x != null);
    assert.deepStrictEqual(
      monotone,
      [...monotone].sort((a, b) => a - b),
      'alice order is monotone in serverSeq'
    );
    assert.deepStrictEqual(oa, ob, 'alice and bob converged to the same order');
    ok('eventual consistency: both replicas match server canonical order [' + oa.join(',') + ']');
  } catch (e) {
    bad('ordering convergence', e);
  }

  try {
    const r = await fetch(`${S}/api/admin/conv/${convId}`, { headers: { 'X-Admin-Token': 'e2e-admin' } });
    const j = await r.json();
    const anyPlaintext = JSON.stringify(j).includes('post-quantum secured');
    assert.ok(!anyPlaintext, 'server admin view contains no plaintext');
    ok('server dashboard view is ciphertext-only (' + j.messages.length + ' msgs, order len ' + j.order.length + ')');
  } catch (e) {
    bad('server sees only ciphertext', e);
  }

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
})();
