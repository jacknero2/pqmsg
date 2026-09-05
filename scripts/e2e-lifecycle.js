'use strict';
/*
 * Conversation + account lifecycle: delete-a-chat (deleter-only, re-prompt
 * on new activity), block / unblock, and account deletion (self + admin).
 *   npm run e2e:lifecycle
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const PORT = 8500 + (crypto.randomBytes(1)[0] % 200);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-life-'));
process.env.PQMSG_PORT = String(PORT);
process.env.PQMSG_HOST = '127.0.0.1';
process.env.STORE_BACKEND = 'local';
process.env.PQMSG_DATA_DIR = path.join(TMP, 'server');
process.env.PQMSG_SEED_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_VERSION_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_ADMIN_TOKEN = 'e2e-admin';
process.env.PQMSG_PUBLIC = '1'; // enforce real admin auth (no loopback bypass)
process.env.PQMSG_PUBLIC_URL = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ok = (n) => (pass++, console.log('  \x1b[32m✓\x1b[0m ' + n));
const bad = (n, e) => (fail++, console.log('  \x1b[31m✗\x1b[0m ' + n + '  — ' + (e && e.message ? e.message : e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 5000, step = 80 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); }
}
async function section(name, fn) {
  console.log(`\n── ${name} ─────────────────────────────`);
  try { await fn(); } catch (e) { bad(name + ' (threw)', e); }
}
const S = () => `http://127.0.0.1:${PORT}`;

(async () => {
  const { startServer } = require('../server/src/index.js');
  await startServer({ quiet: true });
  await until(async () => (await fetch(`${S()}/api/health`).catch(() => null))?.ok);

  process.env.PQMSG_DATA_DIR = path.join(TMP, 'clients');
  process.env.PQMSG_SERVER_URL = S();
  const { Engine } = require('../client/main/engine');
  const mk = (p) => { const e = new Engine(p); e.on('update', () => {}); return e; };
  const enroll = async (e, n) => {
    await e.register({ username: n, email: `${n}@t.local`, password: 'hunter2' });
    const r = await e.login({ username: n, password: 'hunter2', deviceName: n + '-dev' });
    if (r.needs2fa) await e.completeLogin({ code: r.devCode, rememberDevice: true });
    e.stopLoops();
  };

  const alice = mk('alice'), bob = mk('bob');
  const sync = async (parties, n = 8) => { for (let i = 0; i < n; i++) { for (const p of parties) await p.syncOnce('t'); await sleep(20); } };
  await enroll(alice, 'alice');
  await enroll(bob, 'bob');
  const cid = await alice.startConversation('bob');
  await alice.sendMessage(cid, 'old message 1');
  await until(async () => { await bob.syncOnce('t'); return bob.listConversationsView().find((c) => c.convId === cid && c.status === 'pending'); });
  bob.acceptConversation(cid);
  await sync([alice, bob]);
  await bob.sendMessage(cid, 'old message 2');
  await sync([alice, bob]);

  // ---------------------------------------------------------------------
  await section('delete a chat: gone on the deleter side, intact on the peer', async () => {
    assert.ok(alice.listConversationsView().some((c) => c.convId === cid), 'alice has the chat');
    alice.deleteConversation(cid);
    assert.ok(!alice.listConversationsView().some((c) => c.convId === cid), 'chat disappears from alice list');
    assert.strictEqual(alice.getConversationView(cid), null, 'alice cannot open the deleted chat');
    // bob is untouched
    const bv = bob.getConversationView(cid);
    assert.ok(bv && bv.messages.length >= 2, 'bob still has full history');
    // a plain re-sync with no new activity must NOT bring it back
    await sync([alice], 6);
    assert.ok(!alice.listConversationsView().some((c) => c.convId === cid), 'stays gone with no new activity');
    ok('deleting a chat removes it locally and leaves the peer copy whole');
  });

  await section('deleted chat re-surfaces (fresh, no old history) when the peer writes again', async () => {
    await bob.sendMessage(cid, 'hey, you there? (new)');
    await sync([alice, bob], 10);
    const c = alice.listConversationsView().find((x) => x.convId === cid);
    assert.ok(c, 'chat is back on alice side');
    assert.strictEqual(c.status, 'pending', 're-surfaces as a fresh request, not silently active');
    alice.acceptConversation(cid);
    await sync([alice, bob], 10);
    const v = alice.getConversationView(cid);
    const texts = v.messages.map((m) => m.text);
    assert.ok(texts.includes('hey, you there? (new)'), 'the new message is there');
    assert.ok(!texts.includes('old message 1') && !texts.includes('old message 2'), 'pre-deletion history stays gone');
    ok('a new message from the peer re-prompts the deleter with a clean slate');
  });

  // ---------------------------------------------------------------------
  await section('block: blocked -> blocker send is refused; blocker -> blocked still works', async () => {
    await alice.blockPeer(cid);
    await sync([alice, bob], 8);
    // bob learns he is blocked
    const bv = bob.getConversationView(cid);
    assert.strictEqual(bv.blockedByPeer, true, 'bob\'s client knows the peer blocked him');
    assert.ok(bv.messages.some((m) => m.system && /blocked you/.test(m.text)), 'bob sees an in-chat "blocked you" notice');
    // bob tries to send -> server refuses, client flips to blocked
    await bob.sendMessage(cid, 'let me back in');
    await sync([bob], 6);
    const failed = bob.getConversationView(cid).messages.find((m) => m.text === 'let me back in');
    assert.strictEqual(failed.display, 'failed', 'the blocked send is marked failed');
    // alice can still reach bob
    await alice.sendMessage(cid, 'you are blocked, sorry');
    await sync([alice, bob], 8);
    assert.ok(bob.getConversationView(cid).messages.some((m) => m.text === 'you are blocked, sorry'), 'blocker -> blocked direction still delivers');
    ok('block cuts only the blocked->blocker direction, with an in-chat notice');
  });

  await section('unblock restores two-way messaging', async () => {
    await alice.unblockPeer(cid);
    await sync([alice, bob], 8);
    const bv = bob.getConversationView(cid);
    assert.strictEqual(bv.blockedByPeer, false, 'bob is no longer blocked');
    assert.ok(bv.messages.some((m) => m.system && /unblocked you/.test(m.text)), 'bob sees the "unblocked you" notice');
    await bob.sendMessage(cid, 'thanks, back now');
    await sync([alice, bob], 8);
    assert.ok(alice.getConversationView(cid).messages.some((m) => m.text === 'thanks, back now'), 'bob can message again');
    ok('unblock re-opens the channel both ways');
  });

  // ---------------------------------------------------------------------
  await section('account deletion (self): login, IDS and enrollment all stop working', async () => {
    const carol = mk('carol');
    await enroll(carol, 'carol');
    const ccid = await carol.startConversation('alice');
    await carol.sendMessage(ccid, 'hi alice, carol here');
    await sync([carol, alice], 6);
    assert.ok((await (await fetch(`${S()}/api/ids/carol`)).json()).devices.length >= 1, 'carol is in the IDS');
    await carol.deleteAccount();
    assert.strictEqual(carol.needsLogin, true, 'carol client is logged out after deletion');
    const idsRes = await fetch(`${S()}/api/ids/carol`);
    assert.strictEqual(idsRes.status, 404, 'carol no longer resolvable in the IDS');
    const loginRes = await fetch(`${S()}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'hunter2' }),
    });
    assert.strictEqual(loginRes.status, 401, 'carol can no longer log in');
    ok('a self-deleted account is fully gone server-side');
  });

  await section('account deletion (admin): operator can remove a user', async () => {
    const dave = mk('dave');
    await enroll(dave, 'dave');
    let r = await fetch(`${S()}/api/admin/accounts/dave`, { method: 'DELETE', headers: { 'X-Admin-Token': 'e2e-admin' } });
    assert.strictEqual(r.status, 200, 'admin delete succeeds');
    assert.strictEqual((await fetch(`${S()}/api/ids/dave`)).status, 404, 'dave is gone');
    r = await fetch(`${S()}/api/admin/accounts/dave`, { method: 'DELETE', headers: { 'X-Admin-Token': 'e2e-admin' } });
    assert.strictEqual(r.status, 404, 'deleting an already-gone account 404s');
    // without the token it is refused
    r = await fetch(`${S()}/api/admin/accounts/alice`, { method: 'DELETE' });
    assert.ok(r.status === 403 || r.status === 401, 'admin delete needs the admin token');
    ok('operator account cleanup works and is auth-gated');
  });

  // ---------------------------------------------------------------------
  await section('compose helpers: dedupe DMs, user existence, ranked suggestions', async () => {
    const e = mk('erin');
    await enroll(e, 'erin');
    assert.strictEqual(await e.userExists('alice'), true, 'existing user resolves');
    assert.strictEqual(await e.userExists('nobody-here'), false, 'missing user does not');
    const c1 = await e.startConversation('alice');
    assert.strictEqual(e.existingDmWith('alice'), c1, 'existingDmWith finds the thread we just made');
    const c2 = await e.startConversation('alice');
    assert.strictEqual(c2, c1, 'a second startConversation with the same person returns the SAME thread');
    assert.strictEqual(e.listConversationsView().filter((c) => c.convId === c1).length, 1, 'only one DM row for that person');
    await e.startConversation('bob');
    const sugg = e.peopleSuggestions().map((s) => s.username);
    assert.deepStrictEqual(sugg, [...sugg].sort((a, b) => a.localeCompare(b)), 'suggestions are alphabetical first');
    assert.ok(sugg.includes('alice') && sugg.includes('bob') && !sugg.includes('erin'), 'suggestions are people you have talked to, minus yourself');
    ok('one DM per person, user-existence check, and alphabetical-then-recency suggestions');
  });

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
