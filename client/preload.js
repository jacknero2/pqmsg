'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (ch, arg) => ipcRenderer.invoke(ch, arg);

contextBridge.exposeInMainWorld('pqmsg', {
  snapshot: () => call('pqmsg:snapshot'),
  register: (a) => call('pqmsg:register', a),
  login: (a) => call('pqmsg:login', a),
  completeLogin: (a) => call('pqmsg:completeLogin', a),
  logout: () => call('pqmsg:logout'),
  switchAccount: () => call('pqmsg:switchAccount'),
  startConversation: (username) => call('pqmsg:startConversation', { username }),
  startGroup: (name, members) => call('pqmsg:startGroup', { name, members }),
  addGroupMember: (convId, handle) => call('pqmsg:addGroupMember', { convId, handle }),
  removeGroupMember: (convId, handle) => call('pqmsg:removeGroupMember', { convId, handle }),
  acceptConversation: (convId) => call('pqmsg:acceptConversation', { convId }),
  declineConversation: (convId) => call('pqmsg:declineConversation', { convId }),
  sendMessage: (convId, text, opts) => call('pqmsg:sendMessage', { convId, text, opts }),
  editMessage: (convId, msgId, text) => call('pqmsg:editMessage', { convId, msgId, text }),
  reactToMessage: (convId, msgId, emoji) => call('pqmsg:reactToMessage', { convId, msgId, emoji }),
  getConversation: (convId) => call('pqmsg:getConversation', { convId }),
  syncNow: () => call('pqmsg:syncNow'),
  setSyncInterval: (ms) => call('pqmsg:setSyncInterval', { ms }),
  contact: (username) => call('pqmsg:contact', { username }),
  openExternal: (url) => call('pqmsg:openExternal', { url }),
  onUpdate: (fn) => ipcRenderer.on('pqmsg:update', (_e, s) => fn(s)),
  onEvent: (fn) => ipcRenderer.on('pqmsg:event', (_e, ev) => fn(ev)),
});
