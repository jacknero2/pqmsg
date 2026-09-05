'use strict';
/*
 * On-disk client state. One "profile" == one install of the app on this
 * machine, but a profile can hold *multiple accounts* side by side — each
 * username gets its own folder under accounts/, so switching between
 * accounts on the same device never deletes anything. Re-logging into an
 * account you've used here before (password + 2FA, same as any login)
 * reunites you with that account's own device keys and cached history.
 * Run several profiles for testing (each an independent multi-account vault):
 *     PQMSG_PROFILE=alice npm run client
 *     PQMSG_PROFILE=bob   npm run client
 *
 *   <profileDir>/
 *     active.json                   { username } — which local account is current
 *     accounts/<username>/
 *       identity.json                device keys + account + server + token
 *       app-config.json              trust token etc, scoped to this account
 *       contacts.json                cached IDS lookups
 *       conversations/<convId>.json  DECRYPTED conversation (plaintext, local only)
 *       outbox.json                  envelopes awaiting a successful POST
 *
 * An account's folder is only ever created or loaded as a result of that
 * account's own successful login (password + 2FA) — there is no code path
 * that lets one account's data be reached through another's session.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

class ClientStore {
  constructor(profile, baseDir) {
    this.profile = profile || process.env.PQMSG_PROFILE || 'default';
    // precedence: PQMSG_DATA_DIR env (dev / multi-profile) > caller baseDir
    // (Electron userData in a packaged app) > ~/.pqmsg
    const root = process.env.PQMSG_DATA_DIR || baseDir || path.join(os.homedir(), '.pqmsg');
    this.dir = path.join(root, this.profile);
    this.accountsDir = path.join(this.dir, 'accounts');
    fs.mkdirSync(this.accountsDir, { recursive: true });
    this._migrateFlatLayout();
    this.username = this._readJson(this._activePath(), {}).username || null;
    if (this.username) fs.mkdirSync(this.convDir, { recursive: true });
  }
  /**
   * Installs from before per-account folders existed kept everything flat
   * directly under the profile dir (identity.json, contacts.json, ...). On
   * first run of the new layout, move that single account's files into its
   * own accounts/<username>/ folder and mark it active — otherwise an
   * upgrade would silently drop an existing user back to the login screen.
   */
  _migrateFlatLayout() {
    const flatIdentity = path.join(this.dir, 'identity.json');
    if (fs.existsSync(this._activePath()) || !fs.existsSync(flatIdentity)) return;
    const id = this._readJson(flatIdentity, null);
    if (!id || !id.username) return;
    const dest = this._accountDir(id.username);
    fs.mkdirSync(dest, { recursive: true });
    for (const name of ['identity.json', 'app-config.json', 'pinned-servers.json', 'server-cache.json', 'contacts.json', 'outbox.json']) {
      const src = path.join(this.dir, name);
      if (fs.existsSync(src)) fs.renameSync(src, path.join(dest, name));
    }
    const flatConvDir = path.join(this.dir, 'conversations');
    if (fs.existsSync(flatConvDir)) fs.renameSync(flatConvDir, path.join(dest, 'conversations'));
    this._writeJson(this._activePath(), { username: id.username });
  }
  _activePath() {
    return path.join(this.dir, 'active.json');
  }
  _safeName(username) {
    return String(username || '').toLowerCase().replace(/[^a-z0-9_.-]/g, '_') || '_';
  }
  _accountDir(username) {
    return path.join(this.accountsDir, this._safeName(username));
  }
  get convDir() {
    return path.join(this._accountDir(this.username), 'conversations');
  }
  /** Local (on this device) data already exists for this username. */
  hasLocalAccount(username) {
    return fs.existsSync(path.join(this._accountDir(username), 'identity.json'));
  }
  /**
   * Make `username` the active account: its folder becomes the target of
   * every load/save call below, and it's remembered as the account to
   * resume on the next app launch. Pass null to detach (e.g. on
   * switch-account) without deleting anything.
   */
  setActiveAccount(username) {
    this.username = username || null;
    this._writeJson(this._activePath(), { username: this.username });
    if (this.username) fs.mkdirSync(this.convDir, { recursive: true });
  }
  _p(name) {
    return path.join(this._accountDir(this.username), name);
  }
  _readJson(p, dflt) {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return dflt;
    }
  }
  _writeJson(p, obj) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + crypto.randomBytes(3).toString('hex');
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, p);
  }

  // identity ------------------------------------------------------------
  loadIdentity() {
    if (!this.username) return null;
    return this._readJson(this._p('identity.json'), null);
  }
  saveIdentity(id) {
    this._writeJson(this._p('identity.json'), id);
  }

  /** Permanently delete one local account's folder (keys, history, everything). */
  forgetLocalAccount(username) {
    fs.rmSync(this._accountDir(username), { recursive: true, force: true });
    if (this._safeName(username) === this._safeName(this.username)) this.setActiveAccount(null);
  }

  // server discovery ------------------------------------------------
  loadAppConfig() {
    if (!this.username) return {};
    return this._readJson(this._p('app-config.json'), {});
  }
  /** Read a specific (possibly not-yet-active) account's config without touching disk. */
  peekAppConfig(username) {
    return this._readJson(path.join(this._accountDir(username), 'app-config.json'), {});
  }
  saveAppConfig(patch) {
    this._writeJson(this._p('app-config.json'), { ...this.loadAppConfig(), ...patch });
  }
  loadPinnedServers() {
    if (!this.username) return [];
    return this._readJson(this._p('pinned-servers.json'), []);
  }
  savePinnedServers(list) {
    this._writeJson(this._p('pinned-servers.json'), list);
  }
  loadServerCache() {
    if (!this.username) return [];
    return this._readJson(this._p('server-cache.json'), []);
  }
  saveServerCache(list) {
    this._writeJson(this._p('server-cache.json'), list);
  }

  // contacts ----------------------------------------------------------
  loadContacts() {
    if (!this.username) return {};
    return this._readJson(this._p('contacts.json'), {});
  }
  saveContact(username, ids) {
    const all = this.loadContacts();
    all[username] = { ...ids, fetchedAt: Date.now() };
    this._writeJson(this._p('contacts.json'), all);
  }
  getContact(username) {
    return this.loadContacts()[username] || null;
  }

  // outbox ----------------------------------------------------------
  loadOutbox() {
    if (!this.username) return [];
    return this._readJson(this._p('outbox.json'), []);
  }
  saveOutbox(list) {
    this._writeJson(this._p('outbox.json'), list);
  }

  // conversations -------------------------------------------------
  _convPath(convId) {
    return path.join(this.convDir, convId + '.json');
  }
  listConversationIds() {
    if (!this.username) return [];
    try {
      return fs.readdirSync(this.convDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
    } catch {
      return [];
    }
  }
  loadConversation(convId) {
    return this._readJson(this._convPath(convId), null);
  }
  saveConversation(conv) {
    this._writeJson(this._convPath(conv.convId), conv);
  }
  /** @param {'active'|'pending'|'declined'} [status]  incoming convs start 'pending' (accept/decline) */
  ensureConversation(convId, participants, kind, homeServer, name, status) {
    let c = this.loadConversation(convId);
    if (!c) {
      c = {
        convId,
        participants,
        kind: kind || (participants.length > 2 ? 'group' : 'dm'),
        name: name || null,
        homeServer: homeServer || null,
        status: status || 'active',
        messages: {}, // msgId -> message record
        order: [], // canonical order (mirrors server); pending msgs appended
        cursorSeq: 0, // highest serverSeq consumed
        createdAt: Date.now(),
        lastReconciledAt: 0,
      };
      this.saveConversation(c);
    } else {
      // fill in fields learned later (e.g. homeServer from an inbox pointer)
      let dirty = false;
      if (homeServer && !c.homeServer) (c.homeServer = homeServer), (dirty = true);
      if (name && !c.name) (c.name = name), (dirty = true);
      if (Array.isArray(participants) && participants.length > (c.participants || []).length) {
        c.participants = participants;
        dirty = true;
      }
      if (dirty) this.saveConversation(c);
    }
    return c;
  }
}

module.exports = { ClientStore };
