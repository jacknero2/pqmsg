'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (t) => (t ? Math.round((Date.now() - t) / 1000) + 's' : '—');
let S = null;

$('btn-start').onclick = () => window.srv.start();
$('btn-stop').onclick = () => window.srv.stop();
$('btn-dash').onclick = () => window.srv.openDashboard();
$('btn-data').onclick = () => window.srv.openData();
$('admin-copy').onclick = () => S && window.srv.copy(S.adminToken);
$('pub-copy').onclick = () => S && S.tunnel.url && window.srv.copy(S.tunnel.url);
$('lan-copy').onclick = () => S && S.localUrls[0] && window.srv.copy(S.localUrls[0]);
$('tunnel-toggle').onclick = () => {
  if (!S) return;
  if (S.tunnel.state === 'on' || S.tunnel.state === 'starting') window.srv.tunnelStop();
  else window.srv.tunnelStart();
};

window.srv.onFatal((m) => {
  $('fatal').hidden = false;
  $('fatal').textContent = 'server error: ' + m;
});
window.srv.onState(render);
window.srv.getState().then(render);
setInterval(() => S && render(S), 1000); // refresh "Ns ago"

function render(state) {
  S = state;
  const running = state.running;
  $('dot').className = 'dot' + (running ? ' on' : '');
  $('state-label').textContent = running ? `running · :${state.port}` : 'stopped';

  // addresses
  const t = state.tunnel;
  const pub = $('pub-url');
  if (t.state === 'on' && t.url) pub.textContent = t.url;
  else if (t.state === 'starting') pub.textContent = 'starting tunnel…';
  else if (t.state === 'error') pub.textContent = '— tunnel error —';
  else pub.textContent = '— tunnel off —';
  $('pub-copy').hidden = !(t.state === 'on' && t.url);

  const tog = $('tunnel-toggle');
  tog.textContent = t.state === 'on' || t.state === 'starting' ? 'turn off internet tunnel' : 'make reachable from the internet';
  tog.disabled = !running;
  const note = $('tunnel-note');
  note.className = 'note' + (t.state === 'error' ? ' err' : t.state === 'on' ? ' ok' : '');
  note.textContent =
    t.state === 'error'
      ? t.error || 'tunnel failed'
      : t.state === 'on'
      ? 'live — anyone can connect with this address'
      : t.state === 'starting'
      ? 'contacting Cloudflare…'
      : running
      ? 'free Cloudflare tunnel · no router setup · URL changes each restart'
      : 'start the server first';

  $('lan-url').textContent = state.localUrls[0] || '—';
  $('lan-copy').hidden = !state.localUrls.length;

  $('k-port').textContent = `0.0.0.0:${state.port}`;
  $('k-backend').textContent = state.backend || '—';
  $('k-admin').textContent = state.adminToken || '—';
  $('k-data').textContent = state.dataDir;

  $('btn-start').disabled = running;
  $('btn-stop').disabled = !running;
  $('btn-dash').disabled = !running;

  // peers
  $('peer-count').textContent = state.peers.length;
  $('peers').innerHTML =
    state.peers
      .map(
        (p) => `<div class="peer">
      <div class="a">● <b>@${esc(p.username)}</b> · ${esc(p.deviceName || 'device')}</div>
      <div class="b">${esc((p.deviceId || '').slice(0, 18))}… · ${esc(p.ip || '?')} · up ${ago(p.connectedAt)} · seen ${ago(p.lastSeen)}</div>
    </div>`
      )
      .join('') || '<div class="empty">no clients connected</div>';

  // events
  $('events').innerHTML =
    (state.events || [])
      .slice()
      .reverse()
      .map((e) => {
        const cls = e.type === 'delivered' ? 'g' : /error|fail|disconnect/.test(e.type) ? 'r' : 't';
        const extra = Object.entries(e)
          .filter(([k]) => !['seq', 'at', 'type'].includes(k))
          .map(([k, v]) => `${k}=${esc(v)}`)
          .join(' ');
        return `<div class="ev"><span class="t">${new Date(e.at).toLocaleTimeString()}</span> <span class="${cls}">${esc(e.type)}</span> ${extra}</div>`;
      })
      .join('') || '<div class="empty">—</div>';
}
