'use strict';
/*
 * Lightweight, persistent, restart-surviving usage analytics — daily buckets
 * of counters, not raw event logs (so the file stays small forever). Signup
 * history doesn't need tracking here at all: account.createdAt already gives
 * exact per-day signup counts retroactively (see index.js's /api/admin/analytics).
 *
 * This only tracks what isn't otherwise derivable: logins, unique daily active
 * users, messages sent, peak concurrent connections, and session durations
 * (for an average-minutes-per-session figure) — the "how much is this
 * actually being used" questions.
 */
const fs = require('fs');
const path = require('path');

const MAX_DAYS = 400; // ~13 months of daily buckets before the oldest are dropped

const dayKey = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

class Analytics {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'analytics.json');
    this.days = {}; // 'YYYY-MM-DD' -> { logins, activeUsers: [...usernames], messages, peakConcurrent, sessionSecs, sessions }
    this._sessions = new Map(); // wsId -> connectedAt, for duration-on-disconnect
    this._dirty = false;
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.days = saved.days || {};
    } catch {}
    this._saveTimer = setInterval(() => this._flush(), 15_000);
    this._saveTimer.unref && this._saveTimer.unref();
  }

  _bucket(ts = Date.now()) {
    const key = dayKey(ts);
    if (!this.days[key]) this.days[key] = { logins: 0, activeUsers: [], messages: 0, peakConcurrent: 0, sessionSecs: 0, sessions: 0 };
    return this.days[key];
  }
  _markActive(username, ts) {
    const b = this._bucket(ts);
    if (username && !b.activeUsers.includes(username)) b.activeUsers.push(username);
  }
  _prune() {
    const keys = Object.keys(this.days).sort();
    while (keys.length > MAX_DAYS) delete this.days[keys.shift()];
  }
  _flush() {
    if (!this._dirty) return;
    this._dirty = false;
    this._prune();
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ days: this.days }, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[analytics] save failed:', e.message);
    }
  }

  recordLogin(username) {
    const b = this._bucket();
    b.logins++;
    this._markActive(username, Date.now());
    this._dirty = true;
  }
  recordMessage(username) {
    this._bucket().messages++;
    this._markActive(username, Date.now());
    this._dirty = true;
  }
  recordConnect(wsId, username, concurrentNow) {
    this._sessions.set(wsId, Date.now());
    const b = this._bucket();
    if (concurrentNow > b.peakConcurrent) b.peakConcurrent = concurrentNow;
    this._markActive(username, Date.now());
    this._dirty = true;
  }
  recordDisconnect(wsId) {
    const start = this._sessions.get(wsId);
    this._sessions.delete(wsId);
    if (!start) return;
    const b = this._bucket();
    b.sessionSecs += Math.max(0, (Date.now() - start) / 1000);
    b.sessions++;
    this._dirty = true;
  }

  /** @returns {{date, logins, activeUsers, messages, peakConcurrent, avgSessionMinutes}[]} for the last `days` days, oldest first */
  series(days = 30) {
    const out = [];
    const now = Date.now();
    for (let i = days - 1; i >= 0; i--) {
      const key = dayKey(now - i * 86_400_000);
      const b = this.days[key];
      out.push({
        date: key,
        logins: b ? b.logins : 0,
        activeUsers: b ? b.activeUsers.length : 0,
        messages: b ? b.messages : 0,
        peakConcurrent: b ? b.peakConcurrent : 0,
        avgSessionMinutes: b && b.sessions ? Math.round((b.sessionSecs / b.sessions / 60) * 10) / 10 : 0,
      });
    }
    return out;
  }

  close() {
    clearInterval(this._saveTimer);
    this._flush();
  }
}

module.exports = { Analytics, dayKey };
