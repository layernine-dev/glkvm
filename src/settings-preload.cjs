const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('settings', {
  load: () => ipcRenderer.invoke('glkvm:settings-load'),
  save: (/** @type {unknown} */ value) => ipcRenderer.invoke('glkvm:settings-save', value),
  open: (/** @type {string} */ id) => ipcRenderer.invoke('glkvm:settings-open', id),
  recording: (/** @type {boolean} */ recording) => ipcRenderer.send('glkvm:settings-recording', recording === true),
  audio: () => ipcRenderer.invoke('glkvm:settings-audio'),
  onAudio: (/** @type {(value: unknown) => void} */ callback) => { ipcRenderer.on('glkvm:settings-audio', (_event, value) => callback(value)); },
});
