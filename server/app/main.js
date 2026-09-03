'use strict';
/*
 * pqmsg Server — desktop control panel.
 *
 * Runs the pqmsg server in-process and (optionally) a Cloudflare tunnel so
 * clients anywhere can connect to the address shown in the window. This app is
 * for the operator only; it is a separate build from the client.
 */
const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const { startServer } = require('../src/index.js');
const { Tunnel } = require('./tunnel');

const PORT = parseInt(process.env.PQMSG_PORT || '8787', 10);
let win = null;
let server = null; // result of startServer()
const tunnel = new Tunnel();

const dataDir = () => process.env.PQMSG_DATA_DIR || path.join(app.getPath('userData'), 'server-data');

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

function snapshot() {
  return {
    running: !!server,
    port: PORT,
    dataDir: dataDir(),
    adminToken: server ? server.adminToken : null,
    backend: server ? server.backend : null,
    localUrls: server ? lanAddresses().map((ip) => `http://${ip}:${PORT}`) : [],
    loopbackUrl: `http://localhost:${PORT}`,
    dashboardUrl: server ? `http://localhost:${PORT}/?admin=${server.adminToken}` : null,
    tunnel: tunnel.snapshot(),
    peers: server ? server.presence.list() : [],
    events: server ? server.presence.eventsSince(0).slice(-80) : [],
  };
}
function pushState() {
  if (win && !win.isDestroyed()) win.webContents.send('state', snapshot());
}

async function startBackend() {
  if (server) return;
  try {
    server = await startServer({
      port: PORT,
      host: '0.0.0.0',
      dataDir: dataDir(),
      public: true, // a self-hosted, internet-exposed server: always require the admin token
      quiet: true,
    });
    server.presence.onBroadcast(() => pushState());
    console.log(`[pqmsg-server] listening on :${PORT}  data=${dataDir()}`);
    pushState();
  } catch (e) {
    console.error('[pqmsg-server] failed to start:', e);
    if (win && !win.isDestroyed()) win.webContents.send('fatal', e.message || String(e));
    throw e;
  }
}
async function stopBackend() {
  tunnel.stop();
  if (server) {
    await server.close();
    server = null;
  }
  pushState();
}

function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 780,
    resizable: true,
    backgroundColor: '#0b0f14',
    title: 'pqmsg Server',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'panel.html'));
  win.webContents.on('did-finish-load', pushState);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    tunnel.on('update', pushState);
    tunnel.on('log', () => pushState());
    createWindow();
    await startBackend().catch((e) => {
      if (win) win.webContents.send('fatal', e.message);
    });

    ipcMain.handle('get-state', () => snapshot());
    ipcMain.handle('start', () => startBackend().then(snapshot));
    ipcMain.handle('stop', () => stopBackend().then(snapshot));
    ipcMain.handle('tunnel-start', () => {
      tunnel.start(PORT);
      return snapshot();
    });
    ipcMain.handle('tunnel-stop', () => {
      tunnel.stop();
      return snapshot();
    });
    ipcMain.handle('open-dashboard', () => {
      if (server) shell.openExternal(`http://localhost:${PORT}/?admin=${server.adminToken}`);
    });
    ipcMain.handle('open-data', () => shell.openPath(dataDir()));
    ipcMain.handle('copy', (_e, text) => clipboard.writeText(String(text || '')));

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', async (e) => {
    if (server || tunnel.proc) {
      e.preventDefault();
      await stopBackend();
      app.exit(0);
    }
  });
  app.on('window-all-closed', () => app.quit());
}
