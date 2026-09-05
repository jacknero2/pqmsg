'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, nativeImage, Notification } = require('electron');
const { Engine } = require('./engine');

// Some Windows GPU drivers black-screen an Electron window on the first
// non-trivial repaint — typing into a field on the login screen is a common
// trigger. A text app does not need the GPU compositor, so turn it off there
// (must happen before app is ready). Force it back on with PQMSG_GPU=1.
if (process.platform === 'win32' && process.env.PQMSG_GPU !== '1') {
  app.disableHardwareAcceleration();
}
// Also skip the on-disk GPU shader cache, which is another Windows
// black-screen / corruption source and buys nothing here.
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');

// which conversation the renderer is showing + whether our window is focused
let activeView = { convId: null, focused: true };

/** A fresh inbound message — notify unless the user is already looking at it. */
function onInboundMessage(e) {
  const focused = win && !win.isDestroyed() && win.isFocused();
  const viewing = focused && activeView.convId === e.convId;
  if (viewing) return;
  const title = e.isGroup ? `${e.groupName || 'group'} · ${e.from}` : e.from;
  const body = e.preview || 'New message';
  if (focused) {
    // window is up but on another conversation — in-app toast, app-styled
    win.webContents.send('pqmsg:toast', { convId: e.convId, title, body });
    return;
  }
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send('pqmsg:open-conversation', e.convId);
    }
  });
  n.show();
}

// Photos straight off a phone are multi-MB and there is no reason to send a
// chat attachment at full sensor resolution. Anything bigger than this, or
// wider/taller than MAX_EDGE, is re-encoded down before it goes on the wire.
const IMG_SHRINK_OVER = 900 * 1024;
const IMG_MAX_EDGE = 2048;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
};
/** Downscale + re-encode a large raster image so it fits comfortably on the wire. */
function shrinkImage(buf, ext) {
  if (ext === '.svg' || ext === '.gif') return null; // vector / animation — leave alone
  try {
    let img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const longEdge = Math.max(width, height);
    const needsResize = longEdge > IMG_MAX_EDGE;
    if (needsResize) {
      img = img.resize(width >= height ? { width: IMG_MAX_EDGE } : { height: IMG_MAX_EDGE });
    }
    const out = img.toJPEG(82);
    if (out && out.length && out.length < buf.length) {
      return { buf: out, mime: 'image/jpeg', ext: '.jpg' };
    }
  } catch {}
  return null;
}

/** Pick a file, read it, hand the renderer a base64 blob for encryption. */
async function pickFileForSend() {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'treatPackageAsDirectory'],
    title: 'attach a file',
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  let st;
  try { st = fs.statSync(p); } catch { throw new Error('could not read that file'); }
  if (st.isDirectory()) throw new Error('pick a file, not a folder');
  let ext = path.extname(p).toLowerCase();
  let buf = fs.readFileSync(p);
  let name = path.basename(p);
  let mime = MIME[ext] || 'application/octet-stream';
  const isImage = IMAGE_EXT.has(ext);

  if (isImage && buf.length > IMG_SHRINK_OVER) {
    const s = shrinkImage(buf, ext);
    if (s) {
      buf = s.buf;
      mime = s.mime;
      name = name.replace(/\.[^.]+$/, '') + s.ext;
    }
  }
  if (buf.length > Engine.MAX_ATTACHMENT) {
    throw new Error(`file too large — ${(buf.length / 1048576).toFixed(1)} MB, limit is ${Engine.MAX_ATTACHMENT / 1048576} MB`);
  }
  return { name, mime, size: buf.length, isImage, dataB64: buf.toString('base64') };
}
/** Save a received attachment straight into the OS Downloads folder. */
function saveToDownloads({ name, dataB64 }) {
  const dir = app.getPath('downloads');
  let target = path.join(dir, path.basename(name || 'file'));
  if (fs.existsSync(target)) {
    const ext = path.extname(target);
    const base = target.slice(0, -ext.length || undefined);
    let i = 1;
    while (fs.existsSync(`${base} (${i})${ext}`)) i++;
    target = `${base} (${i})${ext}`;
  }
  fs.writeFileSync(target, Buffer.from(dataB64, 'base64'));
  shell.showItemInFolder(target);
  return { path: target };
}

const PROFILE = process.env.PQMSG_PROFILE || 'default';
let win;
let engine;

// Surface crashes to the operator's server (if we're logged in enough to know
// one) instead of just vanishing off a friend's laptop with no trace. Doesn't
// change crash semantics — still exits after — just reports on the way out.
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
  if (engine) engine.reportDiagnostic('uncaughtException', err.message, { stack: err.stack });
  setTimeout(() => process.exit(1), 250);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error('[unhandledRejection]', err);
  if (engine) engine.reportDiagnostic('unhandledRejection', err.message, { stack: err.stack });
});

// one running client per machine, except in dev where PQMSG_PROFILE lets you
// run several (alice / bob) side by side
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 760,
    minWidth: 780,
    minHeight: 520,
    show: false, // reveal on ready-to-show so there is no blank/black flash
    backgroundColor: '#0b0f14',
    title: `pqmsg — ${PROFILE}`,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false, // avoids a Windows spellcheck-service crash path; not needed here
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // if the renderer process ever dies (GPU/compositor fault, OOM), reload it
  // instead of leaving a black window.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer gone]', details);
    if (engine) engine.reportDiagnostic('render-process-gone', details.reason || 'unknown', { exitCode: details.exitCode });
    if (win && !win.isDestroyed()) win.webContents.reload();
  });
  win.webContents.on('unresponsive', () => console.error('[renderer unresponsive]'));

  let pending = null;
  const push = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      if (win && !win.isDestroyed()) {
        const snap = engine.snapshot();
        win.webContents.send('pqmsg:update', snap);
        // dock / taskbar badge — red pill with the unread count (macOS/Linux)
        if (typeof app.setBadgeCount === 'function') app.setBadgeCount(snap.unreadTotal || 0);
      }
    }, 120);
  };
  engine.on('update', push);
  engine.on('engine-event', (e) => {
    if (win && !win.isDestroyed()) win.webContents.send('pqmsg:event', e);
    if (e.kind === 'inbound-message') onInboundMessage(e);
  });

  win.on('focus', () => { activeView.focused = true; engine.setActiveView(activeView); });
  win.on('blur', () => { activeView.focused = false; engine.setActiveView(activeView); });
}

app.whenReady().then(async () => {
  engine = new Engine(PROFILE, app.getPath('userData'), app.getVersion());
  await engine.resume();
  createWindow();

  const H = (channel, fn) =>
    ipcMain.handle(channel, async (_e, arg) => {
      try {
        return { ok: true, data: await fn(arg) };
      } catch (err) {
        return { ok: false, error: err.message, code: err.code, candidates: err.candidates };
      }
    });

  H('pqmsg:snapshot', () => engine.snapshot());
  H('pqmsg:register', (a) => engine.register(a));
  H('pqmsg:login', (a) => engine.login(a));
  H('pqmsg:completeLogin', (a) => engine.completeLogin(a));
  H('pqmsg:logout', () => engine.logout());
  H('pqmsg:switchAccount', () => engine.switchAccount());
  H('pqmsg:startConversation', (a) => engine.startConversation(a.username));
  H('pqmsg:startGroup', (a) => engine.startGroup(a));
  H('pqmsg:userExists', (a) => engine.userExists(a.username));
  H('pqmsg:peopleSuggestions', () => engine.peopleSuggestions());
  H('pqmsg:addGroupMember', (a) => engine.addGroupMember(a.convId, a.handle));
  H('pqmsg:removeGroupMember', (a) => engine.removeGroupMember(a.convId, a.handle));
  H('pqmsg:acceptConversation', (a) => engine.acceptConversation(a.convId));
  H('pqmsg:declineConversation', (a) => engine.declineConversation(a.convId));
  H('pqmsg:deleteConversation', (a) => engine.deleteConversation(a.convId));
  H('pqmsg:blockPeer', (a) => engine.blockPeer(a.convId));
  H('pqmsg:unblockPeer', (a) => engine.unblockPeer(a.convId));
  H('pqmsg:deleteAccount', () => engine.deleteAccount());
  H('pqmsg:sendMessage', (a) => engine.sendMessage(a.convId, a.text, a.opts || {}));
  H('pqmsg:editMessage', (a) => engine.editMessage(a.convId, a.msgId, a.text));
  H('pqmsg:reactToMessage', (a) => engine.reactToMessage(a.convId, a.msgId, a.emoji));
  H('pqmsg:retryMessage', (a) => engine.retryMessage(a.convId, a.msgId));
  H('pqmsg:pickFile', () => pickFileForSend());
  H('pqmsg:sendAttachment', (a) => engine.sendAttachment(a.convId, a.file, a.opts || {}));
  H('pqmsg:saveAttachment', (a) => saveToDownloads(a));
  H('pqmsg:getConversation', (a) => engine.getConversationView(a.convId));
  H('pqmsg:syncNow', () => engine.syncOnce('manual'));
  H('pqmsg:setSyncInterval', (a) => engine.setSyncInterval(a.ms));
  H('pqmsg:setActiveView', (a) => {
    activeView = { convId: a.convId || null, focused: a.focused !== false };
    engine.setActiveView(activeView);
  });
  H('pqmsg:markRead', (a) => engine.markConversationRead(a.convId));
  H('pqmsg:setReadReceipts', (a) => engine.setReadReceipts(a.on));
  H('pqmsg:contact', (a) => engine.refreshContact(a.username, true));
  H('pqmsg:openExternal', (a) => {
    if (/^https?:\/\//.test(a.url || '')) shell.openExternal(a.url);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
