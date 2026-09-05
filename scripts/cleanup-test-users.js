'use strict';
/*
 * Remove test / throwaway accounts from a running pqmsg server.
 *
 *   PQMSG_ADMIN_TOKEN=... node scripts/cleanup-test-users.js            # dry run
 *   PQMSG_ADMIN_TOKEN=... node scripts/cleanup-test-users.js --yes      # actually delete
 *
 * Env:
 *   PQMSG_SERVER_URL   server base URL      (default https://chat.jacknero.com)
 *   PQMSG_ADMIN_TOKEN  operator admin token (required)
 *   PQMSG_KEEP         comma-separated usernames to keep
 *                      (default: claire,jacknero1)
 *
 * The admin token is the value printed on server boot / set via
 * PQMSG_ADMIN_TOKEN on the server. A master dashboard session token works too.
 */
const BASE = (process.env.PQMSG_SERVER_URL || 'https://chat.jacknero.com').replace(/\/$/, '');
const TOKEN = process.env.PQMSG_ADMIN_TOKEN || '';
const KEEP = new Set(
  (process.env.PQMSG_KEEP || 'claire,jacknero1')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
);
const APPLY = process.argv.includes('--yes');

if (!TOKEN) {
  console.error('PQMSG_ADMIN_TOKEN is required.');
  process.exit(2);
}

const H = { 'X-Admin-Token': TOKEN, 'content-type': 'application/json' };

(async () => {
  const r = await fetch(`${BASE}/api/admin/accounts`, { headers: H });
  if (!r.ok) {
    console.error(`GET /api/admin/accounts -> ${r.status} ${await r.text()}`);
    process.exit(1);
  }
  const { accounts } = await r.json();
  const keep = accounts.filter((a) => KEEP.has(a.username.toLowerCase()));
  const drop = accounts.filter((a) => !KEEP.has(a.username.toLowerCase()));

  console.log(`server   : ${BASE}`);
  console.log(`accounts : ${accounts.length}`);
  console.log(`keeping  : ${keep.map((a) => a.username).join(', ') || '(none)'}`);
  console.log(`deleting : ${drop.map((a) => a.username).join(', ') || '(none)'}`);
  console.log('');

  if (!drop.length) { console.log('nothing to do.'); return; }
  if (!APPLY) {
    console.log('dry run — re-run with --yes to delete the accounts listed above.');
    return;
  }

  let done = 0;
  for (const a of drop) {
    const res = await fetch(`${BASE}/api/admin/accounts/${encodeURIComponent(a.username)}`, { method: 'DELETE', headers: H });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      done++;
      console.log(`  ✓ ${a.username}  (removed ${body.removedConvs ?? 0} orphaned conversation(s))`);
    } else {
      console.log(`  ✗ ${a.username}  -> ${res.status} ${body.error || ''}`);
    }
  }
  console.log(`\ndeleted ${done}/${drop.length}.`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
