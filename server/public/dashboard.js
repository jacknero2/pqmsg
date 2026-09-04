'use strict';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SESSION_KEY = 'pqmsg_admin_session';
let ADMIN = params.get('admin') || localStorage.getItem(SESSION_KEY) || '';
let H = () => (ADMIN ? { 'X-Admin-Token': ADMIN } : {});
let timer = null;
let intervalMs = 2000;
let selectedConv = null;
let evSeq = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (t) => (t ? Math.round((Date.now() - t) / 1000) + 's' : '—');
const api = async (p, opts) => {
  const r = await fetch(p, { ...opts, headers: { 'content-type': 'application/json', ...H(), ...(opts && opts.headers) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || r.status), { status: r.status });
  return j;
};

// ============================================================== auth gate
let pendingChallenge = null; // { challengeId, kind: 'setup'|'login'|'reset' }

function showGate(which) {
  for (const id of ['gate-setup', 'gate-login', 'gate-forgot', 'gate-code']) $(id).hidden = id !== which;
  $('gate-msg').textContent = '';
  $('gate-msg').className = 'msg';
}
function gateError(e) {
  $('gate-msg').className = 'msg';
  $('gate-msg').textContent = e && e.message ? e.message : String(e);
}

async function boot() {
  if (ADMIN) {
    try {
      await api('/api/admin/overview'); // validates the token/session we have
      startDashboard();
      return;
    } catch {
      ADMIN = '';
      localStorage.removeItem(SESSION_KEY);
    }
  }
  $('gate').hidden = false;
  try {
    const s = await api('/api/admin/master/status');
    $('setup-email').textContent = s.email;
    $('forgot-email').textContent = s.email;
    showGate(s.hasPassword ? 'gate-login' : 'gate-setup');
  } catch (e) {
    gateError(e);
  }
}

$('btn-setup').onclick = async () => {
  try {
    const password = $('setup-pw').value;
    const r = await api('/api/admin/master/setup', { method: 'POST', body: JSON.stringify({ password }) });
    pendingChallenge = { challengeId: r.challengeId, kind: 'setup' };
    $('code-newpw-l').hidden = true;
    $('code-info').textContent = r.dev ? `dev mode — your code is ${r.devCode}` : `we emailed a code to ${r.email}`;
    if (r.dev && r.devCode) $('code-in').value = r.devCode;
    showGate('gate-code');
  } catch (e) {
    gateError(e);
  }
};
$('btn-login').onclick = async () => {
  try {
    const password = $('login-pw').value;
    const r = await api('/api/admin/master/login', { method: 'POST', body: JSON.stringify({ password }) });
    pendingChallenge = { challengeId: r.challengeId, kind: 'login' };
    $('code-newpw-l').hidden = true;
    $('code-info').textContent = r.dev ? `dev mode — your code is ${r.devCode}` : `we emailed a code to ${r.email}`;
    if (r.dev && r.devCode) $('code-in').value = r.devCode;
    showGate('gate-code');
  } catch (e) {
    gateError(e);
  }
};
$('btn-forgot').onclick = () => showGate('gate-forgot');
$('btn-forgot-cancel').onclick = () => showGate('gate-login');
$('btn-forgot-send').onclick = async () => {
  try {
    const r = await api('/api/admin/master/reset', { method: 'POST', body: '{}' });
    pendingChallenge = { challengeId: r.challengeId, kind: 'reset' };
    $('code-newpw-l').hidden = false;
    $('code-info').textContent = r.dev ? `dev mode — your code is ${r.devCode}` : `we emailed a reset code to ${r.email}`;
    if (r.dev && r.devCode) $('code-in').value = r.devCode;
    showGate('gate-code');
  } catch (e) {
    gateError(e);
  }
};
$('btn-code').onclick = async () => {
  if (!pendingChallenge) return;
  try {
    const code = $('code-in').value.trim();
    if (pendingChallenge.kind === 'reset') {
      await api('/api/admin/master/reset/verify', {
        method: 'POST',
        body: JSON.stringify({ challengeId: pendingChallenge.challengeId, code, newPassword: $('code-newpw').value }),
      });
      pendingChallenge = null;
      showGate('gate-login');
      $('gate-msg').className = 'msg ok';
      $('gate-msg').textContent = 'password reset — log in below';
      return;
    }
    const r = await api('/api/admin/master/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId: pendingChallenge.challengeId, code }),
    });
    ADMIN = r.sessionToken;
    localStorage.setItem(SESSION_KEY, ADMIN);
    $('gate').hidden = true;
    startDashboard();
  } catch (e) {
    gateError(e);
  }
};

// ============================================================== tabs
$('tab-console').onclick = () => switchTab('console');
$('tab-analytics').onclick = () => switchTab('analytics');
function switchTab(name) {
  $('tab-console').classList.toggle('active', name === 'console');
  $('tab-analytics').classList.toggle('active', name === 'analytics');
  $('view-console').hidden = name !== 'console';
  $('view-analytics').hidden = name !== 'analytics';
  if (name === 'analytics') loadAnalytics();
}

// ============================================================== analytics
function barChart(title, series, key, opts = {}) {
  const w = 300, h = 90, pad = 4;
  const vals = series.map((d) => d[key]);
  const max = Math.max(1, ...vals);
  const bw = (w - pad * 2) / series.length;
  const bars = series
    .map((d, i) => {
      const bh = Math.max(1, (d[key] / max) * (h - 14));
      const x = pad + i * bw;
      const y = h - 14 - bh;
      const label = opts.suffix ? `${d[key]}${opts.suffix}` : d[key];
      return `<rect class="bar" x="${x + 0.5}" y="${y}" width="${Math.max(1, bw - 1)}" height="${bh}"><title>${esc(d.date)}: ${label}</title></rect>`;
    })
    .join('');
  const firstLabel = series[0] ? series[0].date.slice(5) : '';
  const lastLabel = series[series.length - 1] ? series[series.length - 1].date.slice(5) : '';
  return `<div class="chart"><h3>${esc(title)}</h3>
    <svg viewBox="0 0 ${w} ${h}">
      ${bars}
      <text class="axis" x="${pad}" y="${h - 2}">${esc(firstLabel)}</text>
      <text class="axis" x="${w - pad - 30}" y="${h - 2}">${esc(lastLabel)}</text>
    </svg></div>`;
}

async function loadAnalytics() {
  let data;
  try {
    data = await api('/api/admin/analytics?days=30');
  } catch (e) {
    $('kpis').innerHTML = `<div class="dim">analytics error: ${esc(e.message)}</div>`;
    return;
  }
  const totalActive30d = new Set();
  // (activeUsers per day are counts, not lists, at the API boundary — this KPI
  // instead reports the peak single-day active-user count over the window)
  const peakDau = Math.max(0, ...data.series.map((d) => d.activeUsers));
  $('kpis').innerHTML = [
    ['total users', data.totalUsers],
    ['online now', data.currentlyOnline],
    ['messages (all time)', data.totalMessagesAllTime],
    ['peak DAU (30d)', peakDau],
  ].map(([k, v]) => `<div class="kpi"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('');

  $('charts').innerHTML = [
    barChart('signups / day', data.series, 'signups'),
    barChart('active users / day', data.series, 'activeUsers'),
    barChart('logins / day', data.series, 'logins'),
    barChart('messages / day', data.series, 'messages'),
    barChart('peak concurrent / day', data.series, 'peakConcurrent'),
    barChart('avg session length', data.series, 'avgSessionMinutes', { suffix: 'm' }),
  ].join('');
}

// ============================================================== console (unchanged behavior)
async function tick() {
  try {
    const [ov, pres, accts, convs] = await Promise.all([
      api('/api/admin/overview'),
      api('/api/admin/presence'),
      api('/api/admin/accounts'),
      api('/api/admin/conversations'),
    ]);
    renderOverview(ov);
    renderConnections(pres.peers);
    renderAccounts(accts.accounts);
    renderConversations(convs.conversations);
    if (selectedConv) renderDetail(selectedConv);
    const ev = await api('/api/admin/events?since=' + evSeq);
    for (const e of ev.events) pushEvent(e);
  } catch (e) {
    $('stat').innerHTML = `<span style="color:var(--lred)">dashboard error: ${esc(e.message)}</span>`;
  }
}

function renderOverview(ov) {
  const s = ov.stats;
  $('stat').innerHTML =
    `backend <b>${esc(s.backend)}</b>${s.repo ? ' ' + esc(s.repo) : ''} · ` +
    `accounts <b>${s.accounts}</b> · devices <b>${s.devices}</b> · ` +
    `conversations <b>${s.conversations}</b> · messages <b>${s.messages}</b> · ` +
    `auth <b>${esc(ov.adminAuth)}</b>`;
}
function renderConnections(peers) {
  $('conn-count').textContent = peers.length;
  $('connections').innerHTML =
    peers.map((p) => `
      <div class="row">
        <div class="a">● <span class="on">@${esc(p.username)}</span> · ${esc(p.deviceName)}</div>
        <div class="b">${esc(p.deviceId).slice(0, 18)}… · ${esc(p.ip || '?')} · up ${ago(p.connectedAt)} · seen ${ago(p.lastSeen)}</div>
      </div>`).join('') || '<div class="row b">no clients connected</div>';
}
function renderAccounts(accts) {
  $('acct-count').textContent = accts.length;
  $('accounts').innerHTML = accts.map((a) => `
    <div class="row">
      <div class="a">@${esc(a.username)} <span class="dim">· ${a.deviceCount} device(s)</span></div>
      <div class="b">safety ${esc((a.safetyNumber || '').slice(0, 29))}…</div>
      ${a.devices.map((d) => `<div class="b">&nbsp;&nbsp;↳ ${d.online ? '<span class="on">●</span>' : '<span class="off">○</span>'} ${esc(d.deviceName)} · ${esc(d.deviceId).slice(0, 16)}… · kem:${esc(d.kemPublicKeyHead)}…</div>`).join('')}
    </div>`).join('') || '<div class="row b">no accounts</div>';
}
function renderConversations(convs) {
  $('conv-count').textContent = convs.length;
  $('conversations').innerHTML = convs.map((c) => `
    <div class="row click ${c.convId === selectedConv ? 'active' : ''}" data-id="${esc(c.convId)}">
      <div class="a">📁 ${esc(c.participants.join(' · '))}</div>
      <div class="b">${esc(c.convId)} · ${c.kind} · ${c.messageCount} msg</div>
    </div>`).join('') || '<div class="row b">no conversations</div>';
  for (const el of $('conversations').querySelectorAll('.row.click')) {
    el.onclick = () => {
      selectedConv = el.dataset.id;
      renderConversations(convs);
      renderDetail(selectedConv);
    };
  }
}
async function renderDetail(convId) {
  let data;
  try {
    data = await api('/api/admin/conv/' + convId);
  } catch (e) {
    $('conv-detail').innerHTML = `<p class="dim">${esc(e.message)}</p>`;
    return;
  }
  const rows = data.messages
    .map((m) => {
      const recs = m.recipients
        .map((r) => `<span class="${r.delivered ? 'd-ok' : 'd-no'}">${esc(r.deviceId).slice(0, 12)}…${r.delivered ? '✓' : '·'}</span>`)
        .join(' ');
      return `<div class="msg-line">
        <span class="seq">#${m.serverSeq}</span> @${esc(m.sender)}
        <span class="rc">(dev ${esc(m.senderDevice).slice(0, 12)}…, lamport ${m.seq})</span>
        · sent ${new Date(m.sentAt).toLocaleTimeString()} · recv ${new Date(m.serverRecvAt).toLocaleTimeString()}
        <button data-msg="${esc(m.msgId)}">raw</button>
        <br />ct[${m.ctBytes}B] <code>${esc(m.ctPreview)}…</code>
        <br />sig <code>${esc(m.sigPreview)}…</code> · to: ${recs}
      </div>`;
    })
    .join('');
  $('conv-detail').innerHTML = `
    <div class="b">order.json → [${data.order.map((x) => esc(x).slice(0, 8)).join(', ')}]</div>
    ${rows || '<p class="dim">no messages</p>'}
    <div class="lock-note">🔒 message bodies are ML-KEM/AES-GCM ciphertext. The server (this console) cannot read them — only enrolled recipient devices can.</div>`;
  for (const b of $('conv-detail').querySelectorAll('button[data-msg]')) {
    b.onclick = async () => {
      const raw = await api(`/api/admin/conv/${convId}/raw/${b.dataset.msg}`);
      $('raw-title').textContent = b.dataset.msg;
      $('raw-body').textContent = JSON.stringify(raw, null, 2);
      $('raw').hidden = false;
    };
  }
}
$('raw-close').onclick = () => ($('raw').hidden = true);

function pushEvent(e) {
  evSeq = Math.max(evSeq, e.seq);
  const f = $('events');
  const atBottom = f.scrollHeight - f.scrollTop - f.clientHeight < 30;
  const div = document.createElement('div');
  div.className = 'e';
  const cls = e.type === 'delivered' ? 'g' : /error|fail|disconnect/.test(e.type) ? 'r' : 't';
  const detail = Object.entries(e)
    .filter(([k]) => !['seq', 'at', 'type'].includes(k))
    .map(([k, v]) => `${k}=${esc(v)}`)
    .join(' ');
  div.innerHTML = `<span class="t">${new Date(e.at).toLocaleTimeString()}</span> <span class="${cls}">${esc(e.type)}</span> ${detail}`;
  f.appendChild(div);
  while (f.children.length > 300) f.removeChild(f.firstChild);
  if (atBottom) f.scrollTop = f.scrollHeight;
}

// live event/presence stream (best-effort; polling still runs)
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws-admin${ADMIN ? '?admin=' + encodeURIComponent(ADMIN) : ''}`);
  ws.onmessage = (m) => {
    try {
      const { type, payload } = JSON.parse(m.data);
      if (type === 'event') pushEvent(payload);
      if (type === 'presence') renderConnections(payload);
    } catch {}
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
  ws.onerror = () => ws.close();
}

$('interval').onchange = (e) => {
  intervalMs = parseInt(e.target.value, 10);
  clearInterval(timer);
  timer = setInterval(tick, intervalMs);
};
setInterval(() => ($('clock').textContent = new Date().toLocaleTimeString()), 1000);

function startDashboard() {
  $('dash').hidden = false;
  timer = setInterval(tick, intervalMs);
  connectWs();
  tick();
}

boot();
