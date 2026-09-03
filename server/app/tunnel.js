'use strict';
/*
 * Manages a Cloudflare "quick tunnel" child process so the self-hosted server
 * gets a public https:// URL without any router / port-forward configuration.
 * The tunnel dials OUT from this machine, so it works behind NAT, CGNAT and
 * restrictive (university / corporate) networks.
 *
 * The `cloudflared` binary is shipped in the app bundle (Contents/Resources)
 * by CI; in a dev checkout we fall back to one on $PATH.
 */
const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

class Tunnel extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.url = null;
    this.state = 'off'; // off | starting | on | error
    this.error = null;
    this.log = [];
  }

  binaryPath() {
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    const candidates = [
      process.resourcesPath && path.join(process.resourcesPath, name),
      path.join(__dirname, '..', '..', 'resources', name), // dev, if manually placed
    ].filter(Boolean);
    for (const c of candidates) if (fs.existsSync(c)) return c;
    return name; // rely on $PATH (dev machines with `brew install cloudflared`)
  }

  _push(line) {
    this.log.push(line);
    if (this.log.length > 200) this.log.shift();
    this.emit('log', line);
  }

  start(port) {
    if (this.proc) return;
    this.state = 'starting';
    this.error = null;
    this.url = null;
    this.emit('update', this.snapshot());

    const bin = this.binaryPath();
    let proc;
    try {
      proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      this.state = 'error';
      this.error = `could not launch cloudflared (${e.code || e.message})`;
      this.emit('update', this.snapshot());
      return;
    }
    this.proc = proc;

    const onData = (buf) => {
      const s = buf.toString();
      s.split('\n').filter(Boolean).forEach((l) => this._push(l));
      const m = s.match(URL_RE);
      if (m && !this.url) {
        this.url = m[0];
        this.state = 'on';
        this.emit('update', this.snapshot());
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData); // cloudflared prints the URL on stderr

    proc.on('error', (e) => {
      this.state = 'error';
      this.error =
        e.code === 'ENOENT'
          ? 'cloudflared not found — the tunnel helper is missing from this build'
          : e.message;
      this.proc = null;
      this.emit('update', this.snapshot());
    });
    proc.on('exit', (code) => {
      this.proc = null;
      this.url = null;
      if (this.state !== 'error') this.state = 'off';
      this._push(`cloudflared exited (${code})`);
      this.emit('update', this.snapshot());
    });
  }

  stop() {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.url = null;
    this.state = 'off';
    this.emit('update', this.snapshot());
  }

  snapshot() {
    return { state: this.state, url: this.url, error: this.error };
  }
}

module.exports = { Tunnel };
