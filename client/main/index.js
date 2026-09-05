'use strict';
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { Engine } = require('./engine');

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif']);
const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.zip': 'application/zip', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.csv': 'text/csv',
};
/** Pick a file, read it, hand the renderer a base64 blob for encryption. */
async function pickFileForSend() {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], title: 'attach a file' });
  if (r.canceled || !r.filePaths[0]) return null;
  const p = r.filePaths[0];
  const stat = fs.statSync(p);
  if (stat.size > Engine.MAX_ATTACHMENT) {
    throw new Error(`file too large — ${(stat.size / 1048576).toFixed(1)} MB, limit is ${Engine.MAX_ATTACHMENT / 1048576} MB`);
  }
  const ext = path.extname(p).toLowerCase();
  return {
    name: path.basename(p),
    mime: MIME[ext] || 'application/octet-stream',
    size: stat.size,
    isImage: IMAGE_EXT.has(ext),
    dataB64: fs.readFileSync(p).toString('base64'),
  };
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
    backgroundColor: '#0b0f14',
    title: `pqmsg — ${PROFILE}`,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  let pending = null;
  const push = () => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      if (win && !win.isDestroyed()) win.webContents.send('pqmsg:update', engine.snapshot());
    }, 120);
  };
  engine.on('update', push);
  engine.on('engine-event', (e) => {
    if (win && !win.isDestroyed()) win.webContents.send('pqmsg:event', e);
  });
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
  H('pqmsg:addGroupMember', (a) => engine.addGroupMember(a.convId, a.handle));
  H('pqmsg:removeGroupMember', (a) => engine.removeGroupMember(a.convId, a.handle));
  H('pqmsg:acceptConversation', (a) => engine.acceptConversation(a.convId));
  H('pqmsg:declineConversation', (a) => engine.declineConversation(a.convId));
  H('pqmsg:sendMessage', (a) => engine.sendMessage(a.convId, a.text, a.opts || {}));
  H('pqmsg:editMessage', (a) => engine.editMessage(a.convId, a.msgId, a.text));
  H('pqmsg:reactToMessage', (a) => engine.reactToMessage(a.convId, a.msgId, a.emoji));
  H('pqmsg:pickFile', () => pickFileForSend());
  H('pqmsg:sendAttachment', (a) => engine.sendAttachment(a.convId, a.file, a.opts || {}));
  H('pqmsg:saveAttachment', (a) => saveToDownloads(a));
  H('pqmsg:getConversation', (a) => engine.getConversationView(a.convId));
  H('pqmsg:syncNow', () => engine.syncOnce('manual'));
  H('pqmsg:setSyncInterval', (a) => engine.setSyncInterval(a.ms));
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
