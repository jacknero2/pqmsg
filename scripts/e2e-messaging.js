'use strict';
/*
 * Message-feature end-to-end: edits, reactions, replies, and self-recovery
 * of your own sent messages (the "sent from another device" bug).
 *   npm run e2e:messaging
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const PORT = 8300 + (crypto.randomBytes(1)[0] % 200);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-msg-'));
process.env.PQMSG_PORT = String(PORT);
process.env.PQMSG_HOST = '127.0.0.1';
process.env.STORE_BACKEND = 'local';
process.env.PQMSG_DATA_DIR = path.join(TMP, 'server');
process.env.PQMSG_SEED_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_VERSION_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_ADMIN_TOKEN = 'e2e-admin';

const pqc = require('../shared/crypto');
let pass = 0, fail = 0;
const ok = (n) => (pass++, console.log('  \x1b[32m✓\x1b[0m ' + n));
const bad = (n, e) => (fail++, console.log('  \x1b[31m✗\x1b[0m ' + n + '  — ' + (e && e.message ? e.message : e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 5000, step = 80 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return v;
    await sleep(step);
  }
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
  alice.on('update', () => {});
  bob.on('update', () => {});

  const enroll = async (e, n) => {
    await e.register({ username: n, email: `${n}@t.local`, password: 'hunter2' });
    const r = await e.login({ username: n, password: 'hunter2', deviceName: n + '-dev' });
    if (r.needs2fa) await e.completeLogin({ code: r.devCode, rememberDevice: true });
    e.stopLoops();
  };
  const sync = async (n = 6) => { for (let i = 0; i < n; i++) { await bob.syncOnce('t'); await alice.syncOnce('t'); await sleep(25); } };

  await enroll(alice, 'alice');
  await enroll(bob, 'bob');
  const cid = await alice.startConversation('bob');
  await alice.sendMessage(cid, 'first message');
  await until(async () => { await bob.syncOnce('t'); return bob.listConversationsView().find((c) => c.convId === cid && c.status === 'pending'); });
  bob.acceptConversation(cid);
  await sync();

  // ---------------------------------------------------------------------
  await section('self-recovery: a device can re-derive its OWN sent messages', async () => {
    const before = alice.getConversationView(cid).messages.find((m) => m.text === 'first message');
    assert.ok(before && before.mine, 'alice has her own message');
    // simulate a lost local cache (old switchAccount wipe / crash): drop the
    // conversation file, keep identity, then re-sync from the server.
    const convFile = path.join(alice.store.convDir, cid + '.json');
    assert.ok(fs.existsSync(convFile));
    fs.rmSync(convFile);
    alice.store.ensureConversation(cid, [alice.myHandle, bob.myHandle], 'dm', alice.identity.serverUrl, null, 'active');
    for (let i = 0; i < 8; i++) { await alice.syncOnce('t'); await sleep(25); }
    const after = alice.getConversationView(cid).messages.find((m) => m.serverSeq === before.serverSeq);
    assert.ok(after, 'the message came back after re-sync');
    assert.strictEqual(after.text, 'first message', 'alice recovered her own plaintext — NOT "sent from another device"');
    assert.ok(!/another (of your )?device/i.test(after.text), 'no bogus other-device label');
    ok('a wiped-cache client recovers its own sent message text from the server copy');
  });

  // ---------------------------------------------------------------------
  await section('edit: replaces text in place, no "edited" marker, correct ordering', async () => {
    await alice.sendMessage(cid, 'helo wrld');
    await alice.sendMessage(cid, 'keep me last');
    await sync();
    const orig = alice.getConversationView(cid).messages.find((m) => m.text === 'helo wrld');
    assert.ok(orig, 'typo message present');
    await alice.editMessage(cid, orig.msgId, 'hello world');
    // alice: red again until the edit envelope is delivered
    let av = alice.getConversationView(cid).messages.find((m) => m.msgId === orig.msgId);
    assert.strictEqual(av.text, 'hello world', 'alice sees the new text immediately');
    assert.strictEqual(av.display, 'undelivered', 'edited bubble is red until the edit is delivered');
    await sync(10);
    av = alice.getConversationView(cid).messages;
    const editedIdx = av.findIndex((m) => m.msgId === orig.msgId);
    const lastIdx = av.findIndex((m) => m.text === 'keep me last');
    assert.ok(editedIdx >= 0 && editedIdx < lastIdx, 'edited message keeps its original position');
    assert.strictEqual(av[editedIdx].text, 'hello world');
    assert.strictEqual(av[editedIdx].display, 'delivered', 'edit delivered -> back to normal colour');
    assert.ok(!JSON.stringify(av[editedIdx]).match(/edited/i), 'no "edited" flag exposed to the view');

    const bv = bob.getConversationView(cid).messages;
    const be = bv.find((m) => m.serverSeq === orig.serverSeq);
    assert.strictEqual(be.text, 'hello world', 'bob sees only the corrected text');
    assert.ok(!bv.some((m) => /helo wrld/.test(m.text)), 'bob never keeps the pre-edit text as a separate bubble');
    // the edit envelope must not appear as its own bubble on either side
    assert.strictEqual(av.filter((m) => m.text === 'hello world').length, 1, 'exactly one bubble for the edited message (alice)');
    assert.strictEqual(bv.filter((m) => m.text === 'hello world').length, 1, 'exactly one bubble for the edited message (bob)');
    ok('edit replaces text in place on both ends, keeps ordering, shows no edit marker');
  });

  await section('edit: only the original sender can edit', async () => {
    const m = bob.getConversationView(cid).messages.find((x) => x.text === 'hello world');
    let threw = false;
    try { await bob.editMessage(cid, m.msgId, 'bob was here'); } catch { threw = true; }
    assert.ok(threw, 'bob cannot edit alice\'s message via the API');
    await sync();
    const av = alice.getConversationView(cid).messages.find((x) => x.serverSeq === m.serverSeq);
    assert.strictEqual(av.text, 'hello world', 'alice\'s message is untouched');
    ok('a forged edit from a non-author is rejected');
  });

  // ---------------------------------------------------------------------
  await section('reaction: any emoji, toggles, visible to both, not its own bubble', async () => {
    const target = bob.getConversationView(cid).messages.find((m) => m.text === 'first message');
    const countBefore = bob.getConversationView(cid).messages.length;
    await bob.reactToMessage(cid, target.msgId, '🎉');
    await sync();
    let av = alice.getConversationView(cid).messages.find((m) => m.serverSeq === target.serverSeq);
    assert.ok(av.reactions.some((r) => r.emoji === '🎉' && r.count === 1 && !r.mine), 'alice sees bob\'s 🎉');
    assert.strictEqual(alice.getConversationView(cid).messages.length, bob.getConversationView(cid).messages.length, 'reaction adds no bubble');
    assert.strictEqual(bob.getConversationView(cid).messages.length, countBefore, 'reaction adds no bubble on sender side either');
    // alice piles on with a custom emoji
    await alice.reactToMessage(cid, av.msgId, '🦄');
    await sync();
    av = alice.getConversationView(cid).messages.find((m) => m.serverSeq === target.serverSeq);
    assert.ok(av.reactions.find((r) => r.emoji === '🦄').mine, 'alice\'s own 🦄 marked mine');
    // bob toggles his 🎉 off
    await bob.reactToMessage(cid, target.msgId, '🎉');
    await sync();
    av = alice.getConversationView(cid).messages.find((m) => m.serverSeq === target.serverSeq);
    assert.ok(!av.reactions.some((r) => r.emoji === '🎉'), 'toggling removes the reaction on both ends');
    assert.ok(av.reactions.some((r) => r.emoji === '🦄'), '🦄 still there');
    ok('reactions: arbitrary emoji, toggle on/off, mirrored to both sides, never a bubble');
  });

  // ---------------------------------------------------------------------
  await section('reply: quoted stub with correct "You said" / "@user said"', async () => {
    const aMsg = alice.getConversationView(cid).messages.find((m) => m.text === 'hello world');
    await bob.sendMessage(cid, 'nice, thanks', { replyTo: aMsg.msgId });
    await sync();
    // bob replied to alice's message
    const bView = bob.getConversationView(cid).messages.find((m) => m.text === 'nice, thanks');
    assert.ok(bView.replyTo, 'reply carries a quote');
    assert.strictEqual(bView.replyTo.who, '@alice', 'from bob\'s side the quote says "@alice"');
    assert.ok(/hello world/.test(bView.replyTo.textPreview), 'quote preview is the replied-to text');
    // alice sees bob's reply; the quoted message is alice's own -> "You"
    const aSee = alice.getConversationView(cid).messages.find((m) => m.text === 'nice, thanks');
    assert.strictEqual(aSee.replyTo.who, 'You', 'alice sees "You said" because the quote is her own message');
    // alice replies to her own message
    await alice.sendMessage(cid, 'replying to myself', { replyTo: aMsg.msgId });
    await sync();
    const selfRep = alice.getConversationView(cid).messages.find((m) => m.text === 'replying to myself');
    assert.strictEqual(selfRep.replyTo.who, 'You', 'self-reply shows "You said"');
    ok('replies quote the target with the right attribution on each side');
  });

  // ---------------------------------------------------------------------
  await section('attachments: image + arbitrary file travel encrypted, arrive whole', async () => {
    const pngB64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEYBxVSF8AGdEB/dnV0aoAAAAASUVORK5CYII=';
    await alice.sendAttachment(cid, { name: 'pixel.png', mime: 'image/png', isImage: true, dataB64: pngB64, size: Buffer.from(pngB64, 'base64').length }, { caption: 'a tiny image' });
    const bytes = Buffer.from('this is a plain text file, not an image\n'.repeat(50));
    await alice.sendAttachment(cid, { name: 'notes.txt', mime: 'text/plain', isImage: false, dataB64: bytes.toString('base64'), size: bytes.length });
    await sync(10);
    const bv = bob.getConversationView(cid).messages;
    const img = bv.find((m) => m.attachment && m.attachment.name === 'pixel.png');
    assert.ok(img, 'bob got the image message');
    assert.strictEqual(img.attachment.isImage, true);
    assert.ok(img.attachment.dataUrl && img.attachment.dataUrl.startsWith('data:image/png;base64,'), 'image exposed as a data URL for preview');
    assert.strictEqual(img.attachment.dataB64, pngB64, 'image bytes are byte-identical after the round trip');
    assert.strictEqual(img.text, 'a tiny image', 'caption preserved');
    const file = bv.find((m) => m.attachment && m.attachment.name === 'notes.txt');
    assert.ok(file, 'bob got the file message');
    assert.strictEqual(file.attachment.isImage, false);
    assert.strictEqual(file.attachment.dataUrl, null, 'non-image has no preview URL');
    assert.strictEqual(Buffer.from(file.attachment.dataB64, 'base64').toString(), bytes.toString(), 'file bytes intact');

    // server stores only ciphertext
    const raw = await (await fetch(`http://127.0.0.1:${PORT}/api/admin/conv/${cid}`, { headers: { 'X-Admin-Token': 'e2e-admin' } })).json();
    assert.ok(!JSON.stringify(raw).includes('plain text file, not an image'), 'server never sees attachment plaintext');

    let tooBig = false;
    try {
      await alice.sendAttachment(cid, { name: 'huge.bin', mime: 'application/octet-stream', dataB64: 'AA', size: 99 * 1024 * 1024 });
    } catch { tooBig = true; }
    assert.ok(tooBig, 'oversized attachment is rejected client-side');
    ok('image + file attachments round-trip byte-exact inside the encrypted envelope, size-capped, ciphertext-only on the server');
  });

  // ---------------------------------------------------------------------
  await section('ordering stays canonical through a burst of mixed ops', async () => {
    for (let i = 1; i <= 5; i++) await (i % 2 ? alice : bob).sendMessage(cid, 'burst ' + i);
    await sync(10);
    const someMsg = alice.getConversationView(cid).messages.find((m) => m.text === 'burst 2');
    assert.ok(someMsg, 'alice has burst 2 after sync');
    await alice.reactToMessage(cid, someMsg.msgId, '👍');
    await bob.sendMessage(cid, 'burst tail', { replyTo: someMsg.msgId });
    await sync(12);
    const oa = alice.getConversationView(cid).messages.map((m) => m.serverSeq).filter((x) => x != null);
    const ob = bob.getConversationView(cid).messages.map((m) => m.serverSeq).filter((x) => x != null);
    assert.deepStrictEqual(oa, [...oa].sort((a, b) => a - b), 'alice order monotone in serverSeq');
    assert.deepStrictEqual(oa, ob, 'both converged to identical order');
    ok('mixed text/edit/reaction/reply burst still converges to one canonical order [' + oa.join(',') + ']');
  });

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
