'use strict';
/*
 * Stress / adversarial coverage for the whole messaging feature set:
 * concurrency, ordering, reconnection, groups, and cross-feature
 * interactions (edit+react+reply+attachment on the same message, block
 * mid-flight, delete+resurrect races).
 *   npm run e2e:stress
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');

const PORT = 8100 + (crypto.randomBytes(1)[0] % 150);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pqmsg-stress-'));
process.env.PQMSG_PORT = String(PORT);
process.env.PQMSG_HOST = '127.0.0.1';
process.env.STORE_BACKEND = 'local';
process.env.PQMSG_DATA_DIR = path.join(TMP, 'server');
process.env.PQMSG_SEED_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_VERSION_URL = 'http://127.0.0.1:1/x';
process.env.PQMSG_ADMIN_TOKEN = 'e2e-admin';

let pass = 0, fail = 0;
const ok = (n) => (pass++, console.log('  \x1b[32m✓\x1b[0m ' + n));
const bad = (n, e) => (fail++, console.log('  \x1b[31m✗\x1b[0m ' + n + '  — ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 8000, step = 60 } = {}) {
  const end = Date.now() + timeout;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); }
}
async function section(name, fn) {
  console.log(`\n── ${name} ─────────────────────────────`);
  try {
    await Promise.race([
      fn(),
      sleep(45000).then(() => { throw new Error('section timed out (45s)'); }),
    ]);
  } catch (e) { bad(name + ' (threw)', e); }
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
  // sync with light jitter so ordering does not rely on lockstep timing
  const DBG = process.env.STRESS_DBG;
  const churn = async (parties, rounds = 14) => {
    for (let i = 0; i < rounds; i++) {
      for (const p of parties) {
        if (DBG) process.stderr.write(`  [churn ${p.store.profile} r${i}]\n`);
        try {
          await Promise.race([p.syncOnce('stress'), sleep(8000).then(() => { throw new Error(`sync hang: ${p.store.profile} round ${i}`); })]);
        } catch (e) { if (/sync hang/.test(e.message)) throw e; }
      }
      await sleep(10 + Math.floor(Math.random() * 25));
    }
  };
  const view = (e, cid) => e.getConversationView(cid);
  const seqs = (e, cid) => view(e, cid).messages.map((m) => m.serverSeq).filter((x) => x != null);
  const textAt = (e, cid, ss) => { const m = view(e, cid).messages.find((x) => x.serverSeq === ss); return m && m.text; };

  const alice = mk('alice'), bob = mk('bob'), carol = mk('carol');
  await enroll(alice, 'alice');
  await enroll(bob, 'bob');
  await enroll(carol, 'carol');

  const dm = await alice.startConversation('bob');
  await alice.sendMessage(dm, 'kickoff');
  await until(async () => { await bob.syncOnce('t'); return bob.listConversationsView().find((c) => c.convId === dm && c.status === 'pending'); });
  bob.acceptConversation(dm);
  await churn([alice, bob]);

  // ------------------------------------------------------------------
  await section('50-op mixed burst from both sides converges to one order', async () => {
    const targets = [];
    for (let i = 0; i < 50; i++) {
      const who = i % 2 ? alice : bob;
      const roll = Math.random();
      if (roll < 0.55 || targets.length < 3) {
        await who.sendMessage(dm, `m${i}`);
        const v = who.getConversationView(dm).messages;
        targets.push(v[v.length - 1].msgId);
      } else if (roll < 0.75) {
        const t = targets[Math.floor(Math.random() * targets.length)];
        try { await who.reactToMessage(dm, t, ['👍', '🔥', '🎉'][i % 3]); } catch {}
      } else if (roll < 0.9) {
        const mine = who.getConversationView(dm).messages.filter((m) => m.mine && m.canEdit);
        if (mine.length) { try { await who.editMessage(dm, mine[mine.length - 1].msgId, `m${i}-edited`); } catch {} }
      } else {
        const t = targets[Math.floor(Math.random() * targets.length)];
        try { await who.sendMessage(dm, `reply-${i}`, { replyTo: t }); } catch {}
      }
      if (i % 7 === 0) await churn([alice, bob], 2);
    }
    await churn([alice, bob], 30);
    const oa = seqs(alice, dm), ob = seqs(bob, dm);
    assert.deepStrictEqual(oa, [...oa].sort((x, y) => x - y), 'alice order monotone');
    assert.deepStrictEqual(oa, ob, 'alice and bob converged to identical order');
    // every serverSeq that alice shows, bob shows with the same text
    for (const ss of oa) assert.strictEqual(textAt(alice, dm, ss), textAt(bob, dm, ss), `text matches at #${ss}`);
    ok(`50 mixed ops -> identical ${oa.length}-message order and identical text on both replicas`);
  });

  // ------------------------------------------------------------------
  await section('rapid double-edit: last edit by serverSeq wins on both sides', async () => {
    await alice.sendMessage(dm, 'v0');
    await churn([alice, bob], 6);
    const t = alice.getConversationView(dm).messages.find((m) => m.text === 'v0');
    await alice.editMessage(dm, t.msgId, 'v1');
    await alice.editMessage(dm, t.msgId, 'v2');
    await alice.editMessage(dm, t.msgId, 'v3-final');
    await churn([alice, bob], 20);
    const a = alice.getConversationView(dm).messages.find((m) => m.serverSeq === t.serverSeq);
    const b = bob.getConversationView(dm).messages.find((m) => m.serverSeq === t.serverSeq);
    assert.strictEqual(a.text, 'v3-final', 'alice shows the final edit');
    assert.strictEqual(b.text, 'v3-final', 'bob shows the final edit');
    assert.strictEqual(a.display, 'delivered', 'edit settles to delivered');
    assert.strictEqual(alice.getConversationView(dm).messages.filter((m) => /^v[0-9]/.test(m.text)).length, 1, 'still exactly one bubble');
    ok('three edits in a row -> both sides show only the last, one bubble');
  });

  // ------------------------------------------------------------------
  await section('reconnect: a client that was offline catches up every message kind', async () => {
    // bob goes dark; alice does a bunch of stuff including editing a message bob never saw
    const fresh = await alice.sendMessage(dm, 'while-bob-was-away');
    await alice.sendMessage(dm, 'and-another');
    await churn([alice], 4); // only alice syncs
    const avMsg = alice.getConversationView(dm).messages.find((m) => m.text === 'while-bob-was-away');
    await alice.editMessage(dm, avMsg.msgId, 'while-bob-was-away (fixed)');
    await alice.reactToMessage(dm, avMsg.msgId, '🛰️');
    await alice.sendMessage(dm, 'catch up when you can', { replyTo: avMsg.msgId });
    await churn([alice], 6);
    // bob reconnects
    await churn([alice, bob], 25);
    const b = bob.getConversationView(dm).messages.find((m) => m.serverSeq === avMsg.serverSeq);
    assert.ok(b, 'bob got the message he missed');
    assert.strictEqual(b.text, 'while-bob-was-away (fixed)', 'bob sees the edited text, never the pre-edit version');
    assert.ok(b.reactions.some((r) => r.emoji === '🛰️'), 'bob sees the reaction added while he was away');
    const rep = bob.getConversationView(dm).messages.find((m) => m.text === 'catch up when you can');
    assert.ok(rep && rep.replyTo && /while-bob-was-away/.test(rep.replyTo.textPreview), 'bob sees the reply with its quote');
    assert.deepStrictEqual(seqs(alice, dm), seqs(bob, dm), 'orders match after reconnect');
    ok('an offline client catches up edits/reactions/replies for messages it had never seen');
  });

  // ------------------------------------------------------------------
  await section('group of 3: edit / react / reply converge for everyone', async () => {
    const g = await alice.startGroup({ name: 'stress squad', members: ['bob', 'carol'] });
    await alice.sendMessage(g, 'group hello');
    for (const p of [bob, carol]) {
      await until(async () => { await p.syncOnce('t'); return p.listConversationsView().find((c) => c.convId === g && c.status === 'pending'); });
      p.acceptConversation(g);
    }
    await churn([alice, bob, carol], 12);
    const gm = alice.getConversationView(g).messages.find((m) => m.text === 'group hello');
    await alice.editMessage(g, gm.msgId, 'group hello (edited)');
    await bob.reactToMessage(g, gm.msgId, '👀');
    await carol.sendMessage(g, 'nice', { replyTo: gm.msgId });
    await churn([alice, bob, carol], 25);
    for (const [nm, p] of [['alice', alice], ['bob', bob], ['carol', carol]]) {
      const v = p.getConversationView(g).messages;
      const seen = v.find((m) => m.serverSeq === gm.serverSeq);
      assert.strictEqual(seen.text, 'group hello (edited)', `${nm} sees the edit`);
      assert.ok(seen.reactions.some((r) => r.emoji === '👀'), `${nm} sees the reaction`);
      assert.ok(v.some((m) => m.text === 'nice' && m.replyTo), `${nm} sees the reply`);
    }
    const g1 = seqs(alice, g), g2 = seqs(bob, g), g3 = seqs(carol, g);
    assert.deepStrictEqual(g1, g2, 'alice/bob group order match');
    assert.deepStrictEqual(g1, g3, 'alice/carol group order match');
    ok('3-party group: edit + reaction + reply all converge, identical order for all members');
  });

  // ------------------------------------------------------------------
  await section('one message carrying attachment + reply + reactions from both sides', async () => {
    const base = alice.getConversationView(dm).messages.find((m) => m.text === 'and-another');
    assert.ok(base, 'base message present');
    console.log('    · sending attachment…');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mP8z8BQz0AEYBxVSF8AGdEB/dnV0aoAAAAASUVORK5CYII=';
    await alice.sendAttachment(dm, { name: 's.png', mime: 'image/png', isImage: true, dataB64: png, size: Buffer.from(png, 'base64').length }, { caption: 'look', replyTo: base.msgId });
    console.log('    · attachment queued, churning…');
    await churn([alice, bob], 12);
    const att = bob.getConversationView(dm).messages.find((m) => m.attachment && m.attachment.name === 's.png');
    assert.ok(att, 'bob has the attachment message');
    assert.ok(att.replyTo, 'attachment message is also a reply');
    await bob.reactToMessage(dm, att.msgId, '📎');
    await alice.reactToMessage(dm, att.msgId, '📎'); // same emoji, different person -> count 2
    await alice.reactToMessage(dm, att.msgId, '👍');
    await churn([alice, bob], 20);
    const a = alice.getConversationView(dm).messages.find((m) => m.attachment && m.attachment.name === 's.png');
    const clip = a.reactions.find((r) => r.emoji === '📎');
    assert.strictEqual(clip.count, 2, 'two people reacted 📎');
    assert.ok(clip.mine, 'alice is one of them');
    assert.ok(a.reactions.some((r) => r.emoji === '👍'), 'plus a 👍');
    assert.strictEqual(a.attachment.dataB64, png, 'image bytes still intact after all the churn');
    ok('attachment + reply + multi-party reactions on one message stay consistent');
  });

  // ------------------------------------------------------------------
  await section('idempotent resend: a retried POST never duplicates', async () => {
    await alice.sendMessage(dm, 'dup-test');
    await churn([alice, bob], 8);
    const mid = alice.getConversationView(dm).messages.find((m) => m.text === 'dup-test');
    // pull the exact stored ciphertext envelope and POST it again, twice
    const raw = await (await fetch(`${S()}/api/admin/conv/${dm}/raw/${mid.msgId}`, { headers: { 'X-Admin-Token': 'e2e-admin' } })).json();
    for (let i = 0; i < 2; i++) {
      await fetch(`${S()}/api/conv/${dm}/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ envelope: raw, participants: [alice.myHandle, bob.myHandle], kind: 'dm' }),
      });
    }
    await churn([alice, bob], 12);
    const oa = seqs(alice, dm), ob = seqs(bob, dm);
    assert.deepStrictEqual(oa, ob, 'orders still identical after a double re-POST');
    assert.strictEqual(new Set(oa).size, oa.length, 'no duplicate serverSeqs');
    assert.strictEqual(alice.getConversationView(dm).messages.filter((m) => m.text === 'dup-test').length, 1, 'exactly one dup-test bubble');
    ok('a duplicated POST of the same envelope is absorbed — no duplicate message');
  });

  // ------------------------------------------------------------------
  await section('block mid-conversation: in-flight message from the blocked side fails cleanly', async () => {
    // carol <-> alice
    const ca = await carol.startConversation('alice');
    await carol.sendMessage(ca, 'hi from carol');
    await until(async () => { await alice.syncOnce('t'); return alice.listConversationsView().find((c) => c.convId === ca && c.status === 'pending'); });
    alice.acceptConversation(ca);
    await churn([alice, carol], 10);
    // alice blocks carol; simultaneously carol fires a message
    await Promise.all([
      alice.blockPeer(ca),
      carol.sendMessage(ca, 'are you there?'),
    ]);
    await churn([alice, carol], 20);
    const cv = carol.getConversationView(ca);
    const failed = cv.messages.find((m) => m.text === 'are you there?');
    assert.ok(failed.display === 'failed' || cv.blockedByPeer, 'the blocked-direction message fails and/or carol learns she is blocked');
    assert.strictEqual(cv.blockedByPeer, true, 'carol ends up knowing she is blocked');
    // alice can still reach carol
    await alice.sendMessage(ca, 'blocked, talk later');
    await churn([alice, carol], 12);
    assert.ok(carol.getConversationView(ca).messages.some((m) => m.text === 'blocked, talk later'), 'blocker -> blocked still delivers');
    ok('a block landing during an in-flight send resolves cleanly, no stuck state');
  });

  // ------------------------------------------------------------------
  await section('delete + resurrect race: peer keeps writing while you delete', async () => {
    const d2 = await bob.startConversation('carol');
    await bob.sendMessage(d2, 'seed');
    await until(async () => { await carol.syncOnce('t'); return carol.listConversationsView().find((c) => c.convId === d2 && c.status === 'pending'); });
    carol.acceptConversation(d2);
    await churn([bob, carol], 10);
    await Promise.all([
      (async () => { carol.deleteConversation(d2); })(),
      bob.sendMessage(d2, 'wait dont go 1'),
      bob.sendMessage(d2, 'wait dont go 2'),
    ]);
    await churn([bob, carol], 25);
    const cv = carol.listConversationsView().find((c) => c.convId === d2);
    assert.ok(cv, 'the chat re-surfaces for carol because bob kept writing');
    assert.strictEqual(cv.status, 'pending', 're-surfaces as a fresh request');
    carol.acceptConversation(d2);
    await churn([bob, carol], 15);
    const texts = carol.getConversationView(d2).messages.map((m) => m.text);
    assert.ok(texts.includes('wait dont go 2'), 'the newest post-deletion message is present');
    assert.ok(!texts.includes('seed'), 'the pre-deletion message stays gone');
    assert.deepStrictEqual(seqs(bob, d2).filter((s) => s > (carol.store.loadConversation(d2).hideThroughSeq || 0)),
                           seqs(carol, d2), 'post-deletion tail matches bob exactly');
    ok('deleting while the peer is mid-burst re-prompts cleanly with only post-deletion history');
  });

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(fail ? 1 : 0);
})();
