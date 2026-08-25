const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bridge', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  pair: (args) => ipcRenderer.invoke('pair', args),
  unpair: () => ipcRenderer.invoke('unpair'),
  printTest: (args) => ipcRenderer.invoke('print-test', args),
  onStatus: (cb) => ipcRenderer.on('status', (_e, s) => cb(s)),
});
