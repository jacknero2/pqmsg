'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('srv', {
  getState: () => ipcRenderer.invoke('get-state'),
  start: () => ipcRenderer.invoke('start'),
  stop: () => ipcRenderer.invoke('stop'),
  tunnelStart: () => ipcRenderer.invoke('tunnel-start'),
  tunnelStop: () => ipcRenderer.invoke('tunnel-stop'),
  setListing: (patch) => ipcRenderer.invoke('set-listing', patch),
  setSmtp: (patch) => ipcRenderer.invoke('set-smtp', patch),
  masterSetup: (password) => ipcRenderer.invoke('master-setup', { password }),
  masterLogin: (password) => ipcRenderer.invoke('master-login', { password }),
  masterVerify: (challengeId, code) => ipcRenderer.invoke('master-verify', { challengeId, code }),
  masterRegistry: (action, publicId) => ipcRenderer.invoke('master-registry', { action, publicId }),
  openDashboard: () => ipcRenderer.invoke('open-dashboard'),
  openData: () => ipcRenderer.invoke('open-data'),
  copy: (text) => ipcRenderer.invoke('copy', text),
  onState: (fn) => ipcRenderer.on('state', (_e, s) => fn(s)),
  onFatal: (fn) => ipcRenderer.on('fatal', (_e, m) => fn(m)),
});
