const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('preview', Object.freeze({
  ready: () => ipcRenderer.send('preview:ready'),
  close: () => ipcRenderer.send('preview:escape'),
  onInit: callback => ipcRenderer.on('preview:init', (_event, value) => callback(value)),
  onState: callback => ipcRenderer.on('preview:state', (_event, value) => callback(value)),
}));
