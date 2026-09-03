'use strict';
/*
 * Server side of the directory: signs an announcement with this server's
 * Ed25519 registry identity and (re)posts it to the registry every ~90s so the
 * entry stays fresh. Graceful DELETE on shutdown.
 */
const path = require('path');
const { loadOrCreateIdentity, canonical } = require('../../shared/ed25519');

const ANNOUNCE_MS = 90_000;

const loadServerIdentity = (dataDir) => loadOrCreateIdentity(path.join(dataDir, 'registry-identity.json'));

class RegistryAnnouncer {
  /** @param {{registryUrl,string, dataDir:string, info:{name,description,region,url}}} p */
  constructor({ registryUrl, dataDir, info }) {
    this.registryUrl = String(registryUrl).replace(/\/$/, '');
    this.identity = loadServerIdentity(dataDir);
    this.info = { ...info };
    this.timer = null;
    this.listeners = new Set();
    this.state = { phase: 'off', publicId: this.identity.publicId, verified: false, error: null, lastOk: 0, listedAs: null };
  }
  get publicId() {
    return this.identity.publicId;
  }
  onUpdate(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit() {
    const s = this.snapshot();
    for (const fn of this.listeners) try { fn(s); } catch {}
  }
  snapshot() {
    return { ...this.state, registryUrl: this.registryUrl, name: this.info.name || null, url: this.info.url || null };
  }
  setInfo(patch) {
    Object.assign(this.info, patch);
    if (this.timer) this.announce();
  }

  async announce() {
    if (!this.info.url || !this.info.name) {
      this.state.phase = 'idle';
      this.state.error = 'needs a public URL + a server name';
      this._emit();
      return;
    }
    const b = {
      name: this.info.name,
      url: this.info.url,
      description: this.info.description || '',
      region: this.info.region || '',
      publicJwk: this.identity.publicJwk,
      ts: Date.now(),
    };
    b.sig = this.identity.sign(canonical({ name: b.name, url: b.url, description: b.description, region: b.region, publicJwk: b.publicJwk, ts: b.ts }));
    try {
      const res = await fetch(this.registryUrl + '/announce', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(b),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'HTTP ' + res.status);
      this.state.phase = 'listed';
      this.state.verified = !!j.verified;
      this.state.listedAs = this.info.name;
      this.state.lastOk = Date.now();
      this.state.error = null;
    } catch (e) {
      this.state.phase = 'error';
      this.state.error = e.message;
    }
    this._emit();
  }

  start() {
    if (this.timer) return;
    this.announce();
    this.timer = setInterval(() => this.announce(), ANNOUNCE_MS);
    this.timer.unref && this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      const ts = Date.now();
      const sig = this.identity.sign(canonical({ publicId: this.identity.publicId, ts }));
      await fetch(this.registryUrl + '/announce', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ publicId: this.identity.publicId, ts, sig }),
      });
    } catch {}
    this.state.phase = 'off';
    this._emit();
  }
}

module.exports = { RegistryAnnouncer, loadServerIdentity };
