'use strict';
/* In-memory presence table + rolling event log for the dashboard ticker. */

class Presence {
  constructor() {
    this.peers = new Map(); // wsId -> { username, deviceId, deviceName, ip, connectedAt, lastSeen }
    this.events = []; // rolling buffer
    this._seq = 0;
    this.listeners = new Set(); // fn(kind, payload)
  }
  onBroadcast(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  _emit(kind, payload) {
    for (const fn of this.listeners) {
      try {
        fn(kind, payload);
      } catch {}
    }
  }
  log(type, detail) {
    const ev = { seq: ++this._seq, at: Date.now(), type, ...detail };
    this.events.push(ev);
    if (this.events.length > 500) this.events.shift();
    this._emit('event', ev);
    return ev;
  }
  eventsSince(seq) {
    return this.events.filter((e) => e.seq > (seq || 0));
  }
  add(wsId, info) {
    this.peers.set(wsId, { ...info, connectedAt: Date.now(), lastSeen: Date.now() });
    this.log('connect', { username: info.username, deviceName: info.deviceName, deviceId: info.deviceId, ip: info.ip });
    this._emit('presence', this.list());
  }
  touch(wsId) {
    const p = this.peers.get(wsId);
    if (p) p.lastSeen = Date.now();
  }
  remove(wsId) {
    const p = this.peers.get(wsId);
    if (!p) return;
    this.peers.delete(wsId);
    this.log('disconnect', { username: p.username, deviceName: p.deviceName, deviceId: p.deviceId });
    this._emit('presence', this.list());
  }
  list() {
    return [...this.peers.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  }
  isOnline(deviceId) {
    for (const p of this.peers.values()) if (p.deviceId === deviceId) return true;
    return false;
  }
}

module.exports = { Presence };
