'use strict';
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const ADMIN = params.get('admin') || '';
const H = ADMIN ? { 'X-Admin-Token': ADMIN } : {};
let timer = null;
let intervalMs = 2000;
let selectedConv = null;
let evSeq = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (t) => (t ? Math.round((Date.now() - t) / 1000) + 's' : '—');
const api = async (p) => {
  const r = await fetch(p, { headers: H });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
};

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
    $('stat').innerHTML = `<span style="color:var(--lred)">dashboard error: ${esc(e.message)} — append ?admin=TOKEN</span>`;
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
timer = setInterval(tick, intervalMs);
connectWs();
tick();
