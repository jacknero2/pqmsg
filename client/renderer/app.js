'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const short = (s) => String(s || '').slice(0, 10);
let state = null;
let activeConv = null;
let lastRenderKey = '';
let lastUser = null; // detects a login/switch so a previous account's open thread doesn't linger on screen

// Surface any renderer-side error somewhere visible instead of failing
// silently (a blank screen). On the login step there is no console footer
// yet, so use the message line there.
function reportUiError(msg) {
  msg = String(msg || 'unknown error');
  const loginVisible = $('login') && !$('login').hidden;
  if (loginVisible && $('login-msg')) {
    $('login-msg').className = 'msg';
    $('login-msg').textContent = 'ui error: ' + msg;
  }
  try { logLine(`<span class="r">ui error: ${esc(msg)}</span>`); } catch {}
}
window.addEventListener('error', (e) => reportUiError(e.message || (e.error && e.error.message)));
window.addEventListener('unhandledrejection', (e) => reportUiError('promise: ' + (e.reason && e.reason.message ? e.reason.message : e.reason)));

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

// ---------- new conversation / group (one tokenised "to:" field) ----------
const norm = (s) => String(s || '').trim().replace(/^@/, '').replace(/@.*$/, '').toLowerCase();
let recips = []; // [{ username, exists: null | true | false }]
let people = []; // autocomplete source, refreshed lazily
let acIndex = -1;

async function refreshPeople() {
  const r = await window.pqmsg.peopleSuggestions();
  if (r.ok) people = r.data || [];
}
refreshPeople();

function renderChips() {
  const box = $('recip-chips');
  box.innerHTML = recips
    .map((r, i) => {
      const cls = r.exists === true ? 'ok' : r.exists === false ? 'bad' : 'pending';
      return `<span class="rchip ${cls}" data-i="${i}">@${esc(r.username)}<button type="button" class="rx" data-i="${i}">✕</button></span>`;
    })
    .join('');
  for (const b of box.querySelectorAll('.rx')) b.onclick = () => { recips.splice(+b.dataset.i, 1); renderChips(); $('in-to').focus(); };
  $('in-to').placeholder =
    recips.length === 0
      ? 'username — enter to start, add more for a group'
      : recips.length === 1
      ? 'enter to start · or type another name for a group'
      : 'enter to start the group · or add more';
}

async function commitToken(raw) {
  const u = norm(raw);
  $('in-to').value = '';
  hideAC();
  if (!u) return;
  if (u === norm(state && state.username)) { flashMsg('that is you'); return; }
  if (recips.some((r) => r.username === u)) return;
  const entry = { username: u, exists: null };
  recips.push(entry);
  renderChips();
  const r = await window.pqmsg.userExists(u);
  entry.exists = !!(r.ok && r.data);
  renderChips();
}

function flashMsg(t, ok) {
  const m = $('newconv-msg');
  m.className = 'msg' + (ok ? ' ok' : '');
  m.textContent = t;
}

$('in-to').addEventListener('keydown', async (e) => {
  const drop = $('ac-drop');
  if (!drop.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const n = drop.children.length;
    acIndex = (acIndex + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    paintACSel();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    // first enter finishes the name (turns it into a chip); a second enter,
    // with the field empty, starts the conversation / group.
    if (!drop.hidden && acIndex >= 0) { commitToken(drop.children[acIndex].dataset.u); return; }
    if ($('in-to').value.trim()) { commitToken($('in-to').value); return; }
    if (recips.length) startFromRecips();
    return;
  }
  if ((e.key === ' ' || e.key === ',') && $('in-to').value.trim()) {
    e.preventDefault();
    commitToken($('in-to').value);
  }
  if (e.key === 'Backspace' && !$('in-to').value && recips.length) {
    recips.pop();
    renderChips();
  }
  if (e.key === 'Escape') hideAC();
});
$('in-to').addEventListener('input', () => showAC($('in-to').value));
$('in-to').addEventListener('blur', () => setTimeout(hideAC, 120));

function showAC(q) {
  const query = norm(q);
  const taken = new Set(recips.map((r) => r.username));
  const matches = people
    .filter((p) => !taken.has(p.username) && (!query || p.username.includes(query)))
    .slice(0, 8);
  const drop = $('ac-drop');
  if (!matches.length) return hideAC();
  drop.innerHTML = matches
    .map((p, i) => {
      const when = p.lastChatAt ? timeAgo(p.lastChatAt) : 'no chats yet';
      return `<div class="ac-row" data-u="${esc(p.username)}" data-i="${i}">@${esc(p.username)}<span class="ac-when">${esc(when)}</span></div>`;
    })
    .join('');
  acIndex = -1;
  for (const row of drop.querySelectorAll('.ac-row')) {
    row.onmousedown = (e) => { e.preventDefault(); commitToken(row.dataset.u); };
  }
  drop.hidden = false;
}
function paintACSel() {
  [...$('ac-drop').children].forEach((c, i) => c.classList.toggle('sel', i === acIndex));
}
function hideAC() { $('ac-drop').hidden = true; acIndex = -1; }
function timeAgo(t) {
  const s = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

async function startFromRecips() {
  const valid = recips.filter((r) => r.exists !== false);
  const missing = recips.filter((r) => r.exists === false).map((r) => '@' + r.username);
  if (missing.length) { flashMsg(`no account: ${missing.join(', ')}`); return; }
  if (!valid.length) { flashMsg('add someone to message'); return; }
  flashMsg('looking up…');
  let r;
  if (valid.length === 1) {
    r = await window.pqmsg.startConversation(valid[0].username);
  } else {
    const members = valid.map((v) => v.username);
    r = await window.pqmsg.startGroup(members.join(', '), members);
  }
  if (!r.ok) { flashMsg(r.error); return; }
  recips = [];
  renderChips();
  flashMsg('');
  activeConv = r.data;
  await refreshPeople();
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
$('btn-delete-account').onclick = async () => {
  const u = state && state.username;
  const typed = prompt(
    `This permanently deletes @${u} and all its data from the server, and wipes it from this ` +
    `device. It cannot be undone.\n\nType the username "${u}" to confirm:`
  );
  if (typed == null) return;
  if (typed.trim().toLowerCase() !== String(u).toLowerCase()) { alert('name did not match — nothing deleted'); return; }
  const r = await window.pqmsg.deleteAccount();
  $('settings').hidden = true;
  if (!r.ok) alert('delete failed: ' + r.error);
};
$('si').addEventListener('input', (e) => {
  $('si-val').textContent = e.target.value;
});
$('si').addEventListener('change', (e) => window.pqmsg.setSyncInterval(parseInt(e.target.value, 10)));
$('set-receipts').addEventListener('change', (e) => window.pqmsg.setReadReceipts(e.target.checked));

function fillSettings() {
  if (!state) return;
  $('si').value = state.syncIntervalMs;
  $('si-val').textContent = state.syncIntervalMs;
  $('set-receipts').checked = state.readReceipts !== false;
  $('set-server').textContent = state.serverUrl;
  $('set-user').textContent = state.username || '—';
  $('set-device').textContent = state.deviceId || '—';
  $('set-safety').textContent = state.safetyNumber || '—';
  $('set-dir').textContent = state.dir || '—';
}

// ---------- composer ----------
let replyTarget = null; // { msgId, who, textPreview } — set by reply gesture / menu
let editTarget = null; // { msgId } — set by the edit menu item

function setReplyTarget(t) {
  replyTarget = t;
  editTarget = null;
  paintComposerChrome();
  $('in-msg').focus();
}
function setEditTarget(m) {
  editTarget = { msgId: m.msgId };
  replyTarget = null;
  $('in-msg').value = m.text || '';
  autoGrowComposer();
  paintComposerChrome();
  $('in-msg').focus();
  $('in-msg').select();
}
function clearComposerTargets() {
  replyTarget = null;
  editTarget = null;
  paintComposerChrome();
}
// grow the composer with the text so you can read the whole message as you type
function autoGrowComposer() {
  const t = $('in-msg');
  t.style.height = 'auto';
  t.style.height = Math.min(t.scrollHeight, 168) + 'px';
}
function resetComposer() {
  $('in-msg').value = '';
  autoGrowComposer();
}
function paintComposerChrome() {
  const strip = $('composer-chrome');
  if (editTarget) {
    strip.hidden = false;
    strip.innerHTML = `<span class="cc-label">editing message</span>
      <button type="button" class="cc-x" id="cc-cancel">✕</button>`;
  } else if (replyTarget) {
    strip.hidden = false;
    strip.innerHTML = `<span class="cc-label">replying to ${esc(replyTarget.who)}</span>
      <span class="cc-quote">${esc((replyTarget.textPreview || '').slice(0, 90))}</span>
      <button type="button" class="cc-x" id="cc-cancel">✕</button>`;
  } else {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  $('cc-cancel').onclick = () => {
    if (editTarget) $('in-msg').value = '';
    clearComposerTargets();
  };
}

$('composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  const inp = $('in-msg');
  const text = inp.value;
  if (!text.trim() || !activeConv) return;
  resetComposer();
  let r;
  if (editTarget) {
    const id = editTarget.msgId;
    clearComposerTargets();
    r = await window.pqmsg.editMessage(activeConv, id, text);
  } else if (replyTarget) {
    const rt = replyTarget.msgId;
    clearComposerTargets();
    r = await window.pqmsg.sendMessage(activeConv, text, { replyTo: rt });
  } else {
    r = await window.pqmsg.sendMessage(activeConv, text);
  }
  if (!r.ok) {
    logLine(`<span class="r">send error: ${esc(r.error)}</span>`);
    inp.value = text;
    autoGrowComposer();
  }
});
$('in-msg').addEventListener('input', autoGrowComposer);
$('in-msg').addEventListener('keydown', (e) => {
  // enter sends; shift+enter (or alt/ctrl+enter) inserts a newline
  if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    $('composer').requestSubmit ? $('composer').requestSubmit() : $('composer').dispatchEvent(new Event('submit', { cancelable: true }));
    return;
  }
  if (e.key === 'Escape') {
    if (editTarget) resetComposer();
    clearComposerTargets();
  }
});

// ---------- attachments ----------
$('btn-attach').onclick = async () => {
  if (!activeConv) return;
  const pick = await window.pqmsg.pickFile();
  if (!pick.ok) { logLine(`<span class="r">attach: ${esc(pick.error)}</span>`); return; }
  if (!pick.data) return; // user cancelled
  const caption = $('in-msg').value.trim();
  const replyTo = replyTarget ? replyTarget.msgId : undefined;
  resetComposer();
  clearComposerTargets();
  const r = await window.pqmsg.sendAttachment(activeConv, pick.data, { caption, replyTo });
  if (!r.ok) logLine(`<span class="r">send error: ${esc(r.error)}</span>`);
};

// ---------- message context menu + emoji picker ----------
function closeMenus() {
  document.querySelectorAll('.ctx-menu, .emoji-pop').forEach((n) => n.remove());
}
document.addEventListener('click', closeMenus);
document.addEventListener('scroll', closeMenus, true);

function openMessageMenu(m, x, y) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const items = [];
  if (m.mine && m.display === 'failed') {
    items.push({ label: 'Retry send', fn: () => retrySend(m.msgId) });
  }
  items.push({ label: 'Reply', fn: () => setReplyTarget({ msgId: m.msgId, who: m.mine ? 'You' : m.sender, textPreview: m.text || (m.attachment ? m.attachment.name : '') }) });
  items.push({ label: 'React', fn: () => openEmojiPicker(m, x, y) });
  if (m.canEdit) items.push({ label: 'Edit', fn: () => setEditTarget(m) });
  if (m.text) items.push({ label: 'Copy text', fn: () => navigator.clipboard && navigator.clipboard.writeText(m.text) });
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    b.onclick = (ev) => { ev.stopPropagation(); closeMenus(); it.fn(); };
    menu.appendChild(b);
  }
  positionPop(menu, x, y);
}

const QUICK_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '🔥'];
function openEmojiPicker(m, x, y) {
  closeMenus();
  const pop = document.createElement('div');
  pop.className = 'emoji-pop';
  const row = document.createElement('div');
  row.className = 'ep-row';
  for (const e of QUICK_EMOJI) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = e;
    b.onclick = (ev) => { ev.stopPropagation(); closeMenus(); window.pqmsg.reactToMessage(activeConv, m.msgId, e); };
    row.appendChild(b);
  }
  const inp = document.createElement('input');
  inp.placeholder = 'any emoji + enter';
  inp.maxLength = 8;
  inp.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter' && inp.value.trim()) { closeMenus(); window.pqmsg.reactToMessage(activeConv, m.msgId, inp.value.trim()); }
  };
  pop.appendChild(row);
  pop.appendChild(inp);
  positionPop(pop, x, y);
  inp.focus();
}
function positionPop(el, x, y) {
  el.style.position = 'fixed';
  el.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  el.style.top = Math.min(y, window.innerHeight - 180) + 'px';
  el.onclick = (e) => e.stopPropagation();
  document.body.appendChild(el);
}

// ---------- conversation (⋯) menu ----------
function openThreadMenu(conv, x, y) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  const items = [];
  if (conv.kind === 'dm' && conv.peerUsername) {
    if (conv.iBlockPeer) {
      items.push({ label: 'Unblock @' + conv.peerUsername, fn: () => window.pqmsg.unblockPeer(conv.convId) });
    } else {
      items.push({ label: 'Block @' + conv.peerUsername, danger: true, fn: () => window.pqmsg.blockPeer(conv.convId) });
    }
  }
  items.push({
    label: 'Delete chat',
    danger: true,
    fn: () => {
      if (confirm('Delete this chat on your side? The other person keeps their copy. If they message you again it will come back as a new request.')) {
        window.pqmsg.deleteConversation(conv.convId);
        activeConv = null;
        lastRenderKey = '';
        $('thread-head').innerHTML = '';
        $('messages').innerHTML = '';
        $('composer').hidden = true;
      }
    },
  });
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = it.label;
    if (it.danger) b.className = 'danger';
    b.onclick = (ev) => { ev.stopPropagation(); closeMenus(); it.fn(); };
    menu.appendChild(b);
  }
  positionPop(menu, x - 140, y);
}

// ---------- render ----------
window.pqmsg.onUpdate((s) => {
  state = s;
  render();
});
window.pqmsg.onEvent((ev) => logLine(fmtEvent(ev)));

// ---------- notifications ----------
window.pqmsg.onOpenConversation((id) => { if (id) selectConv(id); });
window.pqmsg.onToast((t) => showToast(t));
window.addEventListener('focus', () => window.pqmsg.setActiveView(activeConv, true));
window.addEventListener('blur', () => window.pqmsg.setActiveView(activeConv, false));

function showToast({ convId, title, body }) {
  const wrap = $('toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<div class="t-title">${esc(title || 'New message')}</div><div class="t-body">${esc((body || '').slice(0, 120))}</div>`;
  el.onclick = () => { if (convId) selectConv(convId); el.remove(); };
  wrap.appendChild(el);
  requestAnimationFrame(() => el.classList.add('in'));
  const kill = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 260); };
  setTimeout(kill, 5000);
  // cap the stack
  while (wrap.children.length > 4) wrap.firstChild.remove();
}

function render() {
  if (!state) return;
  renderUpdate(state);
  // A login/logout/switch-account changes which account's data is in view —
  // without this, the previously open thread's DOM would keep showing (a
  // stale render, not an actual leak: the new account's own store never
  // held that data) until something else happened to redraw it.
  if (state.username !== lastUser) {
    lastUser = state.username;
    activeConv = null;
    lastRenderKey = '';
    $('thread-head').innerHTML = '';
    $('messages').innerHTML = '';
    $('composer').hidden = true;
  }
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
    div.className = 'conv' + (c.convId === activeConv ? ' active' : '') + (c.unread ? ' unread' : '');
    let tag = '';
    if (c.lastMine) {
      if (c.lastDisplay === 'delivered') tag = '<span class="tag">✓ delivered</span> ';
      else if (c.lastDisplay === 'failed') tag = '<span class="tag red">✗ not sent</span> ';
      else tag = '<span class="tag grey">· sending…</span> ';
    }
    const icon = c.kind === 'group' ? '👥 ' : '';
    const badge = c.unread ? `<span class="unread-badge">${c.unread > 99 ? '99+' : c.unread}</span>` : '';
    div.innerHTML = `<div class="name">${icon}${esc(c.title)}${badge}</div><div class="prev">${tag}${esc(c.lastText || '…')}</div>`;
    div.onclick = () => selectConv(c.convId);
    sb.appendChild(div);
  }

  if (activeConv) renderThread();
}

async function renderThread() {
  const r = await window.pqmsg.getConversation(activeConv);
  if (!r.ok || !r.data) {
    // convId no longer resolves for the account now in view (switched
    // accounts, or the conversation is simply gone) — clear it instead of
    // leaving whatever was drawn on screen before this call.
    activeConv = null;
    lastRenderKey = '';
    $('thread-head').innerHTML = '';
    $('messages').innerHTML = '';
    $('composer').hidden = true;
    return;
  }
  const conv = r.data;
  const others = conv.participants.filter((p) => p !== '@' + state.username);
  const recon = conv.lastReconciledAt ? Math.round((Date.now() - conv.lastReconciledAt) / 1000) + 's ago' : '—';
  const title = conv.kind === 'group' ? `👥 ${esc(conv.name || 'group')}` : esc(others.join(', ') || 'you');
  const membersLine = conv.kind === 'group' ? ` · ${esc(conv.participants.join(', '))}` : '';
  const homeLine = conv.homeIsMine ? '' : ` · hosted on ${esc((conv.homeServer || '').replace(/^https?:\/\//, ''))}`;
  $('thread-head').innerHTML =
    `<span class="th-main"><b>${title}</b>${membersLine} · ${conv.kind} · seq ${conv.cursorSeq} · reconciled ${recon}${homeLine}</span>` +
    `<button class="th-dots" id="th-dots" type="button" title="conversation options">⋯</button>`;
  $('th-dots').onclick = (e) => { e.stopPropagation(); openThreadMenu(conv, e.clientX, e.clientY); };
  $('composer').hidden = false;

  // blocked state: disable the composer with a clear notice
  const blocked = conv.blockedByPeer;
  $('composer').classList.toggle('blocked', !!blocked);
  $('in-msg').disabled = !!blocked;
  $('btn-attach').disabled = !!blocked;
  $('in-msg').placeholder = blocked
    ? `@${conv.peerUsername || 'this user'} has blocked you — you can’t reply`
    : 'type a message…';

  const key = conv.messages
    .map((m) => m.msgId + m.display + m.serverSeq + (m.text || '') + JSON.stringify(m.reactions || []))
    .join('|');
  const box = $('messages');
  const wasBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = '';
  for (const m of conv.messages) {
    if (m.system) {
      const s = document.createElement('div');
      s.className = 'sysline';
      s.textContent = `— ${m.text} —`;
      box.appendChild(s);
      continue;
    }
    const d = document.createElement('div');
    d.className = 'bubble ' + (m.mine ? 'out' : 'in') + (key !== lastRenderKey ? ' flash' : '');
    d.dataset.display = m.display;
    d.dataset.msgId = m.msgId;
    const when = new Date(m.sentAt).toLocaleTimeString();
    let status = '';
    const failed = m.mine && m.display === 'failed';
    if (m.mine) {
      status = m.seen
        ? ' · seen'
        : m.display === 'delivered'
        ? ' · delivered ✓'
        : failed
        ? ' · not sent ✗ ' + esc(m.error || '')
        : m.state === 'pending'
        ? ' · sending…'
        : ' · sent (awaiting delivery)';
    } else if (m.display === 'suspect') {
      status = ' · ⚠ unverified signature';
    } else if (m.display === 'received') {
      status = m.verified ? ' · ✓ sig ok' : '';
    }

    const quote = m.replyTo
      ? `<div class="quote" data-jump="${esc(m.replyTo.msgId)}"><span class="qh">${esc(m.replyTo.who)} said:</span>${esc(m.replyTo.textPreview || '')}</div>`
      : '';
    const att = renderAttachment(m.attachment);
    const bodyText = m.text ? `<div class="btext">${esc(m.text)}</div>` : '';
    const reax = renderReactions(m);
    const retryBtn = failed ? '<button type="button" class="retry-btn">retry</button>' : '';
    d.innerHTML =
      quote + att + bodyText +
      `<div class="meta">${m.mine ? 'you' : esc(m.sender)} · ${when} · #${m.serverSeq ?? '—'}${status}${retryBtn}</div>` +
      reax;
    if (failed) d.querySelector('.retry-btn').onclick = (e) => { e.stopPropagation(); retrySend(m.msgId); };

    // right-click / ctrl-click -> context menu
    d.addEventListener('contextmenu', (e) => { e.preventDefault(); openMessageMenu(m, e.clientX, e.clientY); });
    d.addEventListener('click', async (e) => {
      const jump = e.target.closest('.quote');
      if (jump && jump.dataset.jump) { scrollToMsg(jump.dataset.jump); return; }
      const chip = e.target.closest('.rechip');
      if (chip) { window.pqmsg.reactToMessage(activeConv, m.msgId, chip.dataset.emoji); return; }
      const save = e.target.closest('[data-save]');
      if (save && m.attachment && m.attachment.dataB64) {
        const r = await window.pqmsg.saveAttachment(m.attachment.name, m.attachment.dataB64);
        if (r.ok) logLine(`<span class="g">saved</span> ${esc(m.attachment.name)} → Downloads`);
        else logLine(`<span class="r">save failed: ${esc(r.error)}</span>`);
        return;
      }
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); openMessageMenu(m, e.clientX, e.clientY); }
    });
    attachSwipeToReply(d, m);
    box.appendChild(d);
  }
  lastRenderKey = key;
  if (wasBottom) box.scrollTop = box.scrollHeight;
}

function renderReactions(m) {
  if (!m.reactions || !m.reactions.length) return '';
  return (
    '<div class="reacts">' +
    m.reactions
      .map(
        (r) =>
          `<span class="rechip${r.mine ? ' mine' : ''}" data-emoji="${esc(r.emoji)}" title="${esc(r.who.join(', '))}">${esc(r.emoji)} ${r.count}</span>`
      )
      .join('') +
    '</div>'
  );
}
function renderAttachment(a) {
  if (!a) return '';
  const kb = a.size ? (a.size < 1024 ? a.size + ' B' : (a.size / 1024).toFixed(1) + ' KB') : '';
  if (a.isImage && a.dataUrl) {
    return `<img class="att-img" src="${a.dataUrl}" alt="${esc(a.name)}" data-save="${esc(a.name)}" />`;
  }
  return `<div class="att-file" data-save="${esc(a.name)}"><span class="af-i">📄</span><span class="af-n">${esc(a.name)}</span><span class="af-s">${kb} · click to save</span></div>`;
}
function scrollToMsg(msgId) {
  const el = $('messages').querySelector(`[data-msg-id="${CSS.escape(msgId)}"]`);
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 500);
  }
}

// Two-finger horizontal swipe of a bubble *toward the centre of the thread*
// arms a reply to it. The other person's (left-aligned) bubbles are pulled
// gently RIGHT; your own (right-aligned) bubbles are pulled LEFT. Trackpad
// swipes arrive as `wheel` events; on macOS natural scrolling, fingers-right
// is a negative deltaX and fingers-left a positive one.
const SWIPE_ARM = 54; // px of intent before it fires (deliberate, not a brush)
const SWIPE_MAX = 20; // largest visual tug
function attachSwipeToReply(el, m) {
  // grows only while swiping toward the centre for THIS bubble's side
  const dirFactor = m.mine ? 1 : -1;       // deltaX sign that counts as "inward"
  const tugSign = m.mine ? -1 : 1;         // screen-space direction of the tug
  let intent = 0;
  let armed = false;
  let endTimer = null;
  let dragging = false;

  const springBack = () => {
    endTimer = null;
    dragging = false;
    armed = false;
    intent = 0;
    el.style.transition = 'transform .2s ease-out, opacity .2s ease-out';
    el.style.transform = '';
    el.style.opacity = '';
    const clear = () => { el.style.transition = ''; el.removeEventListener('transitionend', clear); };
    el.addEventListener('transitionend', clear);
  };

  el.addEventListener(
    'wheel',
    (e) => {
      const horizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      // a clearly-vertical wheel: let it scroll, and bail out of any swipe
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX) * 2) {
        if (dragging) { clearTimeout(endTimer); springBack(); }
        return;
      }
      if (!dragging && !horizontal) return;
      e.preventDefault(); // don't also pan / rubber-band the thread

      if (!dragging) {
        dragging = true;
        el.style.transition = 'none'; // follow the finger 1:1, no chase/jiggle
      }
      intent += e.deltaX * dirFactor;
      if (intent < 0) intent = 0;

      const shown = Math.min(SWIPE_MAX, intent * 0.6); // a little resistance
      el.style.transform = shown ? `translateX(${tugSign * shown}px)` : '';
      el.style.opacity = shown ? String(1 - (shown / SWIPE_MAX) * 0.12) : '';

      if (!armed && intent >= SWIPE_ARM) {
        armed = true;
        setReplyTarget({
          msgId: m.msgId,
          who: m.mine ? 'You' : m.sender,
          textPreview: m.text || (m.attachment ? '📎 ' + m.attachment.name : ''),
        });
      }
      clearTimeout(endTimer);
      endTimer = setTimeout(springBack, 90); // gesture ended -> ease home
    },
    { passive: false }
  );
  el.addEventListener('mouseleave', () => { if (dragging) { clearTimeout(endTimer); springBack(); } });
}

async function retrySend(msgId) {
  if (!activeConv) return;
  const r = await window.pqmsg.retryMessage(activeConv, msgId);
  if (!r.ok) logLine(`<span class="r">retry failed: ${esc(r.error)}</span>`);
}

function selectConv(id) {
  activeConv = id;
  lastRenderKey = '';
  window.pqmsg.setActiveView(id, document.hasFocus());
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
