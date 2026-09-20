const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('settings', {
  load: () => ipcRenderer.invoke('glkvm:settings-load'),
  save: (/** @type {unknown} */ value) => ipcRenderer.invoke('glkvm:settings-save', value),
  open: (/** @type {string} */ id) => ipcRenderer.invoke('glkvm:settings-open', id),
});
