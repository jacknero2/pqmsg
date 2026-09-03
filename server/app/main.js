'use strict';
/*
 * pqmsg Server — desktop control panel.
 *
 * Runs the pqmsg server in-process, manages a Cloudflare tunnel for a public
 * URL, and (optionally) announces the server to a registry so clients discover
 * it automatically. Operator-only; separate build from the client.
 */
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, clipboard } = require('electron');
const { startServer } = require('../src/index.js');
const { Tunnel } = require('./tunnel');

const PORT = parseInt(process.env.PQMSG_PORT || '8787', 10);
let win = null;
let server = null;
const tunnel = new Tunnel();

const dataDir = () => process.env.PQMSG_DATA_DIR || path.join(app.getPath('userData'), 'server-data');
const cfgPath = () => path.join(app.getPath('userData'), 'server-app-config.json');

const DEFAULT_CFG = { name: '', description: '', registryUrl: '', listPublicly: false, minClient: '', latestClient: '' };
let appCfg = { ...DEFAULT_CFG };
function loadCfg() {
  try {
    appCfg = { ...DEFAULT_CFG, ...JSON.parse(fs.readFileSync(cfgPath(), 'utf8')) };
  } catch {}
}
function saveCfg() {
  try {
    fs.writeFileSync(cfgPath(), JSON.stringify(appCfg, null, 2));
  } catch {}
}

function lanAddresses() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const ni of ifs[name] || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

/** Point the server + announcer at the current public URL / listing config. */
function reconcileAnnounce() {
  if (!server) return;
  const publicUrl = tunnel.url || (lanAddresses()[0] ? `http://${lanAddresses()[0]}:${PORT}` : '');
  server.setServerInfo({
    name: appCfg.name,
    description: appCfg.description,
    url: publicUrl,
    minClient: appCfg.minClient,
    latestClient: appCfg.latestClient,
  });
  const canAnnounce = appCfg.listPublicly && appCfg.name && appCfg.registryUrl && tunnel.url;
  if (canAnnounce) {
    try {
      server.startAnnouncing({ name: appCfg.name, description: appCfg.description, url: tunnel.url, registryUrl: appCfg.registryUrl });
    } catch (e) {
      console.error('announce failed:', e.message);
    }
  } else {
    server.stopAnnouncing();
  }
}

function snapshot() {
  const ann = server && server.getAnnouncer && server.getAnnouncer();
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
    listing: {
      ...appCfg,
      publicId: server && server.registryIdentity ? server.registryIdentity.publicId : null,
      announce: ann ? ann.snapshot() : null,
    },
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
      public: true,
      quiet: true,
      serverName: appCfg.name,
      serverDescription: appCfg.description,
      registryUrl: appCfg.registryUrl,
      minClient: appCfg.minClient,
      latestClient: appCfg.latestClient,
    });
    server.presence.onBroadcast(() => pushState());
    const ann = server.getAnnouncer && server.getAnnouncer();
    if (ann) ann.onUpdate(() => pushState());
    console.log(`[pqmsg-server] listening on :${PORT}  data=${dataDir()}`);
    reconcileAnnounce();
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
    height: 860,
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
    loadCfg();
    tunnel.on('update', () => {
      reconcileAnnounce();
      pushState();
    });
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
      reconcileAnnounce();
      return snapshot();
    });
    ipcMain.handle('set-listing', (_e, patch) => {
      appCfg = { ...appCfg, ...(patch || {}) };
      saveCfg();
      reconcileAnnounce();
      pushState();
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
