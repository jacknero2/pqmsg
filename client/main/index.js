'use strict';
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { Engine } = require('./engine');

const PROFILE = process.env.PQMSG_PROFILE || 'default';
let win;
let engine;

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
  engine = new Engine(PROFILE);
  await engine.resume();
  createWindow();

  const H = (channel, fn) =>
    ipcMain.handle(channel, async (_e, arg) => {
      try {
        return { ok: true, data: await fn(arg) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });

  H('pqmsg:snapshot', () => engine.snapshot());
  H('pqmsg:register', (a) => engine.register(a));
  H('pqmsg:login', (a) => engine.login(a));
  H('pqmsg:logout', () => engine.logout());
  H('pqmsg:startConversation', (a) => engine.startConversation(a.username));
  H('pqmsg:sendMessage', (a) => engine.sendMessage(a.convId, a.text));
  H('pqmsg:getConversation', (a) => engine.getConversationView(a.convId));
  H('pqmsg:syncNow', () => engine.syncOnce('manual'));
  H('pqmsg:setSyncInterval', (a) => engine.setSyncInterval(a.ms));
  H('pqmsg:contact', (a) => engine.refreshContact(a.username, true));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
