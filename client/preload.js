'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('pqmsg', {
  snapshot: () => call('pqmsg:snapshot'),
  register: (a) => call('pqmsg:register', a),
  login: (a) => call('pqmsg:login', a),
  completeLogin: (a) => call('pqmsg:completeLogin', a),
  logout: () => call('pqmsg:logout'),
  startConversation: (username) => call('pqmsg:startConversation', { username }),
  startGroup: (name, members) => call('pqmsg:startGroup', { name, members }),
  addGroupMember: (convId, handle) => call('pqmsg:addGroupMember', { convId, handle }),
  removeGroupMember: (convId, handle) => call('pqmsg:removeGroupMember', { convId, handle }),
  acceptConversation: (convId) => call('pqmsg:acceptConversation', { convId }),
  declineConversation: (convId) => call('pqmsg:declineConversation', { convId }),
  sendMessage: (convId, text) => call('pqmsg:sendMessage', { convId, text }),
  getConversation: (convId) => call('pqmsg:getConversation', { convId }),
  syncNow: () => call('pqmsg:syncNow'),
  setSyncInterval: (ms) => call('pqmsg:setSyncInterval', { ms }),
  contact: (username) => call('pqmsg:contact', { username }),
  discoverServers: () => call('pqmsg:discoverServers'),
  pinServer: (name, url) => call('pqmsg:pinServer', { name, url }),
  unpinServer: (url) => call('pqmsg:unpinServer', { url }),
  openExternal: (url) => call('pqmsg:openExternal', { url }),
  onUpdate: (fn) => ipcRenderer.on('pqmsg:update', (_e, s) => fn(s)),
  onEvent: (fn) => ipcRenderer.on('pqmsg:event', (_e, ev) => fn(ev)),
});
