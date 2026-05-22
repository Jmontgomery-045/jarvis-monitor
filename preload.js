const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  getState: () => ipcRenderer.invoke('state:get'),
  getUsage: () => ipcRenderer.invoke('usage:get'),
  onState: (cb) => ipcRenderer.on('state:full', (_, s) => cb(s)),
  onUsage: (cb) => ipcRenderer.on('usage:update', (_, u) => cb(u)),
  onHook: (cb) => ipcRenderer.on('hook:event', (_, e) => cb(e)),
  closeWindow: () => ipcRenderer.send('window:close'),
  minimizeWindow: () => ipcRenderer.send('window:minimize')
});

contextBridge.exposeInMainWorld('board', {
  load: () => ipcRenderer.invoke('data:load'),
  save: (data) => ipcRenderer.invoke('data:save', data),
  minimize: () => ipcRenderer.send('window:minimize'),
  close: () => ipcRenderer.send('window:close')
});

contextBridge.exposeInMainWorld('notes', {
  loadIndex: () => ipcRenderer.invoke('notes:loadIndex'),
  saveIndex: (data) => ipcRenderer.invoke('notes:saveIndex', data),
  read: (id) => ipcRenderer.invoke('notes:read', id),
  write: (id, body) => ipcRenderer.invoke('notes:write', id, body),
  delete: (id) => ipcRenderer.invoke('notes:delete', id),
});
