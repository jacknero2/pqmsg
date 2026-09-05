'use strict';
/*
 * Read receipts, unread counts, and the inbound-message notification event.
 *   npm run e2e:receipts
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const PORT = 8250 + (crypto.randomBytes(1)[0] % 150);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-rcpt-'));
process.env.PQMSG_PORT = String(PORT);
process.env.PQMSG_HOST = '127.0.0.1';
process.env.STORE_BACKEND = 'local';
process.env.PQMSG_DATA_DIR = path.join(TMP, 'server');
process.env.PQMSG_SEED_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_VERSION_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_ADMIN_TOKEN = 'e2e-admin';

let pass = 0, fail = 0;
const ok = (n) => (pass++, console.log('  \x1b[32m✓\x1b[0m ' + n));
const bad = (n, e) => (fail++, console.log('  \x1b[31m✗\x1b[0m ' + n + '  — ' + (e && e.message ? e.message : e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 5000, step = 70 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); }
}
async function section(name, fn) {
  console.log(`\n── ${name} ─────────────────────────────`);
  try { await fn(); } catch (e) { bad(name + ' (threw)', e); }
}

(async () => {
  const { startServer } = require('../server/src/index.js');
  await startServer({ quiet: true });
  await until(async () => (await fetch(`http://127.0.0.1:${PORT}/api/health`).catch(() => null))?.ok);

  process.env.PQMSG_DATA_DIR = path.join(TMP, 'clients');
  process.env.PQMSG_SERVER_URL = `http://127.0.0.1:${PORT}`;
  const { Engine } = require('../client/main/engine');
  const alice = new Engine('alice');
  const bob = new Engine('bob');
  const events = [];
  alice.on('update', () => {});
  bob.on('update', () => {});
  bob.on('engine-event', (e) => { if (e.kind === 'inbound-message') events.push(e); });

  const enroll = async (e, n) => {
    await e.register({ username: n, email: `${n}@t.local`, password: 'hunter2' });
    const r = await e.login({ username: n, password: 'hunter2', deviceName: n + '-dev' });
    if (r.needs2fa) await e.completeLogin({ code: r.devCode, rememberDevice: true });
    e.stopLoops();
  };
  const sync = async (n = 8) => { for (let i = 0; i < n; i++) { await bob.syncOnce('t'); await alice.syncOnce('t'); await sleep(20); } };

  await enroll(alice, 'alice');
  await enroll(bob, 'bob');
  const cid = await alice.startConversation('bob');
  await alice.sendMessage(cid, 'first');
  await until(async () => { await bob.syncOnce('t'); return bob.listConversationsView().find((c) => c.convId === cid && c.status === 'pending'); });
  bob.acceptConversation(cid);
  // bob is NOT looking at this conversation
  bob.setActiveView({ convId: null, focused: true });
  await sync();

  // ------------------------------------------------------------------
  await section('unread count: messages you have not looked at are counted', async () => {
    await alice.sendMessage(cid, 'u1');
    await alice.sendMessage(cid, 'u2');
    await alice.sendMessage(cid, 'u3');
    await sync(10);
    const c = bob.listConversationsView().find((x) => x.convId === cid);
    assert.ok(c.unread >= 3, `bob has >=3 unread (got ${c.unread})`);
    assert.ok(bob.snapshot().unreadTotal >= 3, 'snapshot.unreadTotal reflects it');
    // bob opens the conversation -> unread clears
    bob.setActiveView({ convId: cid, focused: true });
    await sync(6);
    assert.strictEqual(bob.listConversationsView().find((x) => x.convId === cid).unread, 0, 'opening the conversation clears unread');
    assert.strictEqual(bob.snapshot().unreadTotal, 0, 'total unread back to 0');
    ok('unread is counted per conversation and cleared when the user views it');
  });

  // ------------------------------------------------------------------
  await section('read receipt: sender sees "seen" once the recipient reads it', async () => {
    // bob currently has the conversation open + focused (from previous section)
    await alice.sendMessage(cid, 'did you read this');
    await sync(10);
    const m = await until(async () => {
      await sync(2);
      const mm = alice.getConversationView(cid).messages.find((x) => x.text === 'did you read this');
      return mm && mm.seen ? mm : null;
    });
    assert.ok(m, 'alice\'s message flips to seen');
    assert.strictEqual(m.seen, true, 'seen === true on the sender side');
    ok('a message the recipient has read shows "seen" to the sender');
  });

  await section('read receipt: NOT sent while the recipient is looking elsewhere', async () => {
    bob.setActiveView({ convId: null, focused: true }); // bob looks away
    await alice.sendMessage(cid, 'sent while bob is away');
    await sync(10);
    const m = alice.getConversationView(cid).messages.find((x) => x.text === 'sent while bob is away');
    assert.strictEqual(m.display, 'delivered', 'it is delivered');
    assert.strictEqual(m.seen, false, 'but NOT seen — bob was not looking at it');
    // bob comes back -> now it is seen
    bob.setActiveView({ convId: cid, focused: true });
    await sync(8);
    assert.strictEqual(alice.getConversationView(cid).messages.find((x) => x.text === 'sent while bob is away').seen, true, 'seen once bob opens it');
    ok('read receipts only fire when the recipient is actually viewing the conversation');
  });

  // ------------------------------------------------------------------
  await section('read receipts can be turned off (symmetric)', async () => {
    bob.setReadReceipts(false);
    assert.strictEqual(bob.readReceipts, false, 'bob turned them off');
    assert.strictEqual(bob.snapshot().readReceipts, false, 'reflected in the snapshot');
    await alice.sendMessage(cid, 'bob has receipts off now');
    await sync(10);
    const m = alice.getConversationView(cid).messages.find((x) => x.text === 'bob has receipts off now');
    assert.strictEqual(m.seen, false, 'alice never sees "seen" because bob stopped sending receipts');
    assert.strictEqual(m.display, 'delivered', 'still delivered though');
    // and bob does not see "seen" on his own outgoing messages either
    await bob.sendMessage(cid, 'from bob with receipts off');
    await sync(10);
    // alice (receipts on) reads it
    alice.setActiveView({ convId: cid, focused: true });
    await sync(8);
    const bm = bob.getConversationView(cid).messages.find((x) => x.text === 'from bob with receipts off');
    assert.strictEqual(bm.seen, false, 'bob does not see "seen" on his own messages while his receipts are off');
    // turn back on -> bob can see it again
    bob.setReadReceipts(true);
    await sync(4);
    assert.strictEqual(bob.getConversationView(cid).messages.find((x) => x.text === 'from bob with receipts off').seen, true, 're-enabling shows the receipt that already arrived');
    ok('turning read receipts off stops sending AND hides incoming ones; turning back on restores both');
  });

  // ------------------------------------------------------------------
  await section('inbound-message event carries a usable notification preview', async () => {
    events.length = 0;
    bob.setActiveView({ convId: null, focused: true });
    await alice.sendMessage(cid, 'ping for a notification');
    await sync(8);
    const ev = events.find((e) => e.preview === 'ping for a notification');
    assert.ok(ev, 'an inbound-message event fired');
    assert.strictEqual(ev.convId, cid);
    assert.strictEqual(ev.from, '@alice', 'from is the pretty handle');
    assert.strictEqual(ev.isGroup, false);
    // attachment -> preview says "Photo"
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEYBxVSF8AGdEB/dnV0aoAAAAASUVORK5CYII=';
    await alice.sendAttachment(cid, { name: 'p.png', mime: 'image/png', isImage: true, dataB64: png, size: 96 });
    await sync(8);
    assert.ok(events.some((e) => e.preview === 'Photo'), 'an image notification previews as "Photo"');
    ok('inbound-message events give the main process what it needs to notify');
  });

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
