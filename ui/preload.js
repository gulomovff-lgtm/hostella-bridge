'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  getState: () => ipcRenderer.invoke('state'),
  pair: (code) => ipcRenderer.invoke('pair', code),
  unpair: () => ipcRenderer.invoke('unpair'),
  setCreds: (creds) => ipcRenderer.invoke('set-creds', creds),
  openPortal: () => ipcRenderer.invoke('open-portal'),
  testPortal: () => ipcRenderer.invoke('test-portal'),
  sweepNow: () => ipcRenderer.invoke('sweep-now'),
  setAutostart: (on) => ipcRenderer.invoke('set-autostart', on),
  openLogs: () => ipcRenderer.invoke('open-logs'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  quit: () => ipcRenderer.invoke('quit'),
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('state', h);
    return () => ipcRenderer.removeListener('state', h);
  },
});
