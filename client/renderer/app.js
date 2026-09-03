'use strict';
const $ = (id) => document.getElementById(id);
let state = null;
let activeConv = null;
let lastRenderKey = '';

// ---------- login ----------
$('btn-register').onclick = async () => {
  const m = $('login-msg');
  m.className = 'msg';
  m.textContent = 'registering…';
  const r = await window.pqmsg.register({
    serverUrl: $('in-server').value.trim(),
    username: $('in-user').value.trim(),
    password: $('in-pass').value,
  });
  if (r.ok) {
    m.className = 'msg ok';
    m.textContent = 'account created — now log in';
  } else {
    m.textContent = r.error;
  }
};
$('btn-login').onclick = async () => {
  const m = $('login-msg');
  m.className = 'msg';
  m.textContent = 'logging in & generating device keys…';
  const r = await window.pqmsg.login({
    serverUrl: $('in-server').value.trim(),
    username: $('in-user').value.trim(),
    password: $('in-pass').value,
    deviceName: $('in-device').value.trim() || undefined,
  });
  if (!r.ok) {
    m.textContent = r.error;
  } else {
    m.className = 'msg ok';
    m.textContent = 'enrolled: ' + r.data.deviceId;
  }
};

// ---------- new conversation ----------
$('btn-open').onclick = openConv;
$('in-to').addEventListener('keydown', (e) => e.key === 'Enter' && openConv());
async function openConv() {
  const m = $('newconv-msg');
  m.className = 'msg';
  m.textContent = 'querying IDS…';
  const r = await window.pqmsg.startConversation($('in-to').value.trim());
  if (!r.ok) {
    m.textContent = r.error;
    return;
  }
  m.className = 'msg ok';
  m.textContent = 'keys retrieved';
  activeConv = r.data;
  $('in-to').value = '';
  await refresh();
  selectConv(activeConv);
}

// ---------- header / settings ----------
$('btn-sync').onclick = () => window.pqmsg.syncNow();
$('btn-settings').onclick = () => {
  fillSettings();
  $('settings').hidden = false;
};
$('btn-close-settings').onclick = () => ($('settings').hidden = true);
$('btn-logout').onclick = async () => {
  await window.pqmsg.logout();
  $('settings').hidden = true;
};
$('si').addEventListener('input', (e) => {
  $('si-val').textContent = e.target.value;
});
$('si').addEventListener('change', (e) => window.pqmsg.setSyncInterval(parseInt(e.target.value, 10)));

function fillSettings() {
  if (!state) return;
  $('si').value = state.syncIntervalMs;
  $('si-val').textContent = state.syncIntervalMs;
  $('set-server').textContent = state.serverUrl;
  $('set-user').textContent = state.username || '—';
  $('set-device').textContent = state.deviceId || '—';
  $('set-safety').textContent = state.safetyNumber || '—';
  $('set-dir').textContent = state.dir || '—';
}

// ---------- composer ----------
$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('in-msg');
  const text = inp.value;
  if (!text.trim() || !activeConv) return;
  inp.value = '';
  const r = await window.pqmsg.sendMessage(activeConv, text);
  if (!r.ok) {
    logLine(`<span class="r">send error: ${esc(r.error)}</span>`);
    inp.value = text;
  }
});

// ---------- render ----------
window.pqmsg.onUpdate((s) => {
  state = s;
  render();
});
window.pqmsg.onEvent((ev) => logLine(fmtEvent(ev)));

function render() {
  if (!state) return;
  const loggedIn = state.enrolled && !state.needsLogin;
  $('login').hidden = loggedIn;
  $('app').hidden = !loggedIn;
  if (!loggedIn) return;

  $('hdr-user').textContent = '@' + state.username;
  $('hdr-device').textContent = state.deviceName || '';
  $('dot').className = 'dot' + (state.connected ? ' on' : '');
  const ago = state.lastSyncAt ? Math.round((Date.now() - state.lastSyncAt) / 1000) + 's ago' : 'never';
  $('sync-status').textContent =
    (state.syncing ? 'syncing… ' : 'synced ' + ago) + (state.lastSyncError ? ' · ⚠ ' + state.lastSyncError : '');

  // sidebar
  const sb = $('sidebar');
  sb.innerHTML = '';
  for (const c of state.conversations) {
    const div = document.createElement('div');
    div.className = 'conv' + (c.convId === activeConv ? ' active' : '');
    const tagClass = c.lastMine ? (c.lastDisplay === 'delivered' ? 'tag' : 'tag red') : 'tag';
    const tag = c.lastMine ? `<span class="${tagClass}">${c.lastDisplay === 'delivered' ? '✓ delivered' : '· pending'}</span> ` : '';
    div.innerHTML = `<div class="name">${esc(c.title)}</div><div class="prev">${tag}${esc(c.lastText || '…')}</div>`;
    div.onclick = () => selectConv(c.convId);
    sb.appendChild(div);
  }

  if (activeConv) renderThread();
}

async function renderThread() {
  const r = await window.pqmsg.getConversation(activeConv);
  if (!r.ok || !r.data) return;
  const conv = r.data;
  const others = conv.participants.filter((p) => p !== state.username);
  const recon = conv.lastReconciledAt ? Math.round((Date.now() - conv.lastReconciledAt) / 1000) + 's ago' : '—';
  $('thread-head').innerHTML = `<b>${esc(others.join(', ') || conv.participants.join(', '))}</b> · ${conv.kind} · seq ${conv.cursorSeq} · reconciled ${recon}`;
  $('composer').hidden = false;

  const key = conv.messages.map((m) => m.msgId + m.display + m.serverSeq).join('|');
  const box = $('messages');
  const wasBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = '';
  for (const m of conv.messages) {
    const d = document.createElement('div');
    d.className = 'bubble ' + (m.mine ? 'out' : 'in') + (key !== lastRenderKey ? ' flash' : '');
    d.dataset.display = m.display;
    const when = new Date(m.sentAt).toLocaleTimeString();
    let status = '';
    if (m.mine) {
      status =
        m.display === 'delivered'
          ? ' · delivered ✓'
          : m.display === 'failed'
          ? ' · failed ✗ ' + esc(m.error || '')
          : m.state === 'pending'
          ? ' · queued'
          : ' · sent (awaiting delivery)';
    } else if (m.display === 'suspect') {
      status = ' · ⚠ unverified signature';
    } else if (m.display === 'received') {
      status = m.verified ? ' · ✓ sig ok' : '';
    }
    d.innerHTML = `${esc(m.text)}<div class="meta">${m.mine ? 'you' : esc(m.sender)} · ${when} · #${m.serverSeq ?? '—'}${status}</div>`;
    box.appendChild(d);
  }
  lastRenderKey = key;
  if (wasBottom) box.scrollTop = box.scrollHeight;
}

function selectConv(id) {
  activeConv = id;
  lastRenderKey = '';
  render();
}

// ---------- console ----------
function logLine(html) {
  const c = $('console');
  const atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 30;
  const div = document.createElement('div');
  div.className = 'l';
  div.innerHTML = `<span class="k">${new Date().toLocaleTimeString()}</span> ${html}`;
  c.appendChild(div);
  while (c.children.length > 200) c.removeChild(c.firstChild);
  if (atBottom) c.scrollTop = c.scrollHeight;
}
function fmtEvent(ev) {
  const map = {
    encrypted: (e) => `<span class="k">⊕ encrypted</span> msg for ${e.forDevices} device(s) in ${short(e.convId)}`,
    sent: (e) => `↑ sent ${short(e.msgId)} → server #${e.serverSeq}`,
    decrypted: (e) => `<span class="k">⊗ decrypted</span> from @${e.from} ${e.verified ? '<span class="k">[sig ✓]</span>' : '<span class="r">[sig ✗]</span>'}`,
    delivered: (e) => `<span class="g">✓ delivered</span> ${short(e.msgId)}`,
    reordered: (e) => `↺ reconciled order of ${short(e.convId)} (${e.length})`,
    'safety-number-changed': (e) => `<span class="r">⚠ safety number changed for @${e.username}</span>`,
    'send-failed': (e) => `<span class="r">✗ send failed: ${esc(e.error)}</span>`,
    'sync-error': (e) => `<span class="r">sync error: ${esc(e.error)}</span>`,
    enroll: (e) => `<span class="k">✦ enrolled</span> ${esc(e.deviceName)} = ${short(e.deviceId)}`,
    'ws-open': () => `<span class="k">≋ websocket connected</span>`,
    'conversation-open': (e) => `→ opened @${e.username} · ${e.devices} device(s) · safety ${e.safetyNumber?.slice(0, 14)}…`,
  };
  const f = map[ev.kind];
  return f ? f(ev) : esc(ev.kind);
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s) => String(s || '').slice(0, 10);

async function refresh() {
  const r = await window.pqmsg.snapshot();
  if (r.ok) {
    state = r.data;
    render();
  }
}
refresh();
setInterval(() => state && !state.needsLogin && render(), 1000); // keep "Ns ago" fresh
