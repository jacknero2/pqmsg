'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s) => String(s || '').slice(0, 10);
let state = null;
let activeConv = null;
let lastRenderKey = '';

// ---------- login ----------
$('btn-register').onclick = async () => {
  const m = $('login-msg');
  m.className = 'msg';
  m.textContent = 'registering…';
  const r = await window.pqmsg.register({
    username: $('in-user').value.trim(),
    email: $('in-email').value.trim(),
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
  m.textContent = 'checking password…';
  const r = await window.pqmsg.login({
    username: $('in-user').value.trim(),
    password: $('in-pass').value,
    deviceName: $('in-device').value.trim() || undefined,
  });
  if (!r.ok) {
    m.textContent = r.error;
    return;
  }
  if (r.data.needs2fa) {
    $('twofa').hidden = false;
    $('twofa-info').textContent = r.data.dev
      ? `email not configured on this server — your code is ${r.data.devCode}`
      : `we emailed a 6-digit code to ${r.data.email}`;
    if (r.data.dev && r.data.devCode) $('in-code').value = r.data.devCode;
    $('in-code').focus();
    m.textContent = '';
  } else {
    m.className = 'msg ok';
    m.textContent = 'enrolled: ' + r.data.deviceId;
  }
};
$('btn-2fa-cancel').onclick = () => {
  $('twofa').hidden = true;
  $('in-code').value = '';
};
$('btn-2fa').onclick = async () => {
  const m = $('login-msg');
  m.className = 'msg';
  m.textContent = 'verifying code & generating device keys…';
  const r = await window.pqmsg.completeLogin({
    code: $('in-code').value.trim(),
    rememberDevice: $('in-remember').checked,
  });
  if (!r.ok) {
    m.textContent = r.error;
  } else {
    $('twofa').hidden = true;
    m.className = 'msg ok';
    m.textContent = 'enrolled: ' + r.data.deviceId;
  }
};
$('in-code').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-2fa').click());


// ---------- update prompts ----------
$('ur-btn').onclick = () => state && state.updateGate && window.pqmsg.openExternal(state.updateGate.downloadUrl);
$('ub-btn').onclick = () => state && state.updateInfo && window.pqmsg.openExternal(state.updateInfo.downloadUrl);
$('ub-x').onclick = () => {
  try { sessionStorage.setItem('ub-dismissed', '1'); } catch {}
  $('update-banner').hidden = true;
};

function renderUpdate(s) {
  const g = s.updateGate;
  $('update-required').hidden = !g;
  if (g) {
    $('ur-text').textContent = `You're running pqmsg ${g.current}. This ${g.source === 'server' ? 'server' : 'network'} requires ${g.required} or newer.`;
  }
  let dismissed = false;
  try { dismissed = sessionStorage.getItem('ub-dismissed') === '1'; } catch {}
  const showBanner = !g && s.updateInfo && !dismissed;
  $('update-banner').hidden = !showBanner;
  if (showBanner) $('ub-text').textContent = `pqmsg ${s.updateInfo.latest} is available (you have ${s.appVersion}).`;
}

// ---------- new conversation ----------
$('btn-open').onclick = () => openConv();
$('in-to').addEventListener('keydown', (e) => e.key === 'Enter' && openConv());
async function openConv(explicitHandle) {
  const m = $('newconv-msg');
  $('conv-pick').innerHTML = '';
  m.className = 'msg';
  m.textContent = 'looking up…';
  const r = await window.pqmsg.startConversation(explicitHandle || $('in-to').value.trim());
  if (!r.ok) {
    if (r.code === 'AMBIGUOUS' && r.candidates) {
      m.textContent = r.error;
      $('conv-pick').innerHTML = r.candidates
        .map((c) => `<button class="pick" data-h="${c.handle.replace(/"/g, '&quot;')}">${c.label}</button>`)
        .join('');
      for (const b of $('conv-pick').querySelectorAll('.pick')) b.onclick = () => openConv(b.dataset.h);
      return;
    }
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

// ---------- new group ----------
$('btn-group').onclick = () => {
  $('groupbar').hidden = !$('groupbar').hidden;
};
$('btn-gcancel').onclick = () => {
  $('groupbar').hidden = true;
};
$('btn-gcreate').onclick = async () => {
  const m = $('newconv-msg');
  const name = $('in-gname').value.trim();
  const members = $('in-gmembers').value.split(',').map((s) => s.trim()).filter(Boolean);
  if (!name || members.length < 2) {
    m.className = 'msg';
    m.textContent = 'need a name and at least 2 members';
    return;
  }
  m.className = 'msg';
  m.textContent = 'resolving members…';
  const r = await window.pqmsg.startGroup(name, members);
  if (!r.ok) {
    m.textContent = r.error;
    return;
  }
  m.className = 'msg ok';
  m.textContent = 'group created';
  $('groupbar').hidden = true;
  $('in-gname').value = $('in-gmembers').value = '';
  activeConv = r.data;
  await window.pqmsg.sendMessage(activeConv, `created “${name}”`);
  await refresh();
  selectConv(activeConv);
};

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
$('btn-switch-account').onclick = async () => {
  const sure = confirm(
    'Log out and switch to a different account? Nothing is deleted — this account’s keys and ' +
    'message history stay on this device, and logging back in (password + the emailed code) ' +
    'picks up right where you left off.'
  );
  if (!sure) return;
  await window.pqmsg.switchAccount();
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
  renderUpdate(state);
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

  // conversation requests (must be accepted before messages flow)
  const reqs = state.conversations.filter((c) => c.status === 'pending');
  const rb = $('requests');
  rb.innerHTML = reqs.length ? '<div class="reqs-h">requests</div>' : '';
  for (const c of reqs) {
    const div = document.createElement('div');
    div.className = 'req';
    const who = c.kind === 'group' ? `group “${esc(c.name || 'group')}”` : esc(c.requestFrom || 'someone');
    div.innerHTML = `<div class="q">accept conversation from ${who}?</div>
      <div class="qbtns"><button class="yes">yes</button><button class="no">no</button></div>`;
    div.querySelector('.yes').onclick = () => window.pqmsg.acceptConversation(c.convId);
    div.querySelector('.no').onclick = () => window.pqmsg.declineConversation(c.convId);
    rb.appendChild(div);
  }

  // active conversations
  const sb = $('convlist');
  sb.innerHTML = '';
  for (const c of state.conversations.filter((x) => x.status === 'active')) {
    const div = document.createElement('div');
    div.className = 'conv' + (c.convId === activeConv ? ' active' : '');
    const tagClass = c.lastMine ? (c.lastDisplay === 'delivered' ? 'tag' : 'tag red') : 'tag';
    const tag = c.lastMine ? `<span class="${tagClass}">${c.lastDisplay === 'delivered' ? '✓ delivered' : '· pending'}</span> ` : '';
    const icon = c.kind === 'group' ? '👥 ' : '';
    div.innerHTML = `<div class="name">${icon}${esc(c.title)}</div><div class="prev">${tag}${esc(c.lastText || '…')}</div>`;
    div.onclick = () => selectConv(c.convId);
    sb.appendChild(div);
  }

  if (activeConv) renderThread();
}

async function renderThread() {
  const r = await window.pqmsg.getConversation(activeConv);
  if (!r.ok || !r.data) return;
  const conv = r.data;
  const others = conv.participants.filter((p) => p !== '@' + state.username);
  const recon = conv.lastReconciledAt ? Math.round((Date.now() - conv.lastReconciledAt) / 1000) + 's ago' : '—';
  const title = conv.kind === 'group' ? `👥 ${esc(conv.name || 'group')}` : esc(others.join(', ') || 'you');
  const membersLine = conv.kind === 'group' ? ` · ${esc(conv.participants.join(', '))}` : '';
  const homeLine = conv.homeIsMine ? '' : ` · hosted on ${esc((conv.homeServer || '').replace(/^https?:\/\//, ''))}`;
  $('thread-head').innerHTML = `<b>${title}</b>${membersLine} · ${conv.kind} · seq ${conv.cursorSeq} · reconciled ${recon}${homeLine}`;
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
    enroll: (e) =>
      e.returning
        ? `<span class="k">✦ welcome back</span> ${esc(e.deviceName)} — recognized as the same device, history restored`
        : `<span class="k">✦ enrolled</span> ${esc(e.deviceName)} = ${short(e.deviceId)}`,
    'ws-open': () => `<span class="k">≋ websocket connected</span>`,
    'conversation-open': (e) => `→ opened @${e.username} · ${e.devices} device(s) · safety ${e.safetyNumber?.slice(0, 14)}…`,
  };
  const f = map[ev.kind];
  return f ? f(ev) : esc(ev.kind);
}

async function refresh() {
  const r = await window.pqmsg.snapshot();
  if (r.ok) {
    state = r.data;
    render();
  }
}
refresh();
setInterval(() => state && render(), 1000); // keep "Ns ago" / update prompts fresh
