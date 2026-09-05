'use strict';
/* Thin HTTP client for the pqmsg server (uses global fetch, Node 18+). */

class Api {
  constructor(baseUrl, token) {
    this.base = (baseUrl || '').replace(/\/$/, '');
    this.token = token || null;
  }
  setToken(t) {
    this.token = t;
  }
  async _req(method, p, body) {
    const res = await fetch(this.base + p, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.token ? { authorization: 'Bearer ' + this.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
  get(p) {
    return this._req('GET', p);
  }
  post(p, b) {
    return this._req('POST', p, b);
  }

  // endpoints
  register(username, password, email) {
    return this.post('/api/auth/register', { username, password, email });
  }
  login(username, password, trustToken) {
    return this.post('/api/auth/login', { username, password, trustToken: trustToken || undefined });
  }
  verify(challengeId, code, rememberDevice) {
    return this.post('/api/auth/verify', { challengeId, code, rememberDevice: !!rememberDevice });
  }
  enrollDevice(d) {
    return this.post('/api/devices', d);
  }
  myDevices() {
    return this.get('/api/devices');
  }
  ids(username) {
    return this.get('/api/ids/' + encodeURIComponent(username));
  }
  inbox() {
    return this.get('/api/inbox');
  }
  sendMessage(convId, payload) {
    return this.post(`/api/conv/${convId}/messages`, payload);
  }
  fetchMessages(convId, sinceSeq) {
    return this.get(`/api/conv/${convId}/messages?sinceSeq=${sinceSeq || 0}`);
  }
  ackDelivered(convId, msgId, deviceId) {
    return this.post(`/api/conv/${convId}/messages/${msgId}/delivered`, { deviceId });
  }
  ackSeen(convId, msgId, deviceId) {
    return this.post(`/api/conv/${convId}/messages/${msgId}/seen`, { deviceId });
  }
  listBlocks() {
    return this.get('/api/blocks');
  }
  block(username) {
    return this.post('/api/blocks', { username });
  }
  unblock(username) {
    return this._req('DELETE', '/api/blocks/' + encodeURIComponent(username));
  }
  deleteAccount() {
    return this._req('DELETE', '/api/account');
  }
  health() {
    return this.get('/api/health');
  }
}

module.exports = { Api };
