'use strict';
const REPO = 'jacknero2/pqmsg';
const RELEASES = `https://github.com/${REPO}/releases`;

const $ = (s) => document.querySelector(s);
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

function detectOS() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  const ua = navigator.userAgent;
  if (/mac/i.test(p) || /Mac OS X/.test(ua)) return 'mac';
  if (/win/i.test(p) || /Windows/.test(ua)) return 'win';
  if (/linux/i.test(p) || /Linux/.test(ua)) return 'linux';
  return '';
}

function classify(name) {
  const n = name.toLowerCase();
  const isServer = /server/.test(n);
  let os, label;
  if (n.endsWith('.dmg')) {
    os = 'mac';
    label = /arm64/.test(n) ? 'macOS · Apple Silicon' : 'macOS · Intel';
  } else if (n.endsWith('.exe')) {
    os = 'win';
    label = 'Windows';
  } else if (n.endsWith('.appimage')) {
    os = 'linux';
    label = 'Linux · AppImage';
  } else if (n.endsWith('.deb')) {
    os = 'linux';
    label = 'Linux · .deb';
  } else {
    return null;
  }
  return { isServer, os, label };
}

const ORDER = ['macOS · Apple Silicon', 'macOS · Intel', 'Windows', 'Linux · AppImage', 'Linux · .deb'];

function renderGroup(el, assets, myOS) {
  if (!assets.length) {
    el.innerHTML = `<a class="btn" href="${RELEASES}">see all downloads →</a>`;
    return;
  }
  assets.sort((a, b) => ORDER.indexOf(a.meta.label) - ORDER.indexOf(b.meta.label));
  el.innerHTML = assets
    .map((a) => {
      const primary = a.meta.os === myOS && !a.meta.label.includes('Intel') && !a.meta.label.includes('.deb');
      return `<a class="btn ${primary ? 'primary' : ''}" href="${a.browser_download_url}">
        <span>${a.meta.label}</span><span class="sz">${mb(a.size)}</span></a>`;
    })
    .join('');
}

(async () => {
  $('#repo-link').href = RELEASES;
  const myOS = detectOS();
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!r.ok) throw new Error(String(r.status));
    const rel = await r.json();
    $('#version-line').textContent = rel.tag_name || '';

    const client = [];
    const server = [];
    for (const a of rel.assets || []) {
      const meta = classify(a.name);
      if (!meta) continue;
      a.meta = meta;
      (meta.isServer ? server : client).push(a);
    }
    renderGroup($('#client-buttons'), client, myOS);
    renderGroup($('#server-buttons'), server, myOS);

    const hint = { mac: 'Detected macOS — pick Apple Silicon for M1–M4 Macs, Intel for older ones.', win: 'Detected Windows.', linux: 'Detected Linux.' }[myOS];
    if (hint) $('#client-os-hint').textContent = hint;
  } catch (e) {
    const msg =
      e.message === '404'
        ? `No release published yet. <a href="${RELEASES}">Releases page →</a>`
        : `Could not load releases (${e.message}). <a href="${RELEASES}">Releases page →</a>`;
    $('#client-buttons').innerHTML = msg;
    $('#server-buttons').innerHTML = `<a class="btn" href="${RELEASES}">Releases page →</a>`;
  }
})();
