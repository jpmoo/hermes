const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('hermesElectron', {
  platform: process.platform,
  isElectron: true,
});
