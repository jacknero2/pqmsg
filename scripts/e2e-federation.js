'use strict';
/*
 * Cross-server federation end-to-end (no Electron).
 * Two servers A + B; users spread across both; DMs and groups that span servers;
 * conversation acceptance; membership changes; ordering convergence; and the
 * auth boundary (non-participants / forged senders rejected).
 *   npm run e2e:federation
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-fed-'));
const PA = 8400 + (crypto.randomBytes(1)[0] % 120);
const PB = PA + 137;
const A = `http://127.0.0.1:${PA}`;
const B = `http://127.0.0.1:${PB}`;

process.env.PQMSG_FED_TRUST_ALL = '1';
process.env.PQMSG_FED_ALLOW_INSECURE = '1';
process.env.PQMSG_SEED_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_VERSION_URL = 'http://127.0.0.1:1/x';

const pqc = require('../shared/crypto');

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

// two server processes in one node process — the module is a singleton, so run B
// in a child. Simpler: both servers share the module but startServer() is
// once-per-process. -> spawn B as a child via a tiny inline script.
const { spawn } = require('child_process');
function startChildServer(port, pub, dir) {
  const code = `
    process.env.PQMSG_PORT='${port}'; process.env.PQMSG_HOST='127.0.0.1';
    process.env.PQMSG_DATA_DIR=${JSON.stringify(dir)};
    process.env.PQMSG_PUBLIC='1'; process.env.PQMSG_PUBLIC_URL='${pub}';
    process.env.PQMSG_FED_TRUST_ALL='1'; process.env.PQMSG_FED_ALLOW_INSECURE='1';
    require(${JSON.stringify(path.join(__dirname, '..', 'server', 'src', 'index.js'))})
      .startServer({ quiet: true }).then(()=>console.log('UP')).catch(e=>{console.error(e);process.exit(1)});
  `;
  const p = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => {
    p.stdout.on('data', (d) => String(d).includes('UP') && resolve(p));
  });
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
  console.log('\n── two servers ──────────────────────────────────');
  process.env.PQMSG_PORT = String(PA);
  process.env.PQMSG_HOST = '127.0.0.1';
  process.env.PQMSG_DATA_DIR = path.join(TMP, 'srvA');
  process.env.PQMSG_PUBLIC = '1';
  process.env.PQMSG_PUBLIC_URL = A;
  const { startServer } = require('../server/src/index.js');
  await startServer({ quiet: true });
  const childB = await startChildServer(PB, B, path.join(TMP, 'srvB'));
  await waitHealth(A);
  await waitHealth(B);
  ok(`server A on ${A}, server B on ${B} (home = ${pqc.homeServer([`x@${A}`, `x@${B}`])})`);

  process.env.PQMSG_DATA_DIR = path.join(TMP, 'clients');
  const { Engine } = require('../client/main/engine');
  const mk = async (name, srv) => {
    const e = new Engine(name, undefined, '0.1.0');
    e.on('update', () => {});
    await e.register({ serverUrl: srv, username: name, email: `${name}@test.local`, password: 'pw123456' });
    const r = await e.login({ serverUrl: srv, username: name, password: 'pw123456', deviceName: name + '-dev' });
    if (r.needs2fa) await e.completeLogin({ code: r.devCode, rememberDevice: true });
    e.stopLoops();
    return e;
  };
  const alice = await mk('alice', A);
  const bob = await mk('bob', B);
  const carol = await mk('carol', A);
  const dave = await mk('dave', B);
  const eve = await mk('eve', B);
  ok('alice,carol enrolled on A; bob,dave,eve on B');

  const H = { alice: alice.myHandle, bob: bob.myHandle, carol: carol.myHandle, dave: dave.myHandle, eve: eve.myHandle };

  // ---- cross-server DM + acceptance ----
  console.log('\n── cross-server DM + accept/decline ─────────────');
  let dm;
  try {
    dm = await alice.startConversation('bob@127.0.0.1:' + PB);
    assert.strictEqual(dm, pqc.dmConvId(H.alice, H.bob), 'both sides derive the same convId from handles');
    await alice.sendMessage(dm, 'hi bob, this crossed a server boundary');
    const req = await until(async () => {
      await bob.syncOnce('t');
      const v = bob.listConversationsView().find((c) => c.convId === dm);
      return v && v.status === 'pending' ? v : null;
    });
    assert.ok(req, 'bob sees an incoming conversation request');
    assert.ok(/alice/.test(req.requestFrom), 'request is attributed to alice');
    ok('bob gets a pending "accept conversation from @alice?" request (no messages pulled yet)');
  } catch (e) {
    bad('cross-server DM request', e);
  }

  try {
    bob.acceptConversation(dm);
    const got = await until(async () => {
      await bob.syncOnce('t');
      return bob.getConversationView(dm).messages.find((m) => m.text.includes('crossed a server boundary')) || null;
    });
    assert.ok(got && got.verified, 'after accepting, bob decrypts + verifies alice’s message');
    const deliv = await until(async () => {
      await alice.syncOnce('t');
      const m = alice.getConversationView(dm).messages.find((m) => m.mine);
      return m && m.display === 'delivered' ? m : null;
    });
    assert.ok(deliv, 'alice sees the message go gold/delivered once bob (on the other server) acks');
    await bob.sendMessage(dm, 'got it — replying from server B');
    const back = await until(async () => {
      await alice.syncOnce('t');
      return alice.getConversationView(dm).messages.some((m) => m.text.includes('replying from server B') && m.verified);
    });
    assert.ok(back, 'bob’s reply reaches alice, decrypted + verified');
    ok('accept → full bidirectional cross-server DM with delivery receipts');
  } catch (e) {
    bad('cross-server DM after accept', e);
  }

  // ---- same-server DM still works ----
  const acceptWhenPending = async (e, convId) => {
    await until(async () => {
      await e.syncOnce('t');
      const v = e.listConversationsView().find((c) => c.convId === convId);
      return v && (v.status === 'pending' || v.status === 'active') ? v : null;
    });
    e.acceptConversation(convId);
  };
  try {
    const cd = await carol.startConversation('alice');
    assert.strictEqual(pqc.homeServer([H.carol, H.alice]), pqc.normServer(A), 'same-server DM home = that server');
    await carol.sendMessage(cd, 'carol -> alice, same server');
    await acceptWhenPending(alice, cd);
    const seen = await until(async () => {
      await alice.syncOnce('t');
      return alice.getConversationView(cd).messages.some((m) => m.text.includes('same server') && m.verified);
    });
    assert.ok(seen, 'same-server DM unaffected by federation changes');
    ok('same-server DM regression check');
  } catch (e) {
    bad('same-server DM', e);
  }

  // ---- cross-server group ----
  console.log('\n── cross-server group + membership ──────────────');
  let g;
  try {
    g = await alice.startGroup({ name: 'trio', members: ['bob@127.0.0.1:' + PB, 'carol@127.0.0.1:' + PA] });
    assert.ok(/^grp_[0-9a-f]{32}$/.test(g), 'group gets a minted id');
    await alice.sendMessage(g, 'welcome to the trio (spanning A and B)');
    for (const [who, e] of [['bob', bob], ['carol', carol]]) {
      await acceptWhenPending(e, g);
      const seen = await until(async () => {
        await e.syncOnce('t');
        return e.getConversationView(g).messages.some((m) => m.text.includes('spanning A and B') && m.verified);
      });
      assert.ok(seen, `${who} decrypts the group message`);
    }
    await carol.sendMessage(g, 'carol here, hi both');
    const aliceSaw = await until(async () => {
      await alice.syncOnce('t');
      return alice.getConversationView(g).messages.some((m) => m.text.includes('carol here') && m.verified);
    });
    const bobSaw = await until(async () => {
      await bob.syncOnce('t');
      return bob.getConversationView(g).messages.some((m) => m.text.includes('carol here') && m.verified);
    });
    assert.ok(aliceSaw && bobSaw, 'a group message from carol (A) reaches alice (A) and bob (B)');
    ok('3-way group across two servers, all members decrypt each other');
  } catch (e) {
    bad('cross-server group', e);
  }

  try {
    await alice.addGroupMember(g, 'dave@127.0.0.1:' + PB);
    await alice.sendMessage(g, 'dave just joined');
    await acceptWhenPending(dave, g);
    const daveGot = await until(async () => {
      await dave.syncOnce('t');
      return dave.getConversationView(g).messages.some((m) => m.text.includes('dave just joined') && m.verified);
    });
    assert.ok(daveGot, 'newly added member receives post-join messages');
    const daveHasHistory = dave.getConversationView(g).messages.some((m) => m.text.includes('welcome to the trio'));
    assert.ok(!daveHasHistory, 'new member does NOT get pre-join history (was not a recipient)');
    ok('add member: gets new messages, not old ones');
  } catch (e) {
    bad('group add member', e);
  }

  try {
    await alice.removeGroupMember(g, 'bob@127.0.0.1:' + PB);
    await alice.sendMessage(g, 'post-removal message');
    await sleep(200);
    let bobErr = null;
    try {
      await bob.syncOnce('t');
    } catch (e) {
      bobErr = e;
    }
    const bobHasIt = bob.getConversationView(g).messages.some((m) => m.text.includes('post-removal'));
    assert.ok(!bobHasIt, 'removed member cannot read messages sent after removal');
    ok('remove member: loses access to subsequent messages');
  } catch (e) {
    bad('group remove member', e);
  }

  // ---- ordering convergence across servers ----
  console.log('\n── eventual-consistency ordering ────────────────');
  try {
    for (let i = 1; i <= 6; i++) await (i % 2 ? alice : carol).sendMessage(g, 'burst ' + i);
    for (let r = 0; r < 5; r++) {
      await alice.syncOnce('t');
      await carol.syncOnce('t');
      await dave.syncOnce('t');
      await sleep(40);
    }
    const seqs = (e) => e.getConversationView(g).messages.map((m) => m.serverSeq).filter((x) => x != null);
    const a = seqs(alice), c = seqs(carol), d = seqs(dave);
    assert.deepStrictEqual(a, [...a].sort((x, y) => x - y), 'alice order monotone in serverSeq');
    assert.deepStrictEqual(a, c, 'alice and carol converge to identical order');
    assert.deepStrictEqual(d, [...d].sort((x, y) => x - y), 'dave order monotone');
    assert.deepStrictEqual(d, a.filter((s) => d.includes(s)), 'dave’s view is the canonical order restricted to what he can see');
    ok('all replicas converge to the home server’s canonical order [' + a.join(',') + ']');
  } catch (e) {
    bad('ordering convergence', e);
  }

  // ---- auth boundary ----
  console.log('\n── federation auth boundary ─────────────────────');
  const home = pqc.homeServer([H.alice, H.bob]);
  try {
    const env = pqc.encryptEnvelope({
      body: { text: 'i should be rejected' },
      sender: H.eve,
      senderDevice: eve.identity.deviceId,
      convId: dm,
      seq: 99,
      prevId: null,
      recipients: [{ deviceId: alice.identity.deviceId, kemPublicKey: (await eve.refreshContact(H.alice)).devices[0].kemPublicKey }],
      sigSecretKey: eve.identity.sigSecretKey,
    });
    let status = 0;
    try {
      await eve._fed('POST', home, `/api/conv/${dm}/messages`, { body: { envelope: env, participants: [H.alice, H.bob], kind: 'dm' } });
    } catch (e) {
      status = e.status;
    }
    assert.strictEqual(status, 403, 'non-participant sender rejected (403)');
    ok('a stranger cannot post into a conversation they are not part of');
  } catch (e) {
    bad('non-participant post', e);
  }

  try {
    // eve forges sender = alice but signs with her own device key
    const env = pqc.encryptEnvelope({
      body: { text: 'forged' },
      sender: H.alice,
      senderDevice: eve.identity.deviceId,
      convId: dm,
      seq: 100,
      prevId: null,
      recipients: [{ deviceId: bob.identity.deviceId, kemPublicKey: (await eve.refreshContact(H.bob)).devices[0].kemPublicKey }],
      sigSecretKey: eve.identity.sigSecretKey,
    });
    let status = 0;
    try {
      await eve._fed('POST', home, `/api/conv/${dm}/messages`, { body: { envelope: env, participants: [H.alice, H.bob], kind: 'dm' } });
    } catch (e) {
      status = e.status;
    }
    assert.strictEqual(status, 400, 'forged sender / bad signature rejected (400)');
    ok('forging another user as the sender fails signature verification');
  } catch (e) {
    bad('forged sender', e);
  }

  try {
    let status = 0;
    try {
      await eve._fed('GET', home, `/api/conv/${dm}/messages`, { auth: true, convId: dm });
    } catch (e) {
      status = e.status;
    }
    assert.strictEqual(status, 403, 'signed read by a non-participant rejected (403)');
    ok('a stranger with a valid signed request still cannot read a conversation');
  } catch (e) {
    bad('non-participant read', e);
  }

  try {
    // alice posts a DM to the WRONG server (B) — home is A
    const wrong = home === pqc.normServer(A) ? B : A;
    const env = pqc.encryptEnvelope({
      body: { text: 'misdirected' },
      sender: H.alice,
      senderDevice: alice.identity.deviceId,
      convId: dm,
      seq: 200,
      prevId: null,
      recipients: [{ deviceId: bob.identity.deviceId, kemPublicKey: (await alice.refreshContact(H.bob)).devices[0].kemPublicKey }],
      sigSecretKey: alice.identity.sigSecretKey,
    });
    let body = null,
      status = 0;
    try {
      await alice._fed('POST', wrong, `/api/conv/${dm}/messages`, { body: { envelope: env, participants: [H.alice, H.bob], kind: 'dm' } });
    } catch (e) {
      status = e.status;
      body = e.body;
    }
    assert.strictEqual(status, 421, 'wrong server replies 421 Misdirected');
    assert.strictEqual(pqc.normServer(body.homeServer), home, '421 tells the client the correct home server');
    ok('a message sent to the wrong server is bounced with the right home address');
  } catch (e) {
    bad('misdirected write', e);
  }

  // ---- server sees only ciphertext ----
  try {
    const admTok = (await (await fetch(A + '/api/serverinfo')).json()) && null; // serverinfo has no token; read secret file
    const sec = JSON.parse(fs.readFileSync(path.join(TMP, 'srvA', 'server-secret.json'), 'utf8'));
    const j = await (await fetch(`${A}/api/admin/conv/${dm}?admin=${sec.adminToken}`)).json();
    assert.ok(!JSON.stringify(j).includes('crossed a server boundary'), 'home server stores only ciphertext');
    ok('home server dashboard view is ciphertext-only (' + j.messages.length + ' msgs)');
  } catch (e) {
    bad('ciphertext-only', e);
  }

  childB.kill();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {}
  process.exit(fail ? 1 : 0);
})();
