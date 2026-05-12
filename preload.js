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
