const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('collector', {
  state: () => ipcRenderer.invoke('collector:state'),
  settings: value => ipcRenderer.invoke('collector:settings', value),
  start: resume => ipcRenderer.invoke('collector:start', resume === true),
  stop: () => ipcRenderer.invoke('collector:stop'),
  selectFolder: () => ipcRenderer.invoke('collector:selectFolder'),
  openFolder: () => ipcRenderer.invoke('collector:openFolder'),
  showBrowser: () => ipcRenderer.invoke('collector:showBrowser'),
  onChange: callback => {
    const handler = (_event, value) => callback(value);
    ipcRenderer.on('collector:change', handler);
    return () => ipcRenderer.removeListener('collector:change', handler);
  }
});
